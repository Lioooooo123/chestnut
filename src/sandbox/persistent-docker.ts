import { execFile, spawn } from 'node:child_process';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { assertResourceControls, assertRootless, PI_SOURCE_COMMIT } from './rootless-docker.ts';
import { sharedVerifiedCleanup } from './verified-cleanup.ts';
import type { RpcTransport, SandboxBackend, WorkerInput } from '../pi/types.ts';

export type PersistentNetworkPolicy = 'none' | 'maintenance';
export interface PersistentEnvironmentState { containerId: string; imageId: string; state: 'running' | 'stopped' }
export interface DockerAttachment {
  write(line: string): Promise<void>;
  onLine(listener: (line: string) => void): void;
  onClose(listener: (error?: Error) => void): void;
  terminate(): Promise<void>;
}
/** Only these trusted host Docker operations are injectable; guest output is not a lifecycle certificate. */
export interface DockerCommandRunner {
  command(args: string[], timeoutMs?: number): Promise<string>;
  attach(args: string[]): DockerAttachment;
}
export interface PersistentCleanupOptions {
  dataRoot: string;
  gatewayDirectory: string;
  image?: string;
  expectedContainerId?: string | null;
  expectedImageId?: string | null;
  /** Mandatory fencing hook. False/missing forbids every lifecycle mutation. */
  canMutate: () => boolean;
  onEnvironment?: (state: PersistentEnvironmentState) => void;
}
export interface PersistentFileSystem {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isSocket(): boolean; isDirectory(): boolean }>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
}
const nativeFileSystem: PersistentFileSystem = { lstat, realpath, readdir };
export interface PersistentDockerOptions extends PersistentCleanupOptions {
  /** Admission is stricter than cleanup: cancellation forbids create/start/exec. */
  canStart: () => boolean;
  gatewaySocketName: string;
  model: string;
  apiProtocol?: 'chat-completions'|'responses';
  networkPolicy?: PersistentNetworkPolicy;
  runner?: DockerCommandRunner;
  /** Explicit unit-test dependency seam. Production defaults to native filesystem checks. */
  fileSystem?: PersistentFileSystem;
}
const exec = promisify(execFile);
export class HostDockerCommandRunner implements DockerCommandRunner {
  async command(args: string[], timeoutMs = 15_000): Promise<string> {
    return (await exec('docker', args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 })).stdout;
  }
  attach(args: string[]): DockerAttachment {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let onLine: (line: string) => void = () => {};
    let onClose: (error?: Error) => void = () => {};
    let buffer = '', stderr = '';
    let closed = false, failure: Error | undefined;
    let markReaped: () => void = () => {};
    const reaped = new Promise<void>(resolveReaped => { markReaped = resolveReaped; });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) { failure = new Error('Persistent Pi output frame exceeded limit'); onClose(failure); child.kill('SIGKILL'); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0,index); buffer = buffer.slice(index + 1);
        if (line.trim()) onLine(line);
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.on('error', error => { closed = true; failure = error; markReaped(); onClose(error); });
    child.on('close', (code, signal) => { closed = true; markReaped(); failure ??= new Error(`Persistent Pi exec exited (${code ?? signal}): ${stderr}`); onClose(failure); });
    return {
      write: line => new Promise<void>((resolveWrite,reject) => { if (closed) reject(failure); else child.stdin.write(line,error => error ? reject(error) : resolveWrite()); }),
      onLine: listener => { onLine = listener; },
      onClose: listener => { onClose = listener; if (closed) listener(failure); },
      terminate: async () => { child.kill('SIGKILL'); await reaped; },
    };
  }
}
interface ContainerInspection {
  Id: string; Image: string;
  State: { Running: boolean; Paused?: boolean; Restarting?: boolean };
  Config: { Image: string; User: string; Labels: Record<string,string>; Entrypoint: string[]; Cmd: string[]; Env?: string[] };
  HostConfig: { NetworkMode: string; Privileged: boolean; ReadonlyRootfs: boolean; CapDrop?: string[]; CapAdd?: string[]; SecurityOpt?: string[]; Devices?: unknown[]; DeviceRequests?: unknown[]; PidMode?: string; IpcMode?: string; UTSMode?: string; UsernsMode?: string; CgroupnsMode?: string; Binds?: string[]; ExtraHosts?: string[]; PortBindings?: Record<string,unknown>; PublishAllPorts?: boolean; AutoRemove?: boolean; RestartPolicy?: {Name:string}; Mounts?: unknown[]; VolumesFrom?: string[]; Memory?: number; MemorySwap?: number; PidsLimit?: number; NanoCpus?: number; Init?: boolean };
  Mounts: Array<{Type:string;Source:string;Destination:string;RW:boolean;Propagation?:string}>;
}
const imageName = (options: PersistentCleanupOptions): string => options.image ?? `chestnut-pi:${PI_SOURCE_COMMIT.slice(0,12)}`;
function identifier(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(value)) throw new Error('Invalid persistent sandbox identifier');
  return value;
}
function fence(options: PersistentCleanupOptions): void {
  if (typeof options.canMutate !== 'function' || !options.canMutate()) throw new Error('Persistent environment owner is stale; lifecycle mutation denied');
}
function startFence(options: PersistentDockerOptions): void {
  fence(options);
  if (typeof options.canStart !== 'function' || !options.canStart()) throw new Error('Persistent task admission closed; launch cancelled');
}
const containerName = (botId: string): string => `chestnut-bot-${identifier(botId)}`;
function mountPath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || /[,\r\n\0]/.test(path)) throw new Error('Invalid persistent mount path');
  return path;
}
async function canonicalDirectory(path: string, fs: PersistentFileSystem): Promise<void> {
  mountPath(path);
  let cursor: string = sep;
  for (const part of path.split(sep).filter(Boolean)) { cursor = join(cursor,part); if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Persistent mount paths cannot contain symlinks'); }
  if (!(await fs.lstat(path)).isDirectory() || await fs.realpath(path) !== path) throw new Error('Persistent mount is not a canonical directory');
}
export function persistentCreateArgs(botId: string, options: PersistentDockerOptions): string[] {
  if ((options.networkPolicy ?? 'none') !== 'none') throw new Error('Maintenance networking/package installation is pending policy validation; only network none is supported');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(imageName(options))) throw new Error('Invalid persistent image');
  const workspace = mountPath(join(resolve(options.dataRoot),'bots',identifier(botId),'workspace'));
  return ['create', '--name', containerName(botId), '--init', '--network', 'none',
    '--label', `chestnut.bot=${botId}`, '--label', 'chestnut.profile=persistent', '--label', 'chestnut.schema=1',
    '--ipc','private','--cgroupns','private','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','128','--memory','1024m','--memory-swap','1024m','--cpus','1',
    '--user','0:0','--workdir','/workspace',
    '--mount',`type=bind,source=${workspace},target=/workspace`,
    '--mount',`type=bind,source=${mountPath(options.gatewayDirectory)},target=/run/chestnut,readonly`,
    '--entrypoint','node',imageName(options),'/opt/chestnut/persistent-supervisor.mjs'];
}
async function inspectBot(botId: string, runner: DockerCommandRunner): Promise<ContainerInspection | undefined> {
  const name = containerName(botId);
  const ids = (await runner.command(['container','ls','--all','--filter',`name=^/${name}$`,'--format','{{.ID}}'])).trim();
  if (!ids) return undefined;
  const value: unknown = JSON.parse(await runner.command(['container','inspect',name]));
  if (!Array.isArray(value) || value.length !== 1) throw new Error('Invalid trusted Docker container inspection');
  return value[0] as ContainerInspection;
}
async function trustedImageId(options: PersistentCleanupOptions, runner: DockerCommandRunner, requireResources = false): Promise<string> {
  const info = JSON.parse(await runner.command(['info','--format','{{json .}}'])); assertRootless(info);
  if (requireResources) assertResourceControls(info);
  const value: unknown = JSON.parse(await runner.command(['image','inspect',imageName(options)]));
  if (!Array.isArray(value) || value.length !== 1 || value[0]?.Config?.Labels?.['org.chestnut.pi.commit'] !== PI_SOURCE_COMMIT || value[0]?.Config?.Labels?.['org.chestnut.persistent.profile'] !== 'experimental-v1' || typeof value[0]?.Id !== 'string') throw new Error('Persistent image does not match pinned Pi source and experimental-v1 profile; rebuild the image');
  if (options.expectedImageId && value[0].Id !== options.expectedImageId) throw new Error('Persistent base image identity changed; automatic rootfs migration is forbidden');
  return value[0].Id;
}
/** Check saved container configuration every time; a matching name/label is insufficient. */
export function verifyPersistentInspection(value: ContainerInspection, botId: string, options: PersistentCleanupOptions, expectedImageId: string): void {
  const h = value.HostConfig, c = value.Config;
  if (options.expectedContainerId && value.Id !== options.expectedContainerId) throw new Error('Persistent container identity changed; previous writable rootfs is not confirmed');
  if (options.expectedImageId && value.Image !== options.expectedImageId) throw new Error('Persistent base image identity mismatch');
  if (!value.Id || value.Image !== expectedImageId || c?.Image !== imageName(options) || c.User !== '0:0' || c.Labels?.['chestnut.bot'] !== botId || c.Labels?.['chestnut.profile'] !== 'persistent' || c.Labels?.['chestnut.schema'] !== '1') throw new Error('Persistent bot identity/image configuration mismatch');
  if (JSON.stringify(c.Entrypoint) !== JSON.stringify(['node']) || JSON.stringify(c.Cmd) !== JSON.stringify(['/opt/chestnut/persistent-supervisor.mjs'])) throw new Error('Persistent container startup command mismatch');
  if (!h || h.NetworkMode !== 'none' || h.Privileged || h.ReadonlyRootfs || h.AutoRemove || h.PublishAllPorts || h.Init !== true || h.CapAdd?.length || !h.CapDrop?.some(cap => cap.toUpperCase() === 'ALL') || !h.SecurityOpt?.includes('no-new-privileges')) throw new Error('Unsafe persistent container security configuration');
  if (h.SecurityOpt.some(option => option !== 'no-new-privileges') || h.Devices?.length || h.DeviceRequests?.length || h.ExtraHosts?.length || h.VolumesFrom?.length || h.Binds?.length || Object.keys(h.PortBindings ?? {}).length || (h.PidMode && h.PidMode !== '') || h.IpcMode !== 'private' || h.CgroupnsMode !== 'private' || (h.UTSMode && h.UTSMode !== '') || (h.UsernsMode && h.UsernsMode !== '') || (h.RestartPolicy?.Name && h.RestartPolicy.Name !== 'no')) throw new Error('Persistent container has unauthorized host/network/device access');
  if (h.Memory !== 1024*1024*1024 || h.MemorySwap !== 1024*1024*1024 || h.PidsLimit !== 128 || h.NanoCpus !== 1_000_000_000) throw new Error('Persistent container resource limits differ from policy');
  const expected = [{Type:'bind',Source:join(resolve(options.dataRoot),'bots',botId,'workspace'),Destination:'/workspace',RW:true},{Type:'bind',Source:options.gatewayDirectory,Destination:'/run/chestnut',RW:false}];
  if (!Array.isArray(value.Mounts) || value.Mounts.length !== expected.length || expected.some(mount => !value.Mounts.some(actual => actual.Type===mount.Type && actual.Source===mount.Source && actual.Destination===mount.Destination && actual.RW===mount.RW && (!actual.Propagation || actual.Propagation==='rprivate')))) throw new Error('Persistent container mounts differ from the exact bot/gateway allowlist');
  const allowedEnvironment = new Set(['PATH','NODE_VERSION','YARN_VERSION','HOME','PI_CODING_AGENT_DIR','PI_OFFLINE','PI_NO_UPDATE_CHECK']);
  if (c.Env?.some(env => !allowedEnvironment.has(env.split('=',1)[0]))) throw new Error('Unapproved environment variables found in persistent container configuration');
}
function observed(value: ContainerInspection): PersistentEnvironmentState { return { containerId:value.Id,imageId:value.Image,state:value.State.Running?'running':'stopped' }; }
/** Stop the complete bot; never delete its writable rootfs. Missing/stale guard fails closed. */
export async function cleanupPersistentBot(input: {botId:string}, options: PersistentCleanupOptions, runner: DockerCommandRunner = new HostDockerCommandRunner()): Promise<void> {
  fence(options);
  const expectedImage = await trustedImageId(options,runner); fence(options);
  let current = await inspectBot(input.botId,runner); fence(options);
  if (!current) { if (options.expectedContainerId) throw new Error('Previously provisioned persistent container is missing; writable rootfs may be lost'); return; }
  verifyPersistentInspection(current,input.botId,options,expectedImage);
  fence(options);
  if (current.State.Running || current.State.Paused || current.State.Restarting) await runner.command(['container','stop','--time','2',containerName(input.botId)],20_000);
  current = await inspectBot(input.botId,runner); fence(options);
  if (!current) throw new Error('Persistent container disappeared during stop; filesystem preservation unverified');
  verifyPersistentInspection(current,input.botId,options,expectedImage);
  if (current.State.Running || current.State.Paused || current.State.Restarting) throw new Error('Could not confirm whole-bot stop; retain quarantine');
  options.onEnvironment?.(observed(current));
}
/** Experimental writable-root profile. Every task ends with trusted whole-bot stop. */
export class PersistentDockerBackend implements SandboxBackend {
  private readonly options: PersistentDockerOptions;
  private readonly runner: DockerCommandRunner;
  constructor(options: PersistentDockerOptions) { this.options={...options};this.runner=options.runner ?? new HostDockerCommandRunner(); }
  async launch(input: WorkerInput): Promise<RpcTransport> {
    try { return await this.launchOwned(input); }
    catch (error) {
      try { await cleanupPersistentBot(input,this.options,this.runner); }
      catch (cleanupError) { throw new Error(`Persistent launch failed; cleanup unverified, retain quarantine: ${String(error)}; ${String(cleanupError)}`); }
      throw error;
    }
  }
  private async launchOwned(input: WorkerInput): Promise<RpcTransport> {
    const o=this.options; const fs=o.fileSystem ?? nativeFileSystem; startFence(o); identifier(input.botId);identifier(input.taskId);identifier(input.runId);
    if (o.gatewaySocketName !== `${input.runId}.sock`) throw new Error('Persistent gateway socket must be scoped to the current run');
    if (!o.model || /[\r\n\0]/.test(o.model)) throw new Error('Invalid persistent model');
    const args=persistentCreateArgs(input.botId,o);
    const root=await fs.realpath(o.dataRoot);startFence(o);
    if (root!==resolve(o.dataRoot) || input.workspace!==join(root,'bots',input.botId,'workspace') || input.sessionPath!==join(root,'sessions',input.taskId,'session.jsonl')) throw new Error('Unexpected persistent worker workspace/session path');
    await canonicalDirectory(input.workspace,fs);await canonicalDirectory(o.gatewayDirectory,fs);startFence(o);
    if (o.gatewayDirectory===input.workspace || o.gatewayDirectory.startsWith(input.workspace+sep) || input.workspace.startsWith(o.gatewayDirectory+sep)) throw new Error('Persistent gateway and workspace mounts must be separate');
    for (const entry of await fs.readdir(o.gatewayDirectory)) {
      if (![o.gatewaySocketName, `${input.runId}.memory.sock`].includes(entry) || !(await fs.lstat(join(o.gatewayDirectory,entry))).isSocket()) throw new Error('Persistent gateway mount may contain only per-run model sockets and the current-run memory socket');
    }
    if (!(await fs.lstat(join(o.gatewayDirectory,o.gatewaySocketName))).isSocket()) throw new Error('Current run model socket is not ready');
    const expectedImage=await trustedImageId(o,this.runner,true);startFence(o);
    let current=await inspectBot(input.botId,this.runner);startFence(o);
    if (!current) {
      if (o.expectedContainerId) throw new Error('Previously provisioned persistent container is missing; refusing to replace its writable rootfs');
      startFence(o);await this.runner.command(args,30_000);startFence(o);
      current=await inspectBot(input.botId,this.runner);startFence(o);
      if (!current) throw new Error('Created persistent container not found');
    }
    verifyPersistentInspection(current,input.botId,o,expectedImage);
    o.expectedContainerId ??= current.Id; o.expectedImageId ??= current.Image;
    // Every previous task must have stopped the whole bot before a new grant.
    if (current.State.Running || current.State.Paused || current.State.Restarting) throw new Error('Persistent bot is already running; recovery must stop it before a new task');
    o.onEnvironment?.(observed(current));startFence(o);
    await this.runner.command(['container','start',containerName(input.botId)]);startFence(o);
    current=await inspectBot(input.botId,this.runner);startFence(o);
    if (!current) throw new Error('Persistent bot disappeared after start');
    verifyPersistentInspection(current,input.botId,o,expectedImage);
    if (!current.State.Running || current.State.Paused || current.State.Restarting) throw new Error('Persistent bot failed to enter running state');
    o.onEnvironment?.(observed(current));startFence(o);
    let attachment: DockerAttachment;
    try {
      startFence(o);attachment=this.runner.attach(['exec','--interactive','--workdir','/workspace',
        '--env',`CHESTNUT_MODEL=${o.model}`,'--env',`CHESTNUT_MODEL_PROTOCOL=${o.apiProtocol??'chat-completions'}`,'--env',`CHESTNUT_MODEL_SOCKET=${o.gatewaySocketName}`,
        '--env',`CHESTNUT_TASK_ID=${input.taskId}`,'--env',`CHESTNUT_RUN_ID=${input.runId}`,
        '--env','PI_OFFLINE=1','--env','PI_NO_UPDATE_CHECK=1',containerName(input.botId),
        'node','/opt/chestnut/persistent-task-entry.mjs']);
    } catch(error) { await cleanupPersistentBot(input,o,this.runner);throw error; }
    let ingressClosed=false;
    const verifyStop=sharedVerifiedCleanup(async()=>{
      let attachError: unknown;
      try { await attachment.terminate(); } catch(error) { attachError=error; }
      await cleanupPersistentBot(input,o,this.runner);
      if (attachError) throw new Error(`Could not reap trusted exec client; keep quarantine: ${String(attachError)}`);
    });
    return {
      write: async line=>{if(ingressClosed)throw new Error('Persistent task transport closed');fence(o);await attachment.write(line);},
      onLine:listener=>attachment.onLine(listener),onClose:listener=>attachment.onClose(listener),
      stop:()=>{ingressClosed=true;return verifyStop();},
    };
  }
}
