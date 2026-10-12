import { execFile, spawn } from 'node:child_process';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { RpcTransport, SandboxBackend, WorkerInput } from '../pi/types.ts';
import { sharedVerifiedCleanup } from './verified-cleanup.ts';

const execFileAsync = promisify(execFile);
export const PI_SOURCE_COMMIT = '4270522473e677ddba7b093caa0064a3df51d459';
export interface RootlessDockerOptions {
  dataRoot: string;
  gatewayDirectory: string;
  model: string;
  image?: string;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
}
export function assertRootless(info: unknown): void {
  const options = (info as { SecurityOptions?: unknown })?.SecurityOptions;
  if (!Array.isArray(options) || !options.some(value => typeof value === 'string' && /(^|[=,])rootless($|[,=])/.test(value))) {
    throw new Error('Real mode requires a verified rootless Docker daemon; host-shell fallback is forbidden');
  }
}
/** Docker rootless resource flags can be ignored without delegated cgroup v2. */
export function assertResourceControls(info: unknown): void {
  const value = info as Record<string, unknown> | null;
  if (!value || value.CgroupVersion !== '2' || value.CgroupDriver !== 'systemd' || value.MemoryLimit !== true || value.PidsLimit !== true || value.CpuCfsQuota !== true || value.SwapLimit !== true) {
    throw new Error('Launch requires rootless Docker with systemd cgroup v2 and reported memory, swap, PID and CPU quota controls; host setup must be completed by the operator');
  }
}
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(id)) throw new Error('Invalid sandbox identifier');
  return id;
}
function safeMountPath(path: string): string {
  if (!isAbsolute(path) || /[,\r\n\0]/.test(path)) throw new Error('Invalid mount path');
  return path;
}
export function buildDockerArgs(input: WorkerInput, options: RootlessDockerOptions): string[] {
  safeId(input.botId); safeId(input.taskId); safeId(input.runId);
  if (!options.model || /[\r\n\0]/.test(options.model)) throw new Error('A model ID is required');
  const image = options.image ?? `chestnut-pi:${PI_SOURCE_COMMIT.slice(0,12)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image)) throw new Error('Invalid image reference');
  const memory = options.memoryMb ?? 1024;
  const cpus = options.cpus ?? 1;
  const pids = options.pidsLimit ?? 128;
  if (!Number.isFinite(memory) || memory < 64 || memory > 16384 || !Number.isFinite(cpus) || cpus < 0.1 || cpus > 16 || !Number.isInteger(pids) || pids < 16 || pids > 1024) throw new Error('Invalid sandbox resource limits');
  return [
    'create', '--interactive', '--init', '--name', `chestnut-${input.runId}`,
    '--label', `chestnut.bot=${input.botId}`, '--label', `chestnut.task=${input.taskId}`, '--label', `chestnut.run=${input.runId}`,
    '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', String(pids), '--memory', `${memory}m`, '--memory-swap', `${memory}m`, '--cpus', String(cpus),
    '--user', '0:0', '--workdir', '/workspace',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--mount', `type=bind,source=${safeMountPath(input.workspace)},target=/workspace`,
    '--mount', `type=bind,source=${safeMountPath(dirname(input.sessionPath))},target=/session`,
    '--mount', `type=bind,source=${safeMountPath(options.gatewayDirectory)},target=/run/chestnut,readonly`,
    '--env', 'HOME=/tmp/home', '--env', 'PI_CODING_AGENT_DIR=/tmp/pi-agent',
    '--env', 'PI_OFFLINE=1', '--env', 'PI_NO_UPDATE_CHECK=1',
    '--env', `CHESTNUT_MODEL=${options.model}`,
    image, `/session/${basename(input.sessionPath)}`,
  ];
}
async function verifyDirectory(path: string, expected: string): Promise<void> {
  if (resolve(path) !== resolve(expected)) throw new Error(`Unexpected sandbox path: ${path}`);
  // Check every component: reject symlink mounts and traversal into another bot.
  const absolute = resolve(path);
  let cursor: string = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Sandbox mount paths must not contain symlinks');
  }
  if (!(await lstat(absolute)).isDirectory()) throw new Error('Sandbox mount must be a directory');
  if (await realpath(absolute) !== absolute) throw new Error('Sandbox mount is not canonical');
}
export async function cleanupStaleContainer(input: { runId: string; botId: string; taskId: string }): Promise<void> {
  safeId(input.runId); safeId(input.botId); safeId(input.taskId);
  const { stdout: info } = await execFileAsync('docker', ['info', '--format', '{{json .}}'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  assertRootless(JSON.parse(info));
  const name = `chestnut-${input.runId}`;
  const list = async (): Promise<string> => (await execFileAsync('docker', ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], { timeout: 10_000 })).stdout.trim();
  if (!(await list())) return; // Successful daemon query authoritatively confirms absence.
  const { stdout: raw } = await execFileAsync('docker', ['container', 'inspect', name, '--format', '{{json .Config.Labels}}'], { timeout: 10_000 });
  const labels = JSON.parse(raw) as Record<string,string>;
  if (labels['chestnut.bot'] !== input.botId || labels['chestnut.task'] !== input.taskId || labels['chestnut.run'] !== input.runId) throw new Error('Refusing to remove a container whose ownership labels do not match');
  await execFileAsync('docker', ['container', 'rm', '--force', name], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (await list()) throw new Error('Container still exists after removal; keep bot quarantined');
}
/** Only fixed Docker operations execute on the host; all agent tools run inside it. */
export class RootlessDockerBackend implements SandboxBackend {
  private readonly options: RootlessDockerOptions;
  constructor(options: RootlessDockerOptions) { this.options = options; }
  async launch(input: WorkerInput): Promise<RpcTransport> {
    const root = await realpath(this.options.dataRoot);
    safeId(input.botId); safeId(input.taskId); safeId(input.runId);
    await verifyDirectory(input.workspace, join(root, 'bots', input.botId, 'workspace'));
    await verifyDirectory(dirname(input.sessionPath), join(root, 'sessions', input.taskId));
    if (basename(input.sessionPath) !== 'session.jsonl') throw new Error('Unexpected Pi session filename');
    try {
      if ((await lstat(input.sessionPath)).isSymbolicLink()) throw new Error('Pi session must not be a symlink');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await verifyDirectory(this.options.gatewayDirectory, this.options.gatewayDirectory);
    const gatewayEntries = await readdir(this.options.gatewayDirectory);
    if (gatewayEntries.length !== 1 || gatewayEntries[0] !== 'model.sock') throw new Error('Gateway mount must contain only its model socket, never configuration or credentials');
    const socket = await lstat(join(this.options.gatewayDirectory, 'model.sock'));
    if (!socket.isSocket()) throw new Error('Trusted model gateway is not listening');
    const workspaceRelative = relative(input.workspace, this.options.gatewayDirectory);
    if (!workspaceRelative.startsWith('..') && !isAbsolute(workspaceRelative)) throw new Error('Gateway cannot live inside the sandbox workspace');
    let info: string;
    try { ({ stdout: info } = await execFileAsync('docker', ['info', '--format', '{{json .}}'], { timeout: 10_000, maxBuffer: 1024 * 1024 })); }
    catch { throw new Error('Rootless Docker unavailable; real mode is disabled, with no host-shell fallback'); }
    const daemonInfo = JSON.parse(info);
    assertRootless(daemonInfo); assertResourceControls(daemonInfo);
    const image = this.options.image ?? `chestnut-pi:${PI_SOURCE_COMMIT.slice(0,12)}`;
    const { stdout: imageCommit } = await execFileAsync('docker', ['image', 'inspect', image, '--format', '{{index .Config.Labels "org.chestnut.pi.commit"}}'], { timeout: 10_000 });
    if (imageCommit.trim() !== PI_SOURCE_COMMIT) throw new Error('Pi image provenance does not match the pinned source');
    // Creation and start are separate. A late create after recovery can only
    // leave a stopped container, never a running agent.
    await execFileAsync('docker', buildDockerArgs(input, this.options), { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const child = spawn('docker', ['start', '--attach', '--interactive', `chestnut-${input.runId}`], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let markReaped: () => void = () => {};
    const reaped = new Promise<void>(resolveReaped => { markReaped = resolveReaped; });
    let lineListener: (line: string) => void = () => {};
    let closeListener: (error?: Error) => void = () => {};
    let buffer = '';
    let stderr = '';
    let stopped = false;
    let closeError: Error | undefined;
    let isClosed = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) { closeListener(new Error('Pi output frame exceeded limit')); void stop().catch(() => {}); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,index); buffer = buffer.slice(index + 1);
        if (line.trim()) lineListener(line);
      }
    });
    child.on('error', error => { isClosed = true; closeError = error; markReaped(); closeListener(error); });
    child.on('close', (code, signal) => {
      isClosed = true; markReaped();
      closeError = new Error(`Pi container exited (${code ?? signal ?? 'unknown'}): ${stderr}`);
      closeListener(closeError);
    });
    const verifyStop = sharedVerifiedCleanup(async (): Promise<void> => {
      // Reap the attach client before confirming container death. Its exit
      // alone is insufficient, so the daemon is then queried and cleaned.
      child.kill('SIGKILL');
      await reaped;
      try { await cleanupStaleContainer(input); }
      catch (error) { child.kill('SIGKILL'); throw new Error(`Could not confirm container removal; keep bot quarantined: ${String(error)}`); }
      child.kill('SIGTERM');
    });
    const stop = (): Promise<void> => {
      stopped = true; // Ingress closes immediately, including after cleanup failure.
      return verifyStop(); // Concurrent callers await the same verified outcome.
    };
    return {
      write: line => new Promise<void>((resolveWrite, reject) => {
        if (isClosed || stopped) { reject(closeError ?? new Error('Pi transport closed')); return; }
        child.stdin.write(line, error => error ? reject(error) : resolveWrite());
      }),
      onLine: listener => { lineListener = listener; },
      onClose: listener => { closeListener = listener; if (isClosed) listener(closeError); },
      stop,
    };
  }
}
