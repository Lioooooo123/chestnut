import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RootlessDockerBackend, type RootlessDockerOptions } from '../sandbox/rootless-docker.ts';
import type { SandboxBackend, WorkerInput, RpcTransport } from '../pi/types.ts';
import type { StableEnvironment } from './stable-docker.ts';
/** The model runner gets a private scratch workspace; it never shares a PID namespace or broker mount with services. */
export class ServiceBackend implements SandboxBackend {
  private readonly environment:StableEnvironment;private readonly options:RootlessDockerOptions;
  constructor(environment:StableEnvironment,options:RootlessDockerOptions){this.environment=environment;this.options=options;}
  async launch(input:WorkerInput):Promise<RpcTransport>{
    await this.environment.ensureRunning();
    const dataRoot=join(this.options.dataRoot,'runners',input.runId),workspace=join(dataRoot,'bots',input.botId,'workspace'),sessionPath=join(dataRoot,'sessions',input.taskId,'session.jsonl');
    await mkdir(workspace,{recursive:true,mode:0o700});await mkdir(join(dataRoot,'sessions',input.taskId),{recursive:true,mode:0o700});
    return new RootlessDockerBackend({...this.options,dataRoot,environmentBroker:true}).launch({...input,workspace,sessionPath});
  }
}
