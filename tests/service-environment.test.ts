import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StableEnvironment, stableCreateArgs, verifyStableInspection, ENVIRONMENT_CAPABILITIES, DESKTOP_TMPFS_INIT, type StableOptions } from '../src/environments/stable-docker.ts';
import { buildDockerArgs, PI_SOURCE_COMMIT } from '../src/sandbox/rootless-docker.ts';
import type { DockerCommandRunner } from '../src/sandbox/persistent-docker.ts';
import { PiRpcAdapter } from '../src/pi/rpc-adapter.ts';
import type { RpcTransport, WorkerInput } from '../src/pi/types.ts';
import { randomUUID } from 'node:crypto';
import { config, prepareStorage } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { Worker } from '../src/worker.ts';
import { AuthManager } from '../src/auth.ts';
import type { Run } from '../src/types.ts';
import { EnvironmentPolicies } from '../src/environments/policy.ts';

const IMAGE_ID = 'sha256:fixture-image';
const BOT = 'fixture-bot';
function options(dataRoot = '/fixture'): StableOptions {
  return { dataRoot, image: 'chestnut-pi:fixture', canMutate: () => true, canExecute: () => true };
}
function inspection(o: StableOptions, running = false) {
  return {
    Id: 'fixture-container', Image: IMAGE_ID, State: { Running: running, Paused: false, Restarting: false },
    Config: { Image: o.image, User: '0:0', Labels: { 'chestnut.bot': BOT, 'chestnut.profile': 'service-v1', 'chestnut.schema': '1' }, Entrypoint: ['node'], Cmd: ['-e', 'setInterval(() => {}, 60000)'], Env: ['PATH=/usr/local/bin:/usr/bin', 'HOME=/tmp/home', 'PI_OFFLINE=1'] },
    HostConfig: { NetworkMode: 'none', Privileged: false, ReadonlyRootfs: false, AutoRemove: false, PublishAllPorts: false, Init: true, CapDrop: ['ALL'], CapAdd: [...ENVIRONMENT_CAPABILITIES], SecurityOpt: ['no-new-privileges'], Devices: [], DeviceRequests: [], ExtraHosts: [], VolumesFrom: [], Binds: [], PortBindings: {}, PidMode: '', IpcMode: 'private', CgroupnsMode: 'private', UTSMode: '', UsernsMode: '', RestartPolicy: { Name: 'no' }, Memory: 1073741824, MemorySwap: 1073741824, PidsLimit: 128, NanoCpus: 1000000000 },
    Mounts: [{ Type: 'bind', Source: join(o.dataRoot, 'bots', BOT, 'workspace'), Destination: '/workspace', RW: true, Propagation: 'rprivate' }],
  };
}
/** Pure state machine: never invokes Docker, spawns a process, or opens a socket. */
class FixtureDocker implements DockerCommandRunner {
  calls: string[][] = [];
  current: ReturnType<typeof inspection> | undefined;
  resourceControls = true;
  rootless = true;
  imageId = IMAGE_ID;
  keepRunning = false;
  output = JSON.stringify({ stdout: 'fixture output', stderr: '', code: 0, timedOut: false, truncated: false });
  afterCommand?: (args: string[]) => void;
  readonly options: StableOptions;
  constructor(o: StableOptions) { this.options = o; }
  async command(args: string[]): Promise<string> {
    this.calls.push([...args]);
    let result = '';
    if (args[0] === 'info') result = JSON.stringify({ SecurityOptions: this.rootless ? ['name=rootless'] : [], CgroupVersion: this.resourceControls ? '2' : '1', CgroupDriver: this.resourceControls ? 'systemd' : 'none', MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsQuota: true });
    else if (args[0] === 'image') result = JSON.stringify([{ Id: this.imageId, Config: { Labels: { 'org.chestnut.pi.commit': PI_SOURCE_COMMIT } } }]);
    else if (args[0] === 'create') { this.current = inspection(this.options); result = this.current.Id; }
    else if (args[0] === 'container' && args[1] === 'ls') result = this.current?.Id ?? '';
    else if (args[0] === 'container' && args[1] === 'inspect') result = JSON.stringify([this.current]);
    else if (args[0] === 'container' && args[1] === 'start') { assert.ok(this.current); this.current.State.Running = true; }
    else if (args[0] === 'container' && args[1] === 'stop') { assert.ok(this.current); if (!this.keepRunning) this.current.State.Running = false; }
    else if (args[0] === 'exec') result = this.output;
    else throw new Error(`Unexpected synthetic Docker operation: ${args.join(' ')}`);
    this.afterCommand?.(args);
    return result;
  }
  attach(): never { throw new Error('Attachments are forbidden in this synthetic fixture'); }
}
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'cn-service-test-'));
  const o = options(root);
  await mkdir(join(root, 'bots', BOT, 'workspace'), { recursive: true });
  const docker = new FixtureDocker(o);
  return { root, o, docker, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('stable root gets only its workspace, bounded resources and exact namespaced capabilities', () => {
  const args = stableCreateArgs(BOT, options());
  assert.equal(args.filter(value => value === '--mount').length, 1);
  assert.ok(args.includes('type=bind,source=/fixture/bots/fixture-bot/workspace,target=/workspace'));
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args.includes('--read-only'), false);
  assert.equal(args.includes('--rm'), false);
  assert.equal(args.includes('--privileged'), false);
  assert.equal(args.some(value => /model\.sock|memory\.sock|environment\.sock|docker\.sock|\/session|API_KEY/.test(value)), false);
  assert.deepEqual(args.flatMap((value, index) => value === '--cap-add' ? [args[index + 1]] : []), ENVIRONMENT_CAPABILITIES);
  assert.throws(() => stableCreateArgs('../other', options()), /identity/);
  assert.throws(() => stableCreateArgs(BOT, { ...options(), image: 'bad image' }), /image/);
});

