import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { DockerCommandRunner } from '../sandbox/persistent-docker.ts';
import { assertResourceControls, assertRootless, PI_SOURCE_COMMIT } from '../sandbox/rootless-docker.ts';
import { ENVIRONMENT_CAPABILITIES, stableName, verifyStableInspection } from './stable-docker.ts';
import { PACKAGE_NAME } from './package-policy.ts';

export const PACKAGE_LIMITS = Object.freeze({ requests: 16, artifacts: 64, bytes: 128 * 1024 * 1024, manifestBytes: 64 * 1024 });
const DEB_NAME = /^([a-z0-9][a-z0-9+.-]{1,63})_([A-Za-z0-9.+:~%\-]{1,160})_(amd64|arm64|all)\.deb$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SOURCE = 'https://deb.debian.org/debian';
const SECURITY_SOURCE = 'https://deb.debian.org/debian-security';
export const DEBIAN_PACKAGE_POLICY = Object.freeze({ suite: 'bookworm', component: 'main', source: SOURCE, securitySource: SECURITY_SOURCE, keyring: '/usr/share/keyrings/debian-archive-keyring.gpg' });

export interface GovernedPackageOptions {
  botId: string; runId: string; requestId: string; dataRoot: string; image: string;
  expectedContainerId: string; expectedImageId: string;
  /** Supplied only by host/operator policy. Includes every downloaded dependency. */
  allowedPackages: readonly string[];
  requestedPackages: readonly string[];
  /** The same current OS-lock/run grant used by the stable environment. */
  canMutate: () => boolean; canExecute: () => boolean;
  /** Synchronously persist a pending-operation marker before any stable guest mutation. */
  onBeforeImport?: () => void;
  onQuarantine?: (reason: string) => void;
}
export interface PackageArtifact { name: string; package: string; version: string; architecture: string; size: number; sha256: string }
export interface PackageManifest { schema: 1; suite: 'bookworm'; architecture: 'amd64' | 'arm64'; requested: string[]; artifacts: PackageArtifact[]; totalBytes: number }
export interface PackageInstallResult { requestedPackages: string[]; artifacts: PackageArtifact[]; totalBytes: number; installation: 'completed'; network: 'none' }
export class PackageInstallQuarantineError extends Error { readonly quarantine = true; }

