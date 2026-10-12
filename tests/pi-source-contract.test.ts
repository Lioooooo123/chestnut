import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
const root=fileURLToPath(new URL('../',import.meta.url));
test('complete official Pi source checksum and pinned model catalog are reproducible',()=>{
  const output=execFileSync(process.execPath,['scripts/pi-verify-source.mjs'],{cwd:root,encoding:'utf8'});
  assert.match(output,/Verified 2029 files/);
  const manifest=JSON.parse(readFileSync(join(root,'vendor/pi-source-manifest.json'),'utf8'));
  assert.equal(manifest.commit,'4270522473e677ddba7b093caa0064a3df51d459');
  assert.ok(manifest.files.some((file:{path:string})=>file.path==='LICENSE'));
});
test('actual Pi imports resolve to vendored source, without registry runtime fallback',{
  skip:!existsSync(join(root,'vendor/pi/node_modules/typescript')) ? 'Run npm ci --ignore-scripts in vendor/pi before source-runtime contracts' : false,
},()=>{
  execFileSync(process.execPath,['scripts/pi-check-resolutions.mjs'],{cwd:root,encoding:'utf8'});
  const output=execFileSync(process.execPath,['--import','./vendor/pi/packages/coding-agent/src/experimental/source-resolver.ts','--input-type=module','--eval',"console.log(import.meta.resolve('@earendil-works/pi-agent-core'));console.log(import.meta.resolve('@earendil-works/pi-coding-agent'));console.log(import.meta.resolve('@earendil-works/pi-ai'));"],{cwd:root,encoding:'utf8'});
  assert.match(output,/vendor\/pi\/packages\/agent\/src\/index.ts/);
  assert.match(output,/vendor\/pi\/packages\/coding-agent\/src\/index.ts/);
  assert.match(output,/vendor\/pi\/packages\/ai\/src\/index.ts/);
});