test('service Pi runner has a private tmpfs workspace and no stable workspace bind', () => {
  const input = { botId: BOT, taskId: 'task1', runId: 'run1', prompt: 'fixture', workspace: '/fixture/stable-workspace', sessionPath: '/fixture/session/session.jsonl' };
  const args = buildDockerArgs(input, { dataRoot: '/fixture', gatewayDirectory: '/fixture/run-brokers', model: 'fixture-model', environmentBroker: true });
  assert.ok(args.includes('/workspace:rw,nosuid,nodev,size=64m,mode=700'));
  assert.equal(args.some(value => value.includes('source=/fixture/stable-workspace')), false);
  assert.ok(args.includes('CHESTNUT_ENVIRONMENT_BROKER=1'));
  assert.ok(args.includes('--read-only'));
});

test('inspection rejects additional grants, namespaces, capabilities, mounts and resource changes', () => {
  const o = options();
  assert.doesNotThrow(() => verifyStableInspection(inspection(o), BOT, o, IMAGE_ID));
  const mutations: Array<(c: any) => void> = [
    c => { c.Id = 'replacement'; }, c => { c.Image = 'other-image'; },
    c => { c.Config.Env.push('CHESTNUT_MODEL_SOCKET=model.sock'); }, c => { c.Config.Env.push('OPENAI_API_KEY=fixture'); },
    c => { c.HostConfig.NetworkMode = 'host'; }, c => { c.HostConfig.PidMode = 'host'; }, c => { c.HostConfig.IpcMode = 'host'; },
    c => { c.HostConfig.Privileged = true; }, c => { c.HostConfig.CapAdd.push('SYS_ADMIN'); }, c => { c.HostConfig.SecurityOpt.push('seccomp=unconfined'); },
    c => { c.HostConfig.Memory = 0; }, c => { c.HostConfig.MemorySwap = -1; }, c => { c.HostConfig.PidsLimit = -1; }, c => { c.HostConfig.NanoCpus = 0; },
    c => { c.HostConfig.RestartPolicy.Name = 'always'; }, c => { c.HostConfig.AutoRemove = true; },
    c => { c.Mounts.push({ Type: 'bind', Source: '/fixture/private', Destination: '/run/chestnut', RW: false }); },
    c => { c.Mounts[0].Source = '/fixture/other-bot'; }, c => { c.Mounts[0].Propagation = 'shared'; },
  ];
  for (const mutate of mutations) {
    const c = inspection(o); mutate(c);
    assert.throws(() => verifyStableInspection(c, BOT, { ...o, expectedContainerId: 'fixture-container' }, IMAGE_ID));
  }
});