function identity(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(value)) throw new Error('Invalid package operation identity');
  return value;
}
export function validatePackageRequest(requested: readonly string[], allowed: readonly string[]): string[] {
  if (!Array.isArray(allowed) || allowed.length === 0 || allowed.length > 256 || allowed.some(value => typeof value !== 'string' || !PACKAGE_NAME.test(value)) || new Set(allowed).size !== allowed.length) throw new Error('An explicit operator package allowlist is required');
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > PACKAGE_LIMITS.requests || requested.some(value => typeof value !== 'string' || !PACKAGE_NAME.test(value)) || new Set(requested).size !== requested.length) throw new Error('Package request must contain 1-16 distinct Debian package names');
  if (requested.some(value => !allowed.includes(value))) throw new Error('Package is not in the operator allowlist');
  return [...requested].sort();
}
function plainKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === keys.sort().join('\0');
}
export function validatePackageManifest(value: unknown, requested: readonly string[], allowed: readonly string[], architecture: string): PackageManifest {
  if (!plainKeys(value, ['schema', 'suite', 'architecture', 'requested', 'artifacts', 'totalBytes']) || value.schema !== 1 || value.suite !== 'bookworm' || value.architecture !== architecture || !['amd64', 'arm64'].includes(architecture) || JSON.stringify(value.requested) !== JSON.stringify(requested)) throw new Error('Invalid package manifest identity');
  if (!Array.isArray(value.artifacts) || !value.artifacts.length || value.artifacts.length > PACKAGE_LIMITS.artifacts) throw new Error('Package artifact count exceeds policy');
  const names = new Set<string>(), packages = new Set<string>();
  let bytes = 0;
  for (const artifact of value.artifacts) {
    if (!plainKeys(artifact, ['name', 'package', 'version', 'architecture', 'size', 'sha256']) || typeof artifact.name !== 'string' || typeof artifact.package !== 'string' || typeof artifact.version !== 'string' || typeof artifact.architecture !== 'string' || typeof artifact.sha256 !== 'string') throw new Error('Invalid package artifact');
    const match = DEB_NAME.exec(artifact.name);
    if (!match || match[1] !== artifact.package || decodeURIComponent(match[2]) !== artifact.version || match[3] !== artifact.architecture || !/^(?:[0-9]+:)?[0-9][A-Za-z0-9.+:~\-]*$/.test(artifact.version) || ![architecture, 'all'].includes(artifact.architecture) || !allowed.includes(artifact.package) || names.has(artifact.name) || packages.has(artifact.package) || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || (artifact.size as number) <= 0) throw new Error('Package artifact is outside operator policy');
    bytes += artifact.size as number;
    if (bytes > PACKAGE_LIMITS.bytes) throw new Error('Package byte budget exceeded');
    names.add(artifact.name); packages.add(artifact.package);
  }
  if (bytes !== value.totalBytes || requested.some(name => !packages.has(name))) throw new Error('Package manifest does not cover the requested packages');
  return value as unknown as PackageManifest;
}
async function canonicalDirectory(path: string, privateOwned = false): Promise<void> {
  if (resolve(path) !== path || /[,\r\n\0]/.test(path)) throw new Error('Invalid package staging path');
  let cursor: string = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Package staging path cannot contain symlinks');
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || await realpath(path) !== path || (privateOwned && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) throw new Error('Package staging must be canonical, private and host-owned');
}
/** Read through a pinned, non-symlink inode. Never parse or execute a .deb on the host. */
async function verifiedFile(path: string, maxBytes: number): Promise<Buffer> {
  await canonicalDirectory(dirname(path), true);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maxBytes || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe or oversized staged package file');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Staged package file changed during verification');
    return bytes;
  } finally { await handle.close(); }
}

