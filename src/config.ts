import { resolve, join } from 'node:path';
import { mkdirSync, chmodSync, lstatSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
export interface Config { mode: 'demo'|'pi'; sandboxProfile:'ephemeral'|'persistent'|'service'; root: string; dbPath: string; sandboxRoot: string; gatewayRoot: string; host: string; port: number; model: string; image: string; apiKey: string|undefined; apiKeyConfigured?:boolean; memoryAutomatic?: boolean; memoryDailyCalls?: number; demoDelayMs?:number; }
export function config(env=process.env): Config {
  const mode=env.CHESTNUT_MODE ?? 'demo'; if(mode!=='demo' && mode!=='pi')throw new Error('CHESTNUT_MODE must be demo or pi');
  const sandboxProfile=env.CHESTNUT_SANDBOX_PROFILE ?? 'ephemeral';
  if(sandboxProfile!=='ephemeral'&&sandboxProfile!=='persistent'&&sandboxProfile!=='service')throw new Error('Unknown sandbox profile');
  if(sandboxProfile==='persistent' && (mode!=='pi'||env.CHESTNUT_EXPERIMENTAL_PERSISTENT!=='1'))throw new Error('Persistent root requires Pi mode and explicit CHESTNUT_EXPERIMENTAL_PERSISTENT=1; live verification is pending');
  if(sandboxProfile==='service' && (mode!=='pi'||env.CHESTNUT_EXPERIMENTAL_SERVICE!=='1'))throw new Error('Service profile requires Pi mode and CHESTNUT_EXPERIMENTAL_SERVICE=1; live verification pending');
  if(env.CHESTNUT_NETWORK_POLICY && env.CHESTNUT_NETWORK_POLICY!=='none')throw new Error('Governed installation/maintenance networking is not yet available; only none is supported');
  const host=env.CHESTNUT_HOST ?? '127.0.0.1';
  if (!['127.0.0.1','::1'].includes(host) || !isIP(host)) throw new Error('V1 API binds only 127.0.0.1 or ::1; remote exposure is not supported');
  const port=Number(env.CHESTNUT_PORT ?? 4310); if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
  if (env.CHESTNUT_MEMORY_AUTOMATIC && !['0','1'].includes(env.CHESTNUT_MEMORY_AUTOMATIC)) throw new Error('CHESTNUT_MEMORY_AUTOMATIC must be 0 or 1');
  const memoryDailyCalls = Number(env.CHESTNUT_MEMORY_DAILY_CALLS ?? 24);
  if (!Number.isInteger(memoryDailyCalls) || memoryDailyCalls < 1 || memoryDailyCalls > 200) throw new Error('CHESTNUT_MEMORY_DAILY_CALLS must be 1-200');
  const root=resolve(env.CHESTNUT_DATA_DIR ?? '.chestnut');
  const demoDelayMs=Number(env.CHESTNUT_DEMO_DELAY_MS??2500);if(!Number.isInteger(demoDelayMs)||demoDelayMs<100||demoDelayMs>60000)throw new Error('CHESTNUT_DEMO_DELAY_MS must be 100-60000');
  return {demoDelayMs,memoryAutomatic: env.CHESTNUT_MEMORY_AUTOMATIC !== '0',memoryDailyCalls,mode,sandboxProfile,root,dbPath:join(root,'control','chestnut.sqlite'),sandboxRoot:join(root,'sandbox'),gatewayRoot:sandboxProfile!=='ephemeral'?join('/tmp',`cn-${createHash('sha256').update(root).digest('hex').slice(0,12)}`):join(root,'gateways'),host,port,model:env.CHESTNUT_MODEL ?? 'gpt-4o-mini',image:env.CHESTNUT_IMAGE ?? 'chestnut-pi:4270522473e6',apiKeyConfigured:!!env.OPENAI_API_KEY||env.CHESTNUT_API_KEY_CONFIGURED==='1',apiKey:env.OPENAI_API_KEY};
}
export function prepareStorage(c: Config) {
  for(const dir of [c.root,join(c.root,'control'),c.sandboxRoot,c.gatewayRoot]) {
    mkdirSync(dir,{recursive:true,mode:0o700}); if(process.getuid && lstatSync(dir).uid!==process.getuid())throw new Error('Data/gateway directory must belong to the worker OS user'); if(lstatSync(dir).isSymbolicLink())throw new Error('Data directories must not be symlinks');
    if(realpathSync(dir)!==resolve(dir))throw new Error('Data path ancestors must not be symlinks');
    chmodSync(dir,0o700);
  }
  const modePath=join(c.root,'control','runtime-mode');
  try { writeFileSync(modePath,`${c.mode}:${c.sandboxProfile}`,{flag:'wx',mode:0o600}); } catch(e) { if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e; if(readFileSync(modePath,'utf8')!==`${c.mode}:${c.sandboxProfile}`)throw new Error('Do not mix demo, Pi or sandbox-profile state directories; set a separate CHESTNUT_DATA_DIR'); }
}