test('successful environment execution retains identity/rootfs and next task reuses the running service', async () => {
  const f = await fixture();
  try {
    const env = new StableEnvironment(BOT, f.o, f.docker);
    await env.ensureRunning();
    assert.equal((await env.execute('printf fixture')).stdout, 'fixture output');
    assert.equal(f.docker.current?.State.Running, true);
    await new StableEnvironment(BOT, { ...f.o, expectedContainerId: 'fixture-container', expectedImageId: IMAGE_ID }, f.docker).ensureRunning();
    assert.equal(f.docker.calls.filter(args => args[0] === 'create').length, 1);
    assert.equal(f.docker.calls.filter(args => args[1] === 'start').length, 1);
    await env.stop();
    assert.equal(f.docker.current?.State.Running, false);
    assert.equal(f.docker.current?.Id, 'fixture-container');
    assert.equal(f.docker.calls.some(args => args.includes('rm')), false);
  } finally { await f.cleanup(); }
});

test('saved rootfs identity prevents replacement, including missing-container recovery', async () => {
  const f = await fixture();
  try {
    const o = { ...f.o, expectedContainerId: 'saved-original', expectedImageId: IMAGE_ID };
    await assert.rejects(new StableEnvironment(BOT, o, f.docker).ensureRunning(), /missing/);
    assert.equal(f.docker.calls.some(args => args[0] === 'create'), false);
    f.docker.current = inspection(f.o, true);
    await assert.rejects(new StableEnvironment(BOT, o, f.docker).stop(), /identity/);
    assert.equal(f.docker.calls.some(args => args[1] === 'stop'), false);
  } finally { await f.cleanup(); }
});

test('revocation after creation forbids start while still allowing verified cleanup', async () => {
  const f = await fixture();
  try {
    let allowed = true;
    f.docker.afterCommand = args => { if (args[0] === 'create') allowed = false; };
    const env = new StableEnvironment(BOT, { ...f.o, canExecute: () => allowed }, f.docker);
    await assert.rejects(env.ensureRunning(), /grant closed/);
    assert.equal(f.docker.calls.some(args => args[1] === 'start' || args[0] === 'exec'), false);
    await env.stop();
    assert.equal(f.docker.current?.State.Running, false);
  } finally { await f.cleanup(); }
});

test('stale ownership blocks a stop after inspection', async () => {
  const f = await fixture();
  try {
    let held = true;
    f.docker.current = inspection(f.o, true);
    f.docker.afterCommand = args => { if (args[1] === 'inspect' && args[0] === 'container') held = false; };
    await assert.rejects(new StableEnvironment(BOT, { ...f.o, canMutate: () => held }, f.docker).stop(), /grant closed/);
    assert.equal(f.docker.calls.some(args => args[1] === 'stop'), false);
  } finally { await f.cleanup(); }
});

test('launch needs rootless resource enforcement but cleanup survives lost cgroups and retagged image', async () => {
  const f = await fixture();
  try {
    f.docker.resourceControls = false;
    await assert.rejects(new StableEnvironment(BOT, f.o, f.docker).ensureRunning(), /cgroup/);
    f.docker.current = inspection(f.o, true);
    f.docker.imageId = 'sha256:retagged-image';
    const previous = f.docker.calls.length;
    await new StableEnvironment(BOT, { ...f.o, expectedContainerId: 'fixture-container', expectedImageId: IMAGE_ID, canExecute: () => false }, f.docker).stop();
    assert.equal(f.docker.current.State.Running, false);
    assert.equal(f.docker.calls.slice(previous).some(args => args[0] === 'image'), false);
    f.docker.rootless = false;
    await assert.rejects(new StableEnvironment(BOT, f.o, f.docker).stop(), /rootless/);
  } finally { await f.cleanup(); }
});

test('stop completion is established from daemon state, not command success', async () => {
  const f = await fixture();
  try {
    f.docker.current = inspection(f.o, true); f.docker.keepRunning = true;
    await assert.rejects(new StableEnvironment(BOT, f.o, f.docker).stop(), /stop unverified/);
  } finally { await f.cleanup(); }
});