export interface PackageDownloaderOwner { botId: string; runId: string }
export function packageDownloaderCreateArgs(name: string, imageId: string, architecture: string, requested: readonly string[], allowed: readonly string[], owner?: PackageDownloaderOwner): string[] {
  identity(name);
  if (!DIGEST.test(imageId) || !['amd64', 'arm64'].includes(architecture)) throw new Error('Downloader requires an immutable supported Linux image');
  validatePackageRequest(requested, allowed);
  if (owner) { identity(owner.botId); identity(owner.runId); }
  return ['create', '--name', name, '--init', '--network', 'bridge', '--ipc', 'private', '--cgroupns', 'private',
    '--label', 'chestnut.profile=package-downloader-v1', '--label', `chestnut.package-operation=${name}`,
    ...(owner ? ['--label', `chestnut.package-bot=${owner.botId}`, '--label', `chestnut.package-run=${owner.runId}`] : []),
    '--cap-drop', 'ALL', ...ENVIRONMENT_CAPABILITIES.flatMap(cap => ['--cap-add', cap]), '--security-opt', 'no-new-privileges',
    '--pids-limit', '128', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--user', '0:0', '--workdir', '/',
    '--entrypoint', '/usr/bin/env', imageId, '-i', 'PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/tmp', 'LANG=C', 'LC_ALL=C',
    '/usr/local/bin/node', '-e', PACKAGE_DOWNLOAD_SCRIPT, JSON.stringify({ architecture, requested, allowed, limits: PACKAGE_LIMITS })];
}
export function verifyDownloaderInspection(c: any, name: string, imageId: string, args: string[]): void {
  const h = c?.HostConfig, config = c?.Config;
  const imageOffset = args.indexOf(imageId);
  for (let i = 0; i < imageOffset; i++) if (args[i] === '--label') {
    const label = args[++i], split = label.indexOf('=');
    if (config?.Labels?.[label.slice(0, split)] !== label.slice(split + 1)) throw new Error('Downloader owner label mismatch');
  }
  if (!c?.Id || c.Image !== imageId || config?.Image !== imageId || config.User !== '0:0' || config.WorkingDir !== '/' || config.Labels?.['chestnut.profile'] !== 'package-downloader-v1' || config.Labels?.['chestnut.package-operation'] !== name || JSON.stringify(config.Entrypoint) !== JSON.stringify(['/usr/bin/env']) || JSON.stringify(config.Cmd) !== JSON.stringify(args.slice(imageOffset + 1))) throw new Error('Downloader identity mismatch');
  if (!h || h.NetworkMode !== 'bridge' || h.Privileged || h.ReadonlyRootfs || h.AutoRemove || h.PublishAllPorts || h.Init !== true || JSON.stringify([...(h.CapDrop ?? [])].map((v: string) => v.toUpperCase()).sort()) !== JSON.stringify(['ALL']) || JSON.stringify([...(h.CapAdd ?? [])].map((v: string) => v.toUpperCase()).sort()) !== JSON.stringify([...ENVIRONMENT_CAPABILITIES].sort()) || JSON.stringify(h.SecurityOpt) !== JSON.stringify(['no-new-privileges'])) throw new Error('Downloader isolation mismatch');
  if (!Array.isArray(c.Mounts) || c.Mounts.length || h.Mounts?.length || h.Binds?.length || h.VolumesFrom?.length || h.Devices?.length || h.DeviceRequests?.length || h.ExtraHosts?.length || Object.keys(h.PortBindings ?? {}).length || Object.keys(h.Tmpfs ?? {}).length || (h.PidMode && h.PidMode !== '') || h.IpcMode !== 'private' || h.CgroupnsMode !== 'private' || (h.UTSMode && h.UTSMode !== '') || (h.UsernsMode && h.UsernsMode !== '') || (h.RestartPolicy?.Name && h.RestartPolicy.Name !== 'no')) throw new Error('Downloader must have no mounts, secrets or host access');
  if (h.Memory !== 512 * 1024 * 1024 || h.MemorySwap !== h.Memory || h.PidsLimit !== 128 || h.NanoCpus !== 1_000_000_000) throw new Error('Downloader resource controls mismatch');
  const keys = new Set(['PATH', 'NODE_VERSION', 'YARN_VERSION', 'HOME', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_NO_UPDATE_CHECK']);
  if (!Array.isArray(config.Env) || config.Env.some((value: string) => !keys.has(value.split('=', 1)[0]))) throw new Error('Downloader image contains an unapproved environment variable');
  const networks = Object.keys(c.NetworkSettings?.Networks ?? {});
  if (networks.some(network => network !== 'bridge')) throw new Error('Downloader has an unexpected network attachment');
}

/** Caller must serialize this with every other stable-environment operation and retain quarantine on failure. */
export async function installGovernedPackages(o: GovernedPackageOptions, runner: DockerCommandRunner): Promise<PackageInstallResult> {
  identity(o.botId); identity(o.runId); identity(o.requestId); identity(o.expectedContainerId);
  const requested = validatePackageRequest(o.requestedPackages, o.allowedPackages);
  const allowed = [...o.allowedPackages];
  if (!DIGEST.test(o.expectedImageId) || !o.expectedContainerId || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(o.image)) throw new Error('Package installation requires recorded stable image and container identities');
  const fence = (execute = true) => { if (typeof o.canMutate !== 'function' || !o.canMutate() || (execute && (typeof o.canExecute !== 'function' || !o.canExecute()))) throw new Error('Package operation grant is closed'); };
  let transportFailed = false;
  const command = async (args: string[], timeout = 15000, execute = true) => {
    fence(execute);
    let result: string;
    try { result = await runner.command(args, timeout); } catch (error) { transportFailed = true; throw error; }
    fence(execute); return result;
  };
  const inspect = async (name: string, execute = true) => {
    const value = JSON.parse(await command(['container', 'inspect', name], 15000, execute));
    if (!Array.isArray(value) || value.length !== 1) throw new Error('Invalid Docker package inspection');
    return value[0];
  };
  const verifyStable = async () => {
    const c = await inspect(stableName(o.botId));
    verifyStableInspection(c, o.botId, o, o.expectedImageId);
    if (!c.State?.Running || c.State.Paused || c.State.Restarting) throw new Error('Stable environment must be running and isolated for installation');
  };
  fence();
  const info = JSON.parse(await command(['info', '--format', '{{json .}}']));
  assertRootless(info); assertResourceControls(info);
  const images = JSON.parse(await command(['image', 'inspect', o.image]));
  if (!Array.isArray(images) || images.length !== 1 || images[0].Id !== o.expectedImageId || images[0].Os !== 'linux' || !['amd64', 'arm64'].includes(images[0].Architecture) || images[0].Config?.Labels?.['org.chestnut.pi.commit'] !== PI_SOURCE_COMMIT) throw new Error('Package downloader must use the recorded pinned Linux image');
  const architecture = images[0].Architecture as 'amd64' | 'arm64';
  await verifyStable();
  const root = resolve(o.dataRoot);
  await canonicalDirectory(root);
  const stagingRoot = join(root, 'package-staging');
  await mkdir(stagingRoot, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  return await installWithStaging();

  async function installWithStaging(): Promise<PackageInstallResult> {
    await canonicalDirectory(stagingRoot, true);
    const staging = await mkdtemp(join(stagingRoot, 'operation-'));
    await canonicalDirectory(staging, true);
    const name = `chestnut-pkg-${randomUUID()}`;
    const args = packageDownloaderCreateArgs(name, o.expectedImageId, architecture, requested, allowed, { botId: o.botId, runId: o.runId });
    await writeFile(join(staging, 'operation.json'), JSON.stringify({ schema: 1, botId: o.botId, runId: o.runId, requestId: o.requestId, downloader: name, stableContainerId: o.expectedContainerId, imageId: o.expectedImageId, requested }), { flag: 'wx', mode: 0o600 });
    let created = false, createdId: string | undefined, importStarted = false, quarantine = false;
    let result: PackageInstallResult | undefined, failure: unknown;
    try {
      fence(); created = true;
      await command(args, 30000);
      let downloader = await inspect(name);
      verifyDownloaderInspection(downloader, name, o.expectedImageId, args); createdId = downloader.Id;
      if (downloader.State?.Running || downloader.State?.Paused || downloader.State?.Restarting) throw new Error('Downloader unexpectedly already running');
      const output = await command(['container', 'start', '--attach', name], 110000);
      downloader = await inspect(name);
      verifyDownloaderInspection(downloader, name, o.expectedImageId, args);
      if (downloader.Id !== createdId || downloader.State?.Running || downloader.State?.Paused || downloader.State?.Restarting || downloader.State?.ExitCode !== 0 || downloader.State?.OOMKilled) throw new Error('Downloader completion is unverified');
      let status: any;
      try { status = JSON.parse(output); } catch { throw new Error('Invalid downloader completion response'); }
      if (!status || status.ok !== true) {
        if (status?.timedOut) quarantine = true;
        throw new Error(`Package download refused: ${typeof status?.error === 'string' ? status.error.slice(0, 500) : 'unverified result'}`);
      }
      await command(['cp', `${createdId}:/chestnut-package-stage/manifest.json`, join(staging, 'manifest.json')], 30000);
      const manifest = validatePackageManifest(JSON.parse((await verifiedFile(join(staging, 'manifest.json'), PACKAGE_LIMITS.manifestBytes)).toString('utf8')), requested, allowed, architecture);
      for (const artifact of manifest.artifacts) {
        await command(['cp', `${createdId}:/chestnut-package-stage/${artifact.name}`, join(staging, artifact.name)], 30000);
        const bytes = await verifiedFile(join(staging, artifact.name), artifact.size);
        if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Staged package SHA256 does not match authenticated metadata');
      }
      await verifyStable();
      const guestDirectory = `/tmp/chestnut-package-${randomUUID()}`;
      fence();
      const beforeImportResult: unknown = o.onBeforeImport?.();
      if (beforeImportResult !== undefined) throw new Error('Package pending marker callback must finish synchronously');
      importStarted = true;
      await command(['exec', '--user', '0:0', o.expectedContainerId, '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', '/usr/local/bin/node', '-e', "require('node:fs').mkdirSync(process.argv[1],{mode:0o700})", guestDirectory], 15000);
      // Host files, rather than any guest-generated command or install script, cross this boundary.
      for (const artifact of manifest.artifacts) {
        const path = join(staging, artifact.name);
        const bytes = await verifiedFile(path, artifact.size);
        if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Staged package changed before import');
        await command(['cp', path, `${o.expectedContainerId}:${guestDirectory}/${artifact.name}`], 30000);
      }
      await verifyStable();
      const installation = await command(['exec', '--user', '0:0', '--workdir', '/', o.expectedContainerId, '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME=/root', 'LANG=C', 'LC_ALL=C', 'DEBIAN_FRONTEND=noninteractive', '/usr/local/bin/node', '-e', PACKAGE_INSTALL_SCRIPT, guestDirectory, JSON.stringify(manifest)], 95000);
      let installed: any;
      try { installed = JSON.parse(installation); } catch { throw new Error('Package installer result is unverified'); }
      if (installed?.ok !== true) throw new Error('Package installer failed or timed out; the stable filesystem may be partially changed');
      await verifyStable();
      result = { requestedPackages: requested, artifacts: manifest.artifacts, totalBytes: manifest.totalBytes, installation: 'completed', network: 'none' };
    } catch (error) {
      failure = error;
      if (importStarted || transportFailed || !o.canMutate()) quarantine = true;
    } finally {
      if (created) {
        try {
          const ids = (await command(['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], 15000, false)).trim();
          if (ids) {
            let downloader = await inspect(name, false);
            verifyDownloaderInspection(downloader, name, o.expectedImageId, args);
            if (createdId && downloader.Id !== createdId) throw new Error('Downloader identity changed during cleanup');
            if (downloader.State?.Running || downloader.State?.Paused || downloader.State?.Restarting) {
              await command(['container', 'stop', '--time', '2', downloader.Id], 15000, false);
              downloader = await inspect(name, false);
              verifyDownloaderInspection(downloader, name, o.expectedImageId, args);
              if (downloader.State?.Running || downloader.State?.Paused || downloader.State?.Restarting) throw new Error('Downloader stop is unverified');
            }
            await command(['container', 'rm', downloader.Id], 15000, false);
            if ((await command(['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'], 15000, false)).trim()) throw new Error('Downloader removal is unverified');
          }
        } catch (error) { quarantine = true; failure = new Error(`Downloader cleanup unverified: ${String(error)}; original failure: ${String(failure ?? 'none')}`); }
      }
      if (!quarantine) { await canonicalDirectory(staging, true); await rm(staging, { recursive: true, force: false }); }
    }
    if (quarantine) {
      const reason = `Package operation requires quarantine and operator reconciliation: ${String(failure ?? 'uncertain timeout')}`;
      o.onQuarantine?.(reason);
      throw new PackageInstallQuarantineError(reason);
    }
    if (failure) throw failure;
    return result!;
  }
}

export interface PackageDownloaderCleanupOptions extends PackageDownloaderOwner {
  expectedImageId: string;
  canMutate: () => boolean;
}
/** Crash recovery owns only this database-authorized bot/run's exactly verified downloaders. */
export async function cleanupPackageDownloaders(o: PackageDownloaderCleanupOptions, runner: DockerCommandRunner): Promise<void> {
  identity(o.botId); identity(o.runId);
  if (!DIGEST.test(o.expectedImageId)) throw new PackageInstallQuarantineError('Downloader recovery requires the recorded immutable image');
  const fence = () => { if (typeof o.canMutate !== 'function' || !o.canMutate()) throw new Error('Package cleanup ownership is stale'); };
  const command = async (args: string[], timeout = 15000) => { fence(); const output = await runner.command(args, timeout); fence(); return output; };
  const listing = ['container', 'ls', '--all', '--no-trunc', '--filter', 'label=chestnut.profile=package-downloader-v1', '--filter', `label=chestnut.package-bot=${o.botId}`, '--filter', `label=chestnut.package-run=${o.runId}`, '--format', '{{.ID}}'];
  try {
    assertRootless(JSON.parse(await command(['info', '--format', '{{json .}}'])));
    const output = (await command(listing)).trim();
    const ids = output ? output.split('\n') : [];
    if (ids.length > 64 || new Set(ids).size !== ids.length) throw new Error('Downloader recovery listing is ambiguous');
    for (const id of ids) {
      identity(id);
      const inspect = async () => {
        const values = JSON.parse(await command(['container', 'inspect', id]));
        if (!Array.isArray(values) || values.length !== 1 || values[0]?.Id !== id) throw new Error('Downloader recovery identity mismatch');
        return values[0];
      };
      let c = await inspect();
      const name = c.Config?.Labels?.['chestnut.package-operation'];
      if (typeof name !== 'string' || !name.startsWith('chestnut-pkg-') || c.Name !== `/${name}` || c.Config?.Labels?.['chestnut.package-bot'] !== o.botId || c.Config?.Labels?.['chestnut.package-run'] !== o.runId) throw new Error('Downloader recovery owner mismatch');
      if (!Array.isArray(c.Config.Cmd)) throw new Error('Downloader recovery command is missing');
      const input = JSON.parse(c.Config.Cmd.at(-1));
      if (!plainKeys(input, ['architecture', 'requested', 'allowed', 'limits']) || !['amd64', 'arm64'].includes(input.architecture as string) || JSON.stringify(input.limits) !== JSON.stringify(PACKAGE_LIMITS)) throw new Error('Downloader recovery policy mismatch');
      const requested = validatePackageRequest(input.requested as string[], input.allowed as string[]);
      if (JSON.stringify(requested) !== JSON.stringify(input.requested)) throw new Error('Downloader recovery request mismatch');
      const args = packageDownloaderCreateArgs(name, o.expectedImageId, input.architecture as string, requested, input.allowed as string[], o);
      verifyDownloaderInspection(c, name, o.expectedImageId, args);
      if (c.State?.Running || c.State?.Paused || c.State?.Restarting) {
        await command(['container', 'stop', '--time', '2', id]);
        c = await inspect(); verifyDownloaderInspection(c, name, o.expectedImageId, args);
        if (c.State?.Running || c.State?.Paused || c.State?.Restarting) throw new Error('Recovered downloader stop is unverified');
      }
      await command(['container', 'rm', id]);
    }
    if ((await command(listing)).trim()) throw new Error('Recovered downloader removal is unverified');
  } catch (error) { throw new PackageInstallQuarantineError(`Package downloader recovery requires quarantine and operator reconciliation: ${String(error)}`); }
}

/** Fresh trusted image only; never receives stable-rootfs files, credentials, or broker/task mounts. */
export const PACKAGE_DOWNLOAD_SCRIPT = String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto'),path=require('node:path');
const input=JSON.parse(process.argv[1]),root='/chestnut-package-stage',apt='/tmp/chestnut-apt',keyring='/usr/share/keyrings/debian-archive-keyring.gpg';
const deadline=Date.now()+95000,env={PATH:'/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/tmp',LANG:'C',LC_ALL:'C',DEBIAN_FRONTEND:'noninteractive'};
let timedOut=false;
function run(file,args,budget=25000){const timeout=Math.min(budget,deadline-Date.now());if(timeout<=0){timedOut=true;throw Error('download deadline exceeded')}const r=cp.spawnSync(file,args,{env,encoding:'utf8',timeout,killSignal:'SIGKILL',maxBuffer:2*1024*1024});if(r.error||r.signal||r.status!==0){if(r.error?.code==='ETIMEDOUT')timedOut=true;throw Error(file+' failed: '+String(r.error?.message||r.stderr||r.stdout).slice(-1200))}return r.stdout;}
function records(text){return text.trim().split(/\n\s*\n/).map(block=>{const value={};for(const line of block.split('\n')){if(/^\s/.test(line))continue;const i=line.indexOf(': ');if(i<1)continue;const key=line.slice(0,i);if(Object.hasOwn(value,key))throw Error('duplicate apt metadata');value[key]=line.slice(i+2)}return value})}
try{
 if(!/^ID=debian$/m.test(fs.readFileSync('/etc/os-release','utf8'))||!/^VERSION_CODENAME=bookworm$/m.test(fs.readFileSync('/etc/os-release','utf8')))throw Error('image is not Debian bookworm');
 if(run('/usr/bin/dpkg',['--print-architecture']).trim()!==input.architecture)throw Error('image architecture mismatch');
 fs.mkdirSync(root,{mode:0o700});fs.mkdirSync(apt,{mode:0o700});for(const d of ['lists','lists/partial','archives','archives/partial','empty'])fs.mkdirSync(apt+'/'+d,{mode:0o755});
 const sources='deb [arch='+input.architecture+' signed-by='+keyring+'] https://deb.debian.org/debian bookworm main\n'+'deb [arch='+input.architecture+' signed-by='+keyring+'] https://deb.debian.org/debian bookworm-updates main\n'+'deb [arch='+input.architecture+' signed-by='+keyring+'] https://deb.debian.org/debian-security bookworm-security main\n';
 fs.writeFileSync(apt+'/sources.list',sources,{mode:0o600});
 // APT_CONFIG replaces the image's config entry point; empty parts/main prevent hook injection.
 fs.writeFileSync(apt+'/config','Dir::Etc::parts "'+apt+'/empty";\nDir::Etc::main "'+apt+'/absent";\n',{mode:0o600});env.APT_CONFIG=apt+'/config';
 const opts=['-o','Dir::Etc::sourcelist='+apt+'/sources.list','-o','Dir::Etc::sourceparts='+apt+'/empty','-o','Dir::State::lists='+apt+'/lists','-o','Dir::Cache::archives='+apt+'/archives','-o','Dir::Cache::pkgcache=','-o','Dir::Cache::srcpkgcache=','-o','APT::Architecture='+input.architecture,'-o','Acquire::AllowInsecureRepositories=false','-o','Acquire::AllowDowngradeToInsecureRepositories=false','-o','APT::Get::AllowUnauthenticated=false','-o','Acquire::Check-Valid-Until=true','-o','Acquire::Check-Date=true','-o','Acquire::Languages=none','-o','Acquire::Retries=0','-o','Acquire::https::Timeout=15','-o','Acquire::http::Timeout=15','-o','Acquire::https::AllowRedirect=false','-o','Acquire::http::AllowRedirect=false','-o','Acquire::IndexTargets::deb::DEP-11::DefaultEnabled=false','-o','APT::Update::Error-Mode=any'];
 run('/usr/bin/apt-get',[...opts,'update'],35000);
 for(const [filename,codename] of [['deb.debian.org_debian_dists_bookworm_InRelease','bookworm'],['deb.debian.org_debian_dists_bookworm-updates_InRelease','bookworm-updates'],['deb.debian.org_debian-security_dists_bookworm-security_InRelease','bookworm-security']]){const p=apt+'/lists/'+filename;run('/usr/bin/gpgv',['--keyring',keyring,p],5000);const release=fs.readFileSync(p,'utf8');if(!release.startsWith('-----BEGIN PGP SIGNED MESSAGE-----\n')||!release.includes('\nCodename: '+codename+'\n'))throw Error('InRelease codename mismatch')}
 const install=['--yes','--download-only','--reinstall','--no-install-recommends','--no-remove','install','--',...input.requested];
 const plan=run('/usr/bin/apt-get',[...opts,'--print-uris',...install],15000);
 const artifacts=[];let total=0;
 for(const line of plan.split('\n')){if(!line.startsWith("'"))continue;const m=/^'([^']+)' ([^ ]+) ([0-9]+) ([^ ]+)$/.exec(line);if(!m)throw Error('invalid apt URI plan');const url=new URL(m[1]),name=m[2],n=/^([a-z0-9][a-z0-9+.-]{1,63})_([A-Za-z0-9.+:~%\-]{1,160})_(amd64|arm64|all)\.deb$/.exec(name);if(!n||!/^(?:[0-9]+:)?[0-9][A-Za-z0-9.+:~\-]*$/.test(decodeURIComponent(n[2]))||url.protocol!=='https:'||url.hostname!=='deb.debian.org'||url.port||url.username||url.password||url.search||url.hash||!/^\/(debian|debian-security)\/pool\/main\//.test(url.pathname)||!input.allowed.includes(n[1])||![input.architecture,'all'].includes(n[3]))throw Error('download is outside operator package/source policy');
 const rows=records(run('/usr/bin/apt-cache',[...opts,'show','--',n[1]],10000));const matches=rows.filter(r=>r.Package===n[1]&&r.Version===decodeURIComponent(n[2])&&r.Architecture===n[3]&&decodeURIComponent(url.pathname).endsWith('/'+r.Filename)&&String(r.Size)===m[3]&&/^[a-f0-9]{64}$/.test(r.SHA256||''));if(matches.length!==1)throw Error('package lacks unique authenticated SHA256 metadata');
 const r=matches[0],size=Number(r.Size);total+=size;if(!Number.isSafeInteger(size)||size<=0||total>input.limits.bytes||artifacts.length>=input.limits.artifacts||artifacts.some(a=>a.package===r.Package))throw Error('package download budget exceeded');artifacts.push({name,package:r.Package,version:r.Version,architecture:r.Architecture,size,sha256:r.SHA256});}
 if(!artifacts.length||input.requested.some(p=>!artifacts.some(a=>a.package===p)))throw Error('requested package is virtual or absent from plan');
 run('/usr/bin/apt-get',[...opts,...install],45000);
 const actual=fs.readdirSync(apt+'/archives').filter(n=>n.endsWith('.deb'));if(actual.length!==artifacts.length||actual.some(n=>!artifacts.some(a=>a.name===n)))throw Error('unexpected downloaded package');
 for(const a of artifacts){const p=apt+'/archives/'+a.name,s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size!==a.size||crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==a.sha256)throw Error('package hash mismatch');fs.renameSync(p,root+'/'+a.name);fs.chmodSync(root+'/'+a.name,0o600)}
 fs.writeFileSync(root+'/manifest.json',JSON.stringify({schema:1,suite:'bookworm',architecture:input.architecture,requested:input.requested,artifacts,totalBytes:total}),{mode:0o600});console.log(JSON.stringify({ok:true}));
}catch(error){console.log(JSON.stringify({ok:false,timedOut,error:String(error.message).slice(0,1500)}))}
`;

/** Untrusted maintenance scripts run only here, inside the stable rootless network-none container. */
export const PACKAGE_INSTALL_SCRIPT = String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto'),directory=process.argv[1],manifest=JSON.parse(process.argv[2]);
try{const s=fs.lstatSync(directory);if(!s.isDirectory()||s.isSymbolicLink())throw Error('unsafe import directory');const files=[];for(const a of manifest.artifacts){const p=directory+'/'+a.name,s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size!==a.size||crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==a.sha256)throw Error('import checksum mismatch');files.push(p)}
const result=cp.spawnSync('/usr/bin/dpkg',['--force-confdef','--force-confold','--install',...files],{env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',HOME:'/root',LANG:'C',LC_ALL:'C',DEBIAN_FRONTEND:'noninteractive'},encoding:'utf8',timeout:85000,killSignal:'SIGKILL',maxBuffer:1024*1024});if(result.error||result.signal||result.status!==0)throw Error('dpkg failed or timed out');fs.rmSync(directory,{recursive:true});console.log(JSON.stringify({ok:true}));
}catch(error){console.log(JSON.stringify({ok:false,error:String(error.message).slice(0,1000)}))}
`;
