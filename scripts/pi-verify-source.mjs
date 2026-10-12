import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../vendor/pi/', import.meta.url));
const manifestPath = fileURLToPath(new URL('../vendor/pi-source-manifest.json', import.meta.url));
const ignored = new Set(['node_modules', 'dist', '.artifacts', '.git']);
async function entries(dir, prefix = '') {
  const result = [];
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (ignored.has(item.name)) continue;
    const path = join(dir, item.name); const relative = prefix + item.name;
    if (relative === 'packages/ai/src/providers/data') continue;
    if (item.isDirectory()) result.push(...await entries(path, relative + '/'));
    else if (item.isFile()) result.push({ path: relative, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
    else throw new Error(`Unexpected source entry: ${relative}`);
  }
  return result;
}
const current = await entries(root);
if (process.argv.includes('--record')) {
  await writeFile(manifestPath, JSON.stringify({ repository: 'https://github.com/earendil-works/pi', commit: '4270522473e677ddba7b093caa0064a3df51d459', archiveSha256: '5482b14cc3b0c0d8cb20c7d42c384fae2af1538b52e3a69aa75db9cd181b9788', files: current }, null, 2) + '\n');
  console.log(`Recorded ${current.length} source files.`);
} else {
  const expected = JSON.parse(await readFile(manifestPath, 'utf8'));
  const actual = new Map(current.map(file => [file.path,file.sha256]));
  const mismatches = expected.files.filter(file => actual.get(file.path) !== file.sha256).map(file => file.path);
  if (mismatches.length || current.length !== expected.files.length) throw new Error(`Pi source differs from pinned manifest: ${mismatches.join(', ')}. Source changes must be reviewed and provenance re-recorded deliberately.`);
  console.log(`Verified ${current.length} files at ${expected.commit}; license retained.`);
}