test('stable workspace symlink is rejected before Docker admission', async () => {
  const f = await fixture();
  try {
    const workspace = join(f.root, 'bots', BOT, 'workspace');
    await rm(workspace, { recursive: true });
    await mkdir(join(f.root, 'elsewhere')); await symlink(join(f.root, 'elsewhere'), workspace);
    await assert.rejects(new StableEnvironment(BOT, f.o, f.docker).ensureRunning(), /canonical/);
    assert.equal(f.docker.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('environment command size and timeout are checked before Docker execution', async () => {
  const docker = new FixtureDocker(options()), env = new StableEnvironment(BOT, options(), docker);
  for (const command of ['', ' ', 'x'.repeat(60001), '中'.repeat(20001)]) await assert.rejects(env.execute(command), /1-60000/);
  for (const timeout of [0, 99, 90001, 150.5, NaN]) await assert.rejects(env.execute('fixture', timeout), /100-90000/);
  assert.equal(docker.calls.length, 0);
});

test('malformed guest command results are rejected instead of normalized into healthy results', async () => {
  const o = options(), docker = new FixtureDocker(o); docker.current = inspection(o, true);
  const env = new StableEnvironment(BOT, o, docker);
  const valid = { stdout: '', stderr: '', code: 0, timedOut: false, truncated: false };
  for (const result of [null, { ...valid, code: {} }, { ...valid, code: 1.5 }, { ...valid, code: -1 }, { ...valid, timedOut: 'false' }, { ...valid, truncated: undefined }, { ...valid, stdout: 'x'.repeat(140001) }]) {
    docker.output = JSON.stringify(result);
    await assert.rejects(env.execute('fixture'), /Invalid environment command/);
  }
});

test('platform extension verifies unique tool names and exact owner paths against pinned Pi source metadata', async () => {
  const { registerEnvironmentTools, verifyEnvironmentTools } = await import(new URL('../src/environments/pi-extension.mjs', import.meta.url).href);
  const definitions: Array<{ name: string }> = [];
  registerEnvironmentTools({ registerTool: (definition: { name: string }) => definitions.push(definition) }, '/unused-fixture');
  assert.deepEqual(definitions.map(tool => tool.name).sort(), ['environment_bash', 'environment_computer', 'environment_edit', 'environment_fetch', 'environment_packages', 'environment_read', 'environment_write']);
  const owned = definitions.map(tool => ({ ...tool, sourceInfo: { path: '/opt/chestnut/environment-extension.mjs' } }));
  const pi = { getActiveTools: () => definitions.map(tool => tool.name), getAllTools: () => owned };
  assert.equal(verifyEnvironmentTools(pi, false).length, 7);
  assert.throws(() => verifyEnvironmentTools({ ...pi, getActiveTools: () => [...pi.getActiveTools(), 'bash'] }, false), /readiness/);
  assert.throws(() => verifyEnvironmentTools({ ...pi, getAllTools: () => owned.map(tool => ({ ...tool, sourceInfo: { path: 'builtin:bash' } })) }, false), /ownership/);
  assert.throws(() => verifyEnvironmentTools(pi, true), /readiness/);
  // Source contract only. The checked-in Pi bundle is not built here; this is not live Pi execution.
  const source = await readFile(new URL('../vendor/pi/packages/coding-agent/src/core/agent-session.ts', import.meta.url), 'utf8');
  assert.match(source, /getAllTools\(\): ToolInfo\[\]/);
  assert.match(source, /Array\.from\(this\._toolDefinitions\.values\(\)\)\.map\(\(\{ definition, sourceInfo \}\)/);
  const entry = await readFile(new URL('../src/sandbox/container-entry.mjs', import.meta.url), 'utf8');
  assert.match(entry, /'--no-tools', '--tools'/);
  assert.match(entry, /'--no-approve'/);
});

test('RPC readiness gate prevents prompt dispatch without environment-owned tools', async () => {
  const input: WorkerInput = { botId: BOT, taskId: 'task1', runId: 'run1', prompt: 'fixture', workspace: '/unused', sessionPath: '/unused/session.jsonl' };
  for (const ready of [false, true]) {
    const commands: string[] = [];
    let listener = (_line: string) => {};
    const transport: RpcTransport = {
      onLine: fn => { listener = fn; }, onClose() {}, async stop() {},
      async write(line) {
        const command = JSON.parse(line); commands.push(command.type);
        if (command.type === 'get_state' && ready) listener(JSON.stringify({ type: 'environment_ready', tools: ['environment_bash', 'environment_edit', 'environment_read', 'environment_write'] }));
        listener(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: command.type === 'prompt' ? { disposition: 'started' } : {} }));
        if (command.type === 'prompt') listener(JSON.stringify({ type: 'agent_settled', aborted: false }));
      },
    };
    const adapter = new PiRpcAdapter({ launch: async () => transport }, { requireEnvironmentReady: true });
    if (ready) await adapter.start(input, () => {});
    else await assert.rejects(adapter.start(input, () => {}), /did not become ready/);
    assert.equal(commands.includes('prompt'), ready);
    await adapter.dispose();
  }
});

interface WorkerFixtureOptions {
  healthy?: boolean;
  lockAvailable?: boolean;
  disposeFails?: boolean;
  runnerCleanupFails?: boolean;
  closeFails?: 'model' | 'memory' | 'environment';
  startFails?: boolean;
  cancelBeforeSettlement?: boolean;
  stopFails?: boolean;
  pendingPackageIntent?: boolean;
}
/** Calls one worker execution directly: no run loop, maintenance, model call, listener or Docker. */
async function workerFixture(settings: WorkerFixtureOptions = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'cn-service-worker-'));
  const c = config({ CHESTNUT_MODE: 'pi', CHESTNUT_SANDBOX_PROFILE: 'service', CHESTNUT_EXPERIMENTAL_SERVICE: '1', CHESTNUT_MEMORY_AUTOMATIC: '0', CHESTNUT_DATA_DIR: root, OPENAI_API_KEY: 'synthetic-not-a-credential' });
  c.gatewayRoot = join(root, 'fixture-brokers'); prepareStorage(c);
  const store = new Store(c.dbPath), bot = store.createBot('Synthetic service worker');
  const task = store.submit(bot.id, randomUUID(), 'Complete the synthetic fixture');
  const child = store.command(bot.id, task.id, randomUUID(), 'follow_up', 'Dependent fixture');
  const order: string[] = [];
  let stable: StableEnvironment | undefined, held = true;
  const runner: DockerCommandRunner = { async command() { throw new Error('Real Docker is forbidden in worker fixture'); }, attach() { throw new Error('Real Docker is forbidden in worker fixture'); } };
  const auth = new AuthManager(join(root, 'control', 'auth'));
  const close = async (kind: 'model' | 'memory' | 'environment') => { order.push(`${kind}-close`); if (settings.closeFails === kind) throw new Error(`Fixture ${kind} closure unverified`); };
  const worker = new Worker(store, c, () => ({
    async start(input, emit) {
      order.push('runner-start'); await stable!.ensureRunning();
      if (settings.pendingPackageIntent) new EnvironmentPolicies(store).beginPackage(bot.id, input.runId, randomUUID());
      if (settings.startFails) throw new Error('Fixture runner launch failed after stable environment start');
      emit({ type: 'command_dispatch', data: { command: 'prompt' } });
      emit({ type: 'response', data: { command: 'prompt', success: true, data: { disposition: 'started' } } });
      if (settings.cancelBeforeSettlement) store.command(bot.id, task.id, randomUUID(), 'cancel');
      emit({ type: 'message_end', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'fixture result' }], stopReason: 'stop' } } });
      emit({ type: 'agent_settled', data: { aborted: false } });
    },
    async steer() {}, async cancel() {},
    async dispose() { order.push('runner-dispose'); if (settings.disposeFails) throw new Error('Fixture runner disposal unverified'); },
  }), {
    acquireLock: async () => settings.lockAvailable === false ? null : { runner, isHeld: () => held, async release() { order.push('lock-release'); held = false; } },
    gateway: async () => ({ close: () => close('model') }),
    memoryBroker: async () => ({ close: () => close('memory') }),
    environmentBroker: async () => ({ isIdle: () => true, isHealthy: () => settings.healthy !== false, close: () => close('environment') }),
    cleanupEphemeral: async (_run, selectedRunner) => { assert.equal(selectedRunner, runner); order.push('runner-cleanup'); if (settings.runnerCleanupFails) throw new Error('Fixture runner removal unverified'); },
    stableEnvironment: (botId, o, selectedRunner) => {
      assert.equal(selectedRunner, runner);
      stable = new StableEnvironment(botId, o, runner);
      stable.ensureRunning = async () => { assert.equal(o.canExecute(), true); order.push('stable-start'); o.onEnvironment?.({ containerId: 'fixture-worker-container', imageId: IMAGE_ID, state: 'running' }); };
      stable.stop = async () => { assert.equal(o.canMutate(), true); assert.equal(o.canExecute(), false); order.push('stable-stop'); if (settings.stopFails) throw new Error('Fixture stable stop unverified'); o.onEnvironment?.({ containerId: 'fixture-worker-container', imageId: IMAGE_ID, state: 'stopped' }); };
      return stable;
    },
  });
  const internal = worker as unknown as { auth: AuthManager; execute(run: Run): Promise<void> };
  internal.auth = auth;
  const run = store.claim(worker.id); assert.ok(run);
  return { store, bot, task, child, order, execute: () => internal.execute(run), async cleanup() { await worker.stop(); auth.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('settled healthy service task keeps its root running only after runner and all brokers are cleaned', async () => {
  const f = await workerFixture();
  try {
    await f.execute();
    assert.equal(f.store.task(f.bot.id, f.task.id).state, 'succeeded');
    assert.equal(f.store.environment(f.bot.id)?.state, 'running');
    assert.equal(f.order.includes('stable-stop'), false);
    for (const operation of ['runner-dispose', 'runner-cleanup', 'model-close', 'memory-close', 'environment-close']) assert.ok(f.order.indexOf(operation) < f.order.indexOf('lock-release'));
    assert.equal(f.store.quarantines().length, 0);
  } finally { await f.cleanup(); }
});

test('unhealthy broker overrides model settlement, stops services and cancels dependent follow-ups', async () => {
  const f = await workerFixture({ healthy: false });
  try {
    await f.execute();
    assert.equal(f.store.task(f.bot.id, f.task.id).state, 'interrupted');
    assert.equal(f.store.task(f.bot.id, f.child.id).state, 'cancelled');
    assert.equal(f.store.environment(f.bot.id)?.state, 'stopped');
    assert.ok(f.order.indexOf('stable-stop') < f.order.indexOf('lock-release'));
  } finally { await f.cleanup(); }
});

test('runner cleanup uncertainty remains quarantined even after successful stable stop', async () => {
  for (const settings of [{ disposeFails: true }, { runnerCleanupFails: true }]) {
    const f = await workerFixture(settings);
    try {
      await f.execute();
      assert.ok(f.order.includes('stable-stop'));
      assert.equal(f.store.environment(f.bot.id)?.state, 'quarantined');
      assert.equal(f.store.quarantines().length, 1);
      assert.notEqual(f.store.task(f.bot.id, f.task.id).state, 'succeeded');
    } finally { await f.cleanup(); }
  }
});

test('each broker cleanup failure forces whole-environment stop and retains quarantine', async () => {
  for (const closeFails of ['model', 'memory', 'environment'] as const) {
    const f = await workerFixture({ closeFails });
    try {
      await f.execute();
      assert.ok(f.order.includes('stable-stop'));
      assert.ok(f.order.indexOf(`${closeFails}-close`) < f.order.indexOf('stable-stop'));
      assert.equal(f.store.environment(f.bot.id)?.state, 'quarantined');
      assert.equal(f.store.quarantines().length, 1);
    } finally { await f.cleanup(); }
  }
});

test('runner launch failure still cleans the disposable runner and stable environment', async () => {
  const f = await workerFixture({ startFails: true });
  try {
    await f.execute();
    assert.ok(f.order.includes('runner-cleanup')); assert.ok(f.order.includes('stable-stop'));
    assert.equal(f.store.task(f.bot.id, f.task.id).state, 'interrupted');
    assert.equal(f.store.task(f.bot.id, f.child.id).state, 'cancelled');
    assert.equal(f.store.environment(f.bot.id)?.state, 'stopped');
  } finally { await f.cleanup(); }
});

test('accepted cancellation arriving before cleanup cannot preserve successful services', async () => {
  const f = await workerFixture({ cancelBeforeSettlement: true });
  try {
    await f.execute();
    assert.ok(f.order.includes('stable-stop'));
    assert.equal(f.store.task(f.bot.id, f.task.id).state, 'cancelled');
    assert.equal(f.store.environment(f.bot.id)?.state, 'stopped');
  } finally { await f.cleanup(); }
});

test('failed OS lock acquisition never declares cleanup verified or runs a new environment', async () => {
  const f = await workerFixture({ lockAvailable: false });
  try {
    await f.execute();
    assert.equal(f.order.includes('runner-start'), false);
    assert.equal(f.order.includes('stable-stop'), false);
    assert.equal(f.store.environment(f.bot.id)?.state, 'quarantined');
    assert.equal(f.store.quarantines().length, 1);
  } finally { await f.cleanup(); }
});

test('stable stop not confirmed retains quarantine after runner cleanup succeeds', async () => {
  const f = await workerFixture({ startFails: true, stopFails: true });
  try {
    await f.execute();
    assert.ok(f.order.includes('runner-cleanup'));
    assert.equal(f.store.environment(f.bot.id)?.state, 'quarantined');
    assert.equal(f.store.quarantines().length, 1);
  } finally { await f.cleanup(); }
});

test('durable unresolved package intent remains quarantined even without an in-memory package callback', async () => {
  const f = await workerFixture({ pendingPackageIntent: true, healthy: false });
  try {
    await f.execute();
    assert.ok(f.order.includes('stable-stop'));
    assert.equal(f.store.task(f.bot.id, f.task.id).state, 'interrupted');
    assert.equal(f.store.quarantines().length, 1);
    assert.match(f.store.quarantines()[0]!.reason, /Operator package reconciliation required/);
    assert.equal(f.store.environment(f.bot.id)?.state, 'quarantined');
  } finally { await f.cleanup(); }
});

test('real Docker CAP_ canonicalization and separate tmpfs declaration preserve exact policy',()=>{
  const o={...options(),desktop:true},c:any=inspection(o);c.HostConfig.CapAdd=ENVIRONMENT_CAPABILITIES.map(cap=>'CAP_'+cap);c.HostConfig.Tmpfs={'/tmp':'rw,nosuid,nodev,size=268435456,mode=1777'};
  assert.doesNotThrow(()=>verifyStableInspection(c,BOT,o,IMAGE_ID));
  c.Mounts.push({Type:'tmpfs',Destination:'/tmp',RW:true});assert.doesNotThrow(()=>verifyStableInspection(c,BOT,o,IMAGE_ID));
  for(const change of [(x:any)=>x.HostConfig.CapAdd.push('CAP_SYS_ADMIN'),(x:any)=>x.HostConfig.CapAdd.push('CAP_CHOWN'),(x:any)=>x.HostConfig.Tmpfs['/tmp']='rw,size=1g',(x:any)=>x.Mounts.push({Type:'bind',Source:'/outside',Destination:'/run/chestnut',RW:true}),(x:any)=>x.Mounts[1].RW=false]){const altered=structuredClone(c);change(altered);assert.throws(()=>verifyStableInspection(altered,BOT,o,IMAGE_ID));}
});

test('desktop bootstrap stays fixed/root-local, screenshot stays UID1000/tmp, revocation stops second exec',async()=>{
  for(const revoke of [false,true]){let granted=true;const o={...options(),desktop:true,canMutate:()=>granted,canExecute:()=>granted},d=new FixtureDocker(o);d.current=inspection(o,true);(d.current.HostConfig as any).Tmpfs={'/tmp':'rw,nosuid,nodev,size=268435456,mode=1777'};const original=d.command.bind(d);d.command=async args=>{if(args[0]==='image')return JSON.stringify([{Id:IMAGE_ID,Config:{Labels:{'org.chestnut.pi.commit':PI_SOURCE_COMMIT,'org.chestnut.desktop':'1','org.chestnut.desktop.browser':'chromium'}}}]);const result=await original(args);if(revoke&&args.includes(DESKTOP_TMPFS_INIT))granted=false;return result;};const env=new StableEnvironment(BOT,o,d);if(revoke)await assert.rejects(env.desktopCommand('trusted-wrapper',{op:'screenshot'}),/closed/);else await env.desktopCommand('trusted-wrapper',{op:'screenshot'});const execs=d.calls.filter(a=>a[0]==='exec');assert.equal(execs.length,revoke?1:2);assert.equal(execs[0]![execs[0]!.indexOf('--user')+1],'0:0');assert.ok(execs[0]!.includes(DESKTOP_TMPFS_INIT));if(!revoke)assert.equal(execs[1]![execs[1]!.indexOf('--user')+1],'1000:1000');for(const args of execs)assert.equal(args[args.indexOf('--workdir')+1],'/tmp');}
});

test('actual service runner tool allowlist includes the registered computer tool',async()=>{
  const entry=await readFile(new URL('../src/sandbox/container-entry.mjs',import.meta.url),'utf8');const match=/const environmentTools = (.*);/.exec(entry);assert.ok(match);assert.match(match[1]!,/'environment_computer'/);assert.match(entry,/--no-tools/);
});
