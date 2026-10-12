import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|BOT_TOKEN)$/.test(key)));
env.NODE_OPTIONS=`--import=${new URL('./test-no-network.mjs',import.meta.url).href}`;
env.CHESTNUT_MEMORY_AUTOMATIC='0';env.CHESTNUT_TELEGRAM_ENABLED='0';env.PI_OFFLINE='1';
const steps=[['node',['scripts/pi-verify-source.mjs']],['node',['scripts/pi-check-resolutions.mjs']],['npm',['run','check']],['npm',['run','demo']]];
for(const [program,args] of steps){
  console.log(`Offline acceptance: ${program} ${args.join(' ')}`);
  const code=await new Promise((resolve,reject)=>{const child=spawn(program,args,{cwd:root,env,stdio:'inherit',shell:false});child.on('error',reject);child.on('close',value=>resolve(value??1));});
  if(code!==0){process.exitCode=code;break;}
}
console.log('Live Docker, Linux locks on non-Linux hosts, signed packages, model inference and Telegram remain NOT RUN. This entry installs nothing and changes only temporary fixtures.');
