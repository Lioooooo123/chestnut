import { preflight } from '../src/deployment/preflight.ts';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i++){
  const arg=args[i];
  if(arg==='--help'){console.log('Read-only: npm run preflight -- [--offline] [--docker] [--data-dir /new/path] [--image existing-image]. No directories, database, containers, installs or public listeners are created.');process.exit(0);}
  if(arg==='--offline')options.offline=true;
  else if(arg==='--docker')options.docker=true;
  else if(arg==='--data-dir'||arg==='--image'){if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing ${arg} value`);options[arg==='--image'?'image':'dataDir']=args[++i];}
  else throw new Error(`Unknown option ${arg}`);
}
const report=await preflight(options);console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
