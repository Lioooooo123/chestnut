import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { existsSync, lstatSync, realpathSync, readFileSync, readdirSync } from 'node:fs';
const args=process.argv.slice(2);let dataDir=resolve('.chestnut-demo'),port='4310',delay='10000';
for(let i=0;i<args.length;i++){
  if(args[i]==='--help'){console.log('npm run demo:ui -- [--data-dir /private/demo/path] [--port 4310] [--delay-ms 10000]. Explicit simulated mode: separate API/Worker, persistent demo SQLite, loopback only, no model, shell, Docker, channel or external Node network. No .env is loaded.');process.exit(0);}
  const flag=args[i];if(!['--data-dir','--port','--delay-ms'].includes(flag)||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Use --help for demo options');const value=args[++i];if(flag==='--data-dir')dataDir=resolve(value);else if(flag==='--port')port=value;else delay=value;
}
let ancestor=dataDir;while(!existsSync(ancestor)){const parent=dirname(ancestor);if(parent===ancestor)throw new Error('Invalid demo directory');ancestor=parent;}
if(realpathSync(ancestor)!==ancestor||lstatSync(ancestor).isSymbolicLink())throw new Error('Choose a canonical demo path without symlink ancestors');
if(existsSync(dataDir)){
  if(!lstatSync(dataDir).isDirectory())throw new Error('Demo data path must be a directory');
  const marker=join(dataDir,'control','runtime-mode');
  if(existsSync(marker)?readFileSync(marker,'utf8')!=='demo:ephemeral':readdirSync(dataDir).length!==0)throw new Error('Refusing non-demo or unrecognized data. Choose a new dedicated demo directory');
}
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CHESTNUT_')&&!/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|BOT_TOKEN)$/.test(key)));
Object.assign(env,{CHESTNUT_MODE:'demo',CHESTNUT_SANDBOX_PROFILE:'ephemeral',CHESTNUT_DATA_DIR:dataDir,CHESTNUT_HOST:'127.0.0.1',CHESTNUT_PORT:port,CHESTNUT_DEMO_DELAY_MS:delay,CHESTNUT_MEMORY_AUTOMATIC:'0',CHESTNUT_TELEGRAM_ENABLED:'0',NODE_OPTIONS:`--import=${new URL('./test-no-network.mjs',import.meta.url).href}`});
console.log(`EXPLICIT DEMO: simulated tasks, no AI/tool/shell/container or external requests. State stays in ${dataDir}. Ctrl+C stops the API and separate Worker; restart the same command to reopen history.`);
const child=spawn(process.execPath,['src/cli.ts','dev'],{cwd:new URL('../',import.meta.url),env,stdio:'inherit',shell:false});
process.once('SIGINT',()=>child.kill('SIGINT'));process.once('SIGTERM',()=>child.kill('SIGTERM'));child.once('error',error=>{console.error(error.message);process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??1;});
