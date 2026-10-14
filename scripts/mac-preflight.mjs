import { macPreflight } from '../src/deployment/mac-preflight.ts';
const options={},args=process.argv.slice(2);
for(let i=0;i<args.length;i++){
  if(args[i]==='--help'){console.log('Read-only existing Colima inspection: npm run mac:preflight -- [--profile default] [--image existing-image]. Never starts/creates a VM, installs software, changes Docker context, opens ports, reads model credentials or creates runtime state. Guest checks only run when the existing VM reports running.');process.exit(0);}
  if(!['--profile','--image'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Use --help for options');options[args[i].slice(2)]=args[++i];
}
const report=await macPreflight(options);console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
