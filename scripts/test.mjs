import { spawn } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = readdirSync(new URL('../tests/', import.meta.url))
  .filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
// macOS exposes system temporary directories through /var and /tmp aliases.
// Choose their canonical base before fixtures are created; runtime path checks stay strict.
const safeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|BOT_TOKEN)$/.test(name)));
const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./test-no-network.mjs', import.meta.url)), '--test', '--test-concurrency=1', ...tests, 'web/dashboard.test.cjs'], {
  cwd: root, env: { ...safeEnvironment, NODE_OPTIONS: `--import=${new URL('./test-no-network.mjs', import.meta.url).href}`, TMPDIR: realpathSync(tmpdir()) }, stdio: 'inherit', shell: false,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
