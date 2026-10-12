import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { cleanupPackageDownloaders, installGovernedPackages, PACKAGE_DOWNLOAD_SCRIPT, PACKAGE_INSTALL_SCRIPT, PACKAGE_LIMITS, PackageInstallQuarantineError, packageDownloaderCreateArgs, validatePackageManifest, validatePackageRequest, verifyDownloaderInspection, type GovernedPackageOptions, type PackageManifest } from '../src/environments/packages.ts';
import { ENVIRONMENT_CAPABILITIES } from '../src/environments/stable-docker.ts';
import { PI_SOURCE_COMMIT } from '../src/sandbox/rootless-docker.ts';
import type { DockerAttachment, DockerCommandRunner } from '../src/sandbox/persistent-docker.ts';

const imageId = `sha256:${'a'.repeat(64)}`, artifactBytes = Buffer.from('synthetic Debian bytes; never executed');
const hash = createHash('sha256').update(artifactBytes).digest('hex');
function manifest(): PackageManifest {
  return { schema: 1, suite: 'bookworm', architecture: 'amd64', requested: ['curl'], totalBytes: artifactBytes.length,
    artifacts: [{ name: 'curl_7.88.1-1_amd64.deb', package: 'curl', version: '7.88.1-1', architecture: 'amd64', size: artifactBytes.length, sha256: hash }] };
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function hostConfig(network: string, memory: number) {
  return { NetworkMode: network, Privileged: false, ReadonlyRootfs: false, AutoRemove: false, PublishAllPorts: false, Init: true,
    CapDrop: ['ALL'], CapAdd: [...ENVIRONMENT_CAPABILITIES], SecurityOpt: ['no-new-privileges'], PidMode: '', IpcMode: 'private', CgroupnsMode: 'private', UTSMode: '', UsernsMode: '', RestartPolicy: { Name: 'no' },
    Memory: memory, MemorySwap: memory, PidsLimit: 128, NanoCpus: 1_000_000_000 };
}
function stable(o: GovernedPackageOptions): any {
  return { Id: 'stable-container', Image: imageId, State: { Running: true, Paused: false, Restarting: false },
    Config: { Image: o.image, User: '0:0', Labels: { 'chestnut.bot': 'bot1', 'chestnut.profile': 'service-v1', 'chestnut.schema': '1' }, Entrypoint: ['node'], Cmd: ['-e', 'setInterval(() => {}, 60000)'], Env: ['PATH=/usr/local/bin:/usr/bin', 'HOME=/tmp/home'] },
    HostConfig: hostConfig('none', 1024 * 1024 * 1024), Mounts: [{ Type: 'bind', Source: join(o.dataRoot, 'bots', 'bot1', 'workspace'), Destination: '/workspace', RW: true, Propagation: 'rprivate' }] };
}
function downloader(args: string[]): any {
  const name = args[args.indexOf('--name') + 1];
  const labels: Record<string, string> = {};
  args.forEach((value, index) => { if (value === '--label') { const label = args[index + 1], split = label.indexOf('='); labels[label.slice(0, split)] = label.slice(split + 1); } });
  return { Id: 'downloader-container', Name: `/${name}`, Image: imageId, State: { Running: false, Paused: false, Restarting: false, ExitCode: 0, OOMKilled: false },
    Config: { Image: imageId, User: '0:0', WorkingDir: '/', Labels: labels, Entrypoint: ['/usr/bin/env'], Cmd: args.slice(args.indexOf(imageId) + 1), Env: ['PATH=/usr/local/bin:/usr/bin', 'HOME=/tmp/home', 'PI_OFFLINE=1'] },
    HostConfig: hostConfig('bridge', 512 * 1024 * 1024), Mounts: [], NetworkSettings: { Networks: { bridge: {} } } };
}
class FakeDocker implements DockerCommandRunner {
  calls: { args: string[]; timeout: number | undefined }[] = [];
  download: any; current: any; image: any; downloadManifest = manifest();
  downloadStatus: unknown = { ok: true }; installation: unknown = { ok: true }; removed = false;
  corrupt = false; symlinkManifest = false; failAt?: (args: string[]) => boolean; after?: (args: string[]) => void;
  constructor(o: GovernedPackageOptions) { this.current = stable(o); this.image = { Id: imageId, Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.chestnut.pi.commit': PI_SOURCE_COMMIT } } }; }
  async command(args: string[], timeout?: number): Promise<string> {
    this.calls.push({ args: [...args], timeout });
    if (this.failAt?.(args)) throw new Error('Docker command timed out; daemon side effects unverified');
    let result = '';
    if (args[0] === 'info') result = JSON.stringify({ SecurityOptions: ['name=rootless'], CgroupVersion: '2', CgroupDriver: 'systemd', MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsQuota: true });
    else if (args[0] === 'image') result = JSON.stringify([this.image]);
    else if (args[0] === 'create') { this.download = downloader(args); result = this.download.Id; }
    else if (args[0] === 'container' && args[1] === 'inspect') result = JSON.stringify([args[2] === 'chestnut-env-bot1' ? this.current : this.download]);
    else if (args[0] === 'container' && args[1] === 'start') result = JSON.stringify(this.downloadStatus);
    else if (args[0] === 'container' && args[1] === 'ls') result = this.download && !this.removed ? this.download.Id : '';
    else if (args[0] === 'container' && args[1] === 'stop') this.download.State.Running = false;
    else if (args[0] === 'container' && args[1] === 'rm') this.removed = true;
    else if (args[0] === 'cp' && args[1].startsWith('downloader-container:')) {
      if (args[1].endsWith('/manifest.json')) {
        if (this.symlinkManifest) await symlink('/etc/passwd', args[2]);
        else await writeFile(args[2], JSON.stringify(this.downloadManifest), { mode: 0o600 });
      } else await writeFile(args[2], this.corrupt ? Buffer.alloc(artifactBytes.length) : artifactBytes, { mode: 0o600 });
    } else if (args[0] === 'cp') { /* synthetic import only */ }
    else if (args[0] === 'exec') result = args.includes(PACKAGE_INSTALL_SCRIPT) ? JSON.stringify(this.installation) : '';
    else throw new Error(`Unexpected fake Docker command ${args[0]}`);
    this.after?.(args); return result;
  }
  attach(): DockerAttachment { throw new Error('Package path must never attach an interactive shell'); }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'chestnut-packages-'));
  await mkdir(join(root, 'bots', 'bot1', 'workspace'), { recursive: true });
  const quarantines: string[] = [];
  const o: GovernedPackageOptions = { botId: 'bot1', runId: 'run1', requestId: 'request1', dataRoot: root, image: 'chestnut-pi:pinned', expectedContainerId: 'stable-container', expectedImageId: imageId, allowedPackages: ['curl'], requestedPackages: ['curl'], canMutate: () => true, canExecute: () => true, onQuarantine: value => { quarantines.push(value); } };
  return { o, quarantines, docker: new FakeDocker(o), dispose: () => rm(root, { recursive: true, force: true }) };
}

test('package policy admits names only and never implicit or expanded operator policy', () => {
  assert.deepEqual(validatePackageRequest(['curl'], ['curl']), ['curl']);
  for (const names of [[], ['-y'], ['curl;touch'], ['curl=1'], ['curl:arm64'], ['../curl'], ['curl', 'curl'], Array.from({ length: 17 }, (_, i) => `pkg${i}`)]) assert.throws(() => validatePackageRequest(names, ['curl']));
  assert.throws(() => validatePackageRequest(['curl'], []), /explicit operator/);
  assert.throws(() => validatePackageRequest(['wget'], ['curl']), /operator allowlist/);
});
test('manifest rejects unexpected dependency, wrong digest, traversal, symlinks by filename, architecture, counts and budgets', () => {
  assert.deepEqual(validatePackageManifest(manifest(), ['curl'], ['curl'], 'amd64'), manifest());
  const changes = [
    (v: any) => { v.artifacts[0].name = '../curl_1_amd64.deb'; }, (v: any) => { v.artifacts[0].package = 'wget'; },
    (v: any) => { v.artifacts[0].sha256 = 'unsigned'; }, (v: any) => { v.architecture = 'arm64'; },
    (v: any) => { v.artifacts[0].size = PACKAGE_LIMITS.bytes + 1; }, (v: any) => { v.artifacts.push(v.artifacts[0]); },
    (v: any) => { v.requested = ['wget']; }, (v: any) => { v.source = 'https://evil.test'; },
    (v: any) => { v.artifacts[0].name = 'curl_%ZZ_amd64.deb'; }, (v: any) => { v.totalBytes++; },
  ];
  for (const change of changes) { const value = manifest(); change(value); assert.throws(() => validatePackageManifest(value, ['curl'], ['curl'], 'amd64')); }
});
test('disposable downloader has exact bridge network, no mounts or host env inheritance, and fixed script argv', () => {
  const args = packageDownloaderCreateArgs('chestnut-pkg-test', imageId, 'amd64', ['curl'], ['curl']);
  assert.equal(args[args.indexOf('--network') + 1], 'bridge');
  for (const flag of ['--mount', '--volume', '--env', '--env-file', '--privileged', '--network=host', '--rm']) assert.equal(args.includes(flag), false);
  assert.ok(args.includes(PACKAGE_DOWNLOAD_SCRIPT)); assert.ok(!args.includes('SYS_ADMIN'));
  assert.doesNotThrow(() => verifyDownloaderInspection(downloader(args), 'chestnut-pkg-test', imageId, args));
  for (const change of [
    (c: any) => { c.Mounts.push({ Source: '/workspace', Destination: '/workspace' }); },
    (c: any) => { c.Config.Env.push('OPENAI_API_KEY=secret'); },
    (c: any) => { c.HostConfig.NetworkMode = 'host'; },
    (c: any) => { c.NetworkSettings.Networks.evil = {}; },
    (c: any) => { c.HostConfig.CapAdd.push('SYS_ADMIN'); },
    (c: any) => { c.Config.Cmd.push('curl evil.test'); },
  ]) { const c = downloader(args); change(c); assert.throws(() => verifyDownloaderInspection(c, 'chestnut-pkg-test', imageId, args)); }
});
test('synthetic staging verifies host SHA256, imports opaque debs, installs offline, and authoritatively removes downloader', async () => {
  const f = await fixture(); try {
    const result = await installGovernedPackages(f.o, f.docker);
    assert.equal(result.installation, 'completed'); assert.equal(result.network, 'none'); assert.equal(result.artifacts[0].sha256, hash);
    assert.equal(f.docker.removed, true); assert.equal(f.quarantines.length, 0);
    const calls = f.docker.calls.map(c => c.args), installAt = calls.findIndex(c => c.includes(PACKAGE_INSTALL_SCRIPT));
    assert.ok(installAt > calls.findIndex(c => c[0] === 'cp' && !c[1].includes(':')));
    assert.equal(calls.some(c => c[0] === 'network'), false);
    assert.ok(f.docker.calls.every(c => !c.timeout || c.timeout <= 120000));
    assert.deepEqual(await readdir(join(f.o.dataRoot, 'package-staging')), []);
    // Existing staging directory is valid for a later operation; no request can change policy.
    f.docker.removed = false; await installGovernedPackages(f.o, f.docker);
  } finally { await f.dispose(); }
});
test('corrupt and symlink artifacts fail before stable import or dpkg', async () => {
  for (const mode of ['corrupt', 'symlinkManifest'] as const) {
    const f = await fixture(); try {
      f.docker[mode] = true;
      await assert.rejects(installGovernedPackages(f.o, f.docker));
      assert.equal(f.docker.calls.some(c => c.args.includes(PACKAGE_INSTALL_SCRIPT)), false);
      assert.equal(f.docker.calls.some(c => c.args[0] === 'cp' && !c.args[1].includes(':')), false);
      assert.equal(f.docker.removed, true);
    } finally { await f.dispose(); }
  }
});
test('hostile manifest cannot expand allowed dependency closure', async () => {
  const f = await fixture(); try {
    const added = { ...manifest().artifacts[0], name: 'wget_1_amd64.deb', package: 'wget', version: '1' };
    f.docker.downloadManifest.artifacts.push(added); f.docker.downloadManifest.totalBytes += added.size;
    await assert.rejects(installGovernedPackages(f.o, f.docker), /operator policy/);
    assert.equal(f.docker.calls.some(c => c.args.includes(PACKAGE_INSTALL_SCRIPT)), false);
  } finally { await f.dispose(); }
});
test('wrong image, stable networking, and host staging symlink are refused before downloader creation', async () => {
  for (const mode of ['image', 'network', 'symlink']) {
    const f = await fixture(); try {
      if (mode === 'image') f.docker.image.Id = `sha256:${'b'.repeat(64)}`;
      if (mode === 'network') f.docker.current.HostConfig.NetworkMode = 'bridge';
      if (mode === 'symlink') await symlink(join(f.o.dataRoot, 'bots'), join(f.o.dataRoot, 'package-staging'));
      await assert.rejects(installGovernedPackages(f.o, f.docker));
      assert.equal(f.docker.calls.some(c => c.args[0] === 'create'), false);
    } finally { await f.dispose(); }
  }
});
test('grant revocation prevents launch and still permits owned authoritative downloader cleanup', async () => {
  const f = await fixture(); try {
    let live = true; f.o.canExecute = () => live;
    f.docker.after = args => { if (args[0] === 'create') live = false; };
    await assert.rejects(installGovernedPackages(f.o, f.docker), /grant is closed/);
    assert.equal(f.docker.calls.some(c => c.args[1] === 'start'), false); assert.equal(f.docker.removed, true);
  } finally { await f.dispose(); }
});
test('timeout, partial installation, and uncertain cleanup quarantine without replay', async () => {
  for (const mode of ['transport', 'installer', 'cleanup', 'download-timeout']) {
    const f = await fixture(); try {
      if (mode === 'transport') f.docker.failAt = args => args[1] === 'start';
      if (mode === 'installer') f.docker.installation = { ok: false };
      if (mode === 'cleanup') f.docker.failAt = args => args[1] === 'rm';
      if (mode === 'download-timeout') f.docker.downloadStatus = { ok: false, timedOut: true, error: 'deadline' };
      await assert.rejects(installGovernedPackages(f.o, f.docker), PackageInstallQuarantineError);
      assert.equal(f.quarantines.length, 1);
      assert.equal(f.docker.calls.filter(c => c.args[1] === 'start').length, 1);
      assert.equal(f.docker.calls.filter(c => c.args.includes(PACKAGE_INSTALL_SCRIPT)).length, mode === 'installer' || mode === 'cleanup' ? 1 : 0);
      assert.equal((await readdir(join(f.o.dataRoot, 'package-staging'))).length, 1);
    } finally { await f.dispose(); }
  }
});
test('lost ownership leaves cleanup quarantined rather than mutating under a stale lock', async () => {
  const f = await fixture(); try {
    let owned = true; f.o.canMutate = () => owned;
    f.docker.after = args => { if (args[0] === 'create') owned = false; };
    await assert.rejects(installGovernedPackages(f.o, f.docker), PackageInstallQuarantineError);
    assert.equal(f.docker.calls.some(c => c.args[1] === 'stop' || c.args[1] === 'rm'), false);
  } finally { await f.dispose(); }
});

/** Execute the actual fixed downloader code using in-memory fs/process fixtures, never Docker/network. */
function dryDownload(options: { signatureFailure?: boolean; corrupt?: boolean; allowed?: string[] } = {}) {
  const calls: { file: string; args: string[]; options: any }[] = [], files = new Map<string, Buffer>();
  const releasePrefix = '/tmp/chestnut-apt/lists/';
  files.set('/etc/os-release', Buffer.from('ID=debian\nVERSION_CODENAME=bookworm\n'));
  for (const [file, suite] of [['deb.debian.org_debian_dists_bookworm_InRelease', 'bookworm'], ['deb.debian.org_debian_dists_bookworm-updates_InRelease', 'bookworm-updates'], ['deb.debian.org_debian-security_dists_bookworm-security_InRelease', 'bookworm-security']]) files.set(releasePrefix + file, Buffer.from(`-----BEGIN PGP SIGNED MESSAGE-----\nCodename: ${suite}\n`));
  const fakeFs = {
    mkdirSync() {}, chmodSync() {}, readFileSync(path: string, encoding?: string) { const value = files.get(path); if (!value) throw new Error('Missing synthetic file'); return encoding ? value.toString() : value; },
    writeFileSync(path: string, bytes: string | Buffer) { files.set(path, Buffer.from(bytes)); },
    readdirSync() { return ['curl_7.88.1-1_amd64.deb', 'partial', 'lock']; },
    lstatSync(path: string) { return { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: files.get(path)!.length }; },
    renameSync(from: string, to: string) { files.set(to, files.get(from)!); files.delete(from); },
  };
  const spawnSync = (file: string, args: string[], options_: any) => {
    calls.push({ file, args, options: options_ }); let stdout = '';
    if (file.endsWith('/dpkg')) stdout = 'amd64\n';
    else if (file.endsWith('/gpgv') && options.signatureFailure) return { status: 2, stderr: 'BAD signature' };
    else if (file.endsWith('/apt-get') && args.includes('--print-uris')) stdout = `'https://deb.debian.org/debian/pool/main/c/curl/curl_7.88.1-1_amd64.deb' curl_7.88.1-1_amd64.deb ${artifactBytes.length} MD5Sum:untrusted-not-used\n`;
    else if (file.endsWith('/apt-cache')) stdout = `Package: curl\nVersion: 7.88.1-1\nArchitecture: amd64\nFilename: pool/main/c/curl/curl_7.88.1-1_amd64.deb\nSize: ${artifactBytes.length}\nSHA256: ${hash}\n`;
    else if (file.endsWith('/apt-get') && args.includes('--download-only')) files.set('/tmp/chestnut-apt/archives/curl_7.88.1-1_amd64.deb', options.corrupt ? Buffer.alloc(artifactBytes.length) : artifactBytes);
    return { status: 0, stdout, stderr: '' };
  };
  let output = '';
  new Script(PACKAGE_DOWNLOAD_SCRIPT).runInNewContext({ require: (name: string) => name === 'node:fs' ? fakeFs : name === 'node:child_process' ? { spawnSync } : name === 'node:crypto' ? { createHash } : {}, process: { argv: ['node', JSON.stringify({ architecture: 'amd64', requested: ['curl'], allowed: options.allowed ?? ['curl'], limits: PACKAGE_LIMITS })] }, URL, Buffer, console: { log: (value: string) => { output = value; } } }, { timeout: 1000 });
  return { status: JSON.parse(output), files, calls };
}
test('fixed downloader verifies all InRelease signatures and authenticated SHA256; no apt installation scripts', () => {
  const run = dryDownload(); assert.equal(run.status.ok, true);
  assert.equal(run.calls.filter(c => c.file.endsWith('/gpgv')).length, 3);
  const apt = run.calls.filter(c => c.file.endsWith('/apt-get'));
  assert.ok(apt.every(c => c.args.includes('APT::Get::AllowUnauthenticated=false') && c.args.includes('Acquire::AllowInsecureRepositories=false') && c.args.includes('Acquire::Check-Valid-Until=true')));
  assert.ok(apt.filter(c => c.args.includes('install')).every(c => c.args.includes('--download-only') && c.args.includes('--no-remove')));
  assert.equal(run.calls.filter(c => c.file.endsWith('/dpkg')).length, 1); // architecture probe only
  assert.ok(run.calls.every(c => !Object.hasOwn(c.options.env, 'OPENAI_API_KEY')));
  assert.ok(run.files.has('/chestnut-package-stage/manifest.json'));
  new Script(PACKAGE_INSTALL_SCRIPT); // Syntax validation only; real dpkg never runs in this suite.
});
test('fixed downloader refuses bad InRelease signatures, bad payload SHA256, and non-allowlisted dependencies', () => {
  for (const options of [{ signatureFailure: true }, { corrupt: true }, { allowed: ['wget'] }]) {
    const run = dryDownload(options); assert.equal(run.status.ok, false);
    assert.equal(run.files.has('/chestnut-package-stage/manifest.json'), false);
  }
});

test('pending marker is persisted before first stable mutation, never during networked download', async () => {
  const f = await fixture(); try {
    let markers = 0;
    f.o.onBeforeImport = () => {
      markers++;
      assert.equal(f.docker.calls.some(c => c.args[0] === 'exec'), false);
      assert.equal(f.docker.calls.some(c => c.args[0] === 'cp' && !c.args[1].includes(':')), false);
      assert.equal(f.docker.calls.filter(c => c.args[0] === 'cp' && c.args[1].startsWith('downloader-container:')).length, 2);
    };
    await installGovernedPackages(f.o, f.docker); assert.equal(markers, 1);
  } finally { await f.dispose(); }
});
test('pending marker failure prevents any stable mutation', async () => {
  const f = await fixture(); try {
    f.o.onBeforeImport = () => { throw new Error('pending marker persistence failed'); };
    await assert.rejects(installGovernedPackages(f.o, f.docker), /pending marker persistence failed/);
    assert.equal(f.docker.calls.some(c => c.args[0] === 'exec'), false);
    assert.equal(f.docker.removed, true);
  } finally { await f.dispose(); }
});
test('recovery cleans only strictly verified downloader owned by the database bot/run', async () => {
  const f = await fixture(); try {
    f.docker.download = downloader(packageDownloaderCreateArgs('chestnut-pkg-orphan', imageId, 'amd64', ['curl'], ['curl'], f.o));
    f.docker.download.State.Running = true;
    await cleanupPackageDownloaders({ botId: 'bot1', runId: 'run1', expectedImageId: imageId, canMutate: () => true }, f.docker);
    assert.equal(f.docker.removed, true);
    const listing = f.docker.calls.find(c => c.args[1] === 'ls')!.args;
    assert.ok(listing.includes('label=chestnut.package-bot=bot1')); assert.ok(listing.includes('label=chestnut.package-run=run1'));
    assert.equal(f.docker.calls.filter(c => c.args[1] === 'stop').length, 1);
    assert.equal(f.docker.calls.some(c => c.args.includes('stable-container')), false);
  } finally { await f.dispose(); }
});
test('recovery rejects wrong owner, image, fixed argv, limits and ambiguous names without removal', async () => {
  for (const change of [
    (c: any) => { c.Config.Labels['chestnut.package-bot'] = 'bot2'; },
    (c: any) => { c.Config.Labels['chestnut.package-run'] = 'run2'; },
    (c: any) => { c.Image = `sha256:${'b'.repeat(64)}`; },
    (c: any) => { c.Config.Cmd[0] = 'evil'; },
    (c: any) => { const input = JSON.parse(c.Config.Cmd.at(-1)); input.limits.bytes++; c.Config.Cmd[c.Config.Cmd.length - 1] = JSON.stringify(input); },
    (c: any) => { c.Name = '/another-container'; },
  ]) {
    const f = await fixture(); try {
      f.docker.download = downloader(packageDownloaderCreateArgs('chestnut-pkg-orphan', imageId, 'amd64', ['curl'], ['curl'], f.o));
      change(f.docker.download);
      await assert.rejects(cleanupPackageDownloaders({ botId: 'bot1', runId: 'run1', expectedImageId: imageId, canMutate: () => true }, f.docker), PackageInstallQuarantineError);
      assert.equal(f.docker.calls.some(c => c.args[1] === 'stop' || c.args[1] === 'rm'), false);
    } finally { await f.dispose(); }
  }
});
test('recovery with stale ownership or failed stop retains quarantine', async () => {
  const f = await fixture(); try {
    f.docker.download = downloader(packageDownloaderCreateArgs('chestnut-pkg-orphan', imageId, 'amd64', ['curl'], ['curl'], f.o));
    f.docker.download.State.Running = true;
    await assert.rejects(cleanupPackageDownloaders({ botId: 'bot1', runId: 'run1', expectedImageId: imageId, canMutate: () => false }, f.docker), PackageInstallQuarantineError);
    assert.equal(f.docker.calls.length, 0);
    f.docker.failAt = args => args[1] === 'stop';
    await assert.rejects(cleanupPackageDownloaders({ botId: 'bot1', runId: 'run1', expectedImageId: imageId, canMutate: () => true }, f.docker), PackageInstallQuarantineError);
    assert.equal(f.docker.calls.filter(c => c.args[1] === 'stop').length, 1);
    assert.equal(f.docker.calls.some(c => c.args[1] === 'rm'), false);
  } finally { await f.dispose(); }
});
