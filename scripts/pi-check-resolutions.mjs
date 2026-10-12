import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../vendor/pi/',import.meta.url));
const lock = JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'));
let count=0;
for (const [path,value] of Object.entries(lock.packages)) {
  if (!/(?:^|\/)node_modules\/@earendil-works\/(?:pi-[^/]+|chord)$/.test(path)) continue;
  if (value.link !== true || !/^(packages|apps)\//.test(value.resolved)) throw new Error(`Registry/mixed Pi dependency: ${path}`);
  const target=realpathSync(join(root,path));
  if (!target.startsWith(join(root,'packages')+'/') && !target.startsWith(join(root,'apps')+'/')) throw new Error(`Pi package leaves source tree: ${path}`);
  count++;
}
if (count<10) throw new Error('Incomplete Pi workspace dependency graph');
console.log(`Verified ${count} local Pi package links; zero registry Pi package resolutions.`);
