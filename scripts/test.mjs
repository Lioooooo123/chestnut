import { spawn } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = readdirSync(new URL('../tests/', import.meta.url))
  .filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
// macOS exposes system temporary directories through /var and /tmp aliases.
// Choose their canonical base before fixtures are created; runtime path checks stay strict.
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...tests, 'web/dashboard.test.cjs'], {
  cwd: root, env: { ...process.env, TMPDIR: realpathSync(tmpdir()) }, stdio: 'inherit', shell: false,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
