import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { config, prepareStorage } from './config.ts';
import { Store } from './store.ts';
import { createApi } from './api.ts';
import { Worker } from './worker.ts';
import { assertRootless,assertResourceControls } from './sandbox/rootless-docker.ts';
const c=config();prepareStorage(c);
const command=process.argv[2] ?? 'dev';
if(command==='doctor'){
  console.log(`Chestnut ${c.mode}/${c.sandboxProfile} mode; Node ${process.version}; storage ${c.root}`);
  const s=new Store(c.dbPath);console.log('SQLite WAL ready; quarantined runs:',s.quarantines().length);s.close();
  try{const {stdout}=await promisify(execFile)('docker',['info','--format','{{json .}}'],{timeout:10000});const info=JSON.parse(stdout);assertRootless(info);assertResourceControls(info);console.log('Rootless Docker and resource-control preflight verified');}catch(e){console.log(`Live Pi isolation unavailable: ${e instanceof Error?e.message:String(e)}`);if(c.mode==='pi')process.exitCode=1;}
  console.log(c.apiKey?'Outer worker model credential configured (not displayed)':'No model credential configured; demo is available');
}else if(command==='dev'){
  const entry=fileURLToPath(import.meta.url);
  const children=['api','worker'].map(role=>spawn(process.execPath,[entry,role],{stdio:'inherit',env:role==='api'?{...process.env,OPENAI_API_KEY:undefined}:process.env}));
  let ending=false;
  const stop=()=>{if(ending)return;ending=true;for(const child of children)child.kill('SIGTERM');};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  for(const child of children)child.on('exit',code=>{if(!ending){process.exitCode=code || 1;stop();}});
}else if(command==='api'){
  const s=new Store(c.dbPath),server=createApi(s,c);
  server.listen(c.port,c.host,()=>console.log(`Chestnut dashboard http://${c.host==='::1'?'[::1]':c.host}:${c.port} (${c.mode})`));
  const close=()=>server.close(()=>{s.close();process.exitCode=0;});process.once('SIGINT',close);process.once('SIGTERM',close);
}else if(command==='worker'){
  const s=new Store(c.dbPath),worker=new Worker(s,c);
  process.once('SIGINT',()=>void worker.stop());process.once('SIGTERM',()=>void worker.stop());
  console.log(`Chestnut worker ${worker.id} (${c.mode}, concurrency 1)`);
  try{await worker.run();}finally{s.close();}
}else{throw new Error('Usage: node src/cli.ts dev|api|worker|doctor');}
