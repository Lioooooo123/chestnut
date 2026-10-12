import { randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from './store.ts';
import { type Config } from './config.ts';
import { type Run } from './types.ts';
import { FakeAdapter } from './pi/fake-adapter.ts';
import { PiRpcAdapter } from './pi/rpc-adapter.ts';
import { RootlessDockerBackend, cleanupStaleContainer } from './sandbox/rootless-docker.ts';
import { type WorkerAdapter, type WorkerEvent } from './pi/types.ts';
import { PersistentDockerBackend,cleanupPersistentBot,type PersistentCleanupOptions } from './sandbox/persistent-docker.ts';
import { acquireEnvironmentLock,type EnvironmentLock } from './control/environment-lock.ts';
import { startModelGateway } from './gateway/index.ts';
import { AuthManager } from './auth.ts';
import { MemoryRepository } from './memory/repository.ts';
import { MemoryMaintenance } from './memory/maintenance.ts';
import { memoryContext } from './memory/context.ts';
import { Scheduler } from './schedules.ts';
import { EnvironmentPolicies } from './environments/policy.ts';
import { cleanupPackageDownloaders, installGovernedPackages } from './environments/packages.ts';
import { governedFetch } from './environments/network.ts';
import { StableEnvironment } from './environments/stable-docker.ts';
import { ServiceBackend } from './environments/service-backend.ts';
import { startEnvironmentBroker } from './environments/broker.ts';
import { startMemoryBroker } from './memory/broker.ts';

export interface WorkerDependencies { acquireLock?:typeof acquireEnvironmentLock; gateway?:typeof startModelGateway; memoryBroker?: typeof startMemoryBroker; cleanupPersistent?:typeof cleanupPersistentBot; environmentBroker?:typeof startEnvironmentBroker; stableEnvironment?:(botId:string,options:ConstructorParameters<typeof StableEnvironment>[1],runner:ConstructorParameters<typeof StableEnvironment>[2])=>StableEnvironment; cleanupEphemeral?:typeof cleanupStaleContainer }
export type AdapterFactory = (run: Run, gatewayDirectory: string) => WorkerAdapter;
export class Worker {
  readonly id=randomUUID();
  private stopping=false;
  private active?:WorkerAdapter;
  private auth?:AuthManager;
  private maintenance?: MemoryMaintenance;
  private maintenanceWork?: Promise<void>;
  private readonly store:Store;
  private readonly c:Config;
  private readonly factory?:AdapterFactory;
  private readonly deps:WorkerDependencies;
  constructor(store:Store,c:Config,factory?:AdapterFactory,deps:WorkerDependencies={}){this.store=store;this.c=c;this.factory=factory;this.deps=deps;}
  async stop(){this.stopping=true;this.maintenance?.stop();await this.active?.cancel().catch(()=>{});}
  async run(){
    this.auth=new AuthManager(join(this.c.root,'control','auth'));
    this.maintenance = new MemoryMaintenance(this.store,this.c);
    const maintain = () => {
      if (this.stopping || this.maintenanceWork) return;
      this.maintenanceWork = this.maintenance!.tick().catch(() => console.error('Memory maintenance unavailable; foreground tasks remain available.')).finally(() => { this.maintenanceWork = undefined; });
    };
    const scheduler=new Scheduler(this.store);
    const schedulerTimer=setInterval(()=>{try{scheduler.tick();}catch{console.error('Schedule tick failed; persisted fires will be reconciled.');}},1000);
    const maintenanceTimer = setInterval(maintain,2000);
    const heartbeat=setInterval(()=>this.store.heartbeat(this.id),2000);
    this.store.heartbeat(this.id);
    try{
      while(!this.stopping){
        this.store.recover();
        const quarantines=this.store.quarantines();
        for(const q of quarantines){
          await this.recoverQuarantine(q);
        }
        await this.processEnvironmentStops();
        const run=this.store.claim(this.id);
        if(run){await this.execute(run);maintain();}else await sleep(quarantines.length?2000:200);
      }
    }finally{clearInterval(schedulerTimer);clearInterval(maintenanceTimer);this.maintenance.stop();await this.maintenanceWork;clearInterval(heartbeat);this.store.heartbeat(this.id,Date.now(),0);}
  }
  private async processEnvironmentStops(){
    if(this.c.sandboxProfile!=='service')return;const policies=new EnvironmentPolicies(this.store);
    for(const request of policies.pendingStops()){
      let lock:EnvironmentLock|null=null;
      try{lock=await (this.deps.acquireLock??acquireEnvironmentLock)(join(this.c.root,'control','os-locks'),request.botId);if(!lock)continue;
        const current=policies.stopStatus(request.botId);if(current?.requestId!==request.requestId||current.state!=='pending'){await lock.release();lock=null;continue;}
        const env=this.store.environment(request.botId);
        if(env?.containerId)await new StableEnvironment(request.botId,{dataRoot:this.c.sandboxRoot,image:this.c.image,expectedContainerId:env.containerId,expectedImageId:env.imageId,canMutate:()=>!!lock?.isHeld(),canExecute:()=>false,onEnvironment:state=>this.store.observeEnvironment(request.botId,state)},lock.runner).stop();
        await lock.release();lock=null;policies.finishStop(request.botId,request.requestId);
      }catch(error){policies.finishStop(request.botId,request.requestId,String(error));}finally{if(lock)await lock.release().catch(()=>{});}
    }
  }
  private persistentOptions(botId:string,canMutate:()=>boolean):PersistentCleanupOptions {
    const env=this.store.environment(botId);
    return {dataRoot:this.c.sandboxRoot,gatewayDirectory:join(this.c.gatewayRoot,botId),image:this.c.image,canMutate,
      expectedContainerId:env?.containerId,expectedImageId:env?.imageId,
      onEnvironment:state=>{if(!canMutate())throw new Error('Stale environment observation rejected');this.store.observeEnvironment(botId,state);}};
  }
  private async recoverQuarantine(q:{runId:string;botId:string;taskId:string;reason?:string}){
    const policies=new EnvironmentPolicies(this.store),packageOperations=policies.packageState(q.runId);
    if(packageOperations.length&&packageOperations.every(item=>item.state==='contained')&&q.reason?.startsWith('Operator package reconciliation required:'))return;
    let lock:EnvironmentLock|null=null;
    try{
      if(this.c.mode==='pi'&&this.c.sandboxProfile==='persistent'){
        lock=await (this.deps.acquireLock ?? acquireEnvironmentLock)(join(this.c.root,'control','os-locks'),q.botId);
        if(!lock){this.store.noteQuarantine(q.runId,'A previous worker still owns this bot environment OS lock');return;}
        const options=this.persistentOptions(q.botId,()=>!!lock?.isHeld()&&this.store.quarantines().some(item=>item.runId===q.runId));
        await (this.deps.cleanupPersistent ?? cleanupPersistentBot)(q,options,lock.runner);
        await lock.release();lock=null;
      }else if(this.c.mode==='pi'&&this.c.sandboxProfile==='service'){
        lock=await (this.deps.acquireLock??acquireEnvironmentLock)(join(this.c.root,'control','os-locks'),q.botId);if(!lock){this.store.noteQuarantine(q.runId,'Stable environment OS lock unavailable');return;}
        await (this.deps.cleanupEphemeral??cleanupStaleContainer)(q,lock.runner);
        const env=this.store.environment(q.botId);
        if(env?.imageId)await cleanupPackageDownloaders({botId:q.botId,runId:q.runId,expectedImageId:env.imageId,canMutate:()=>!!lock?.isHeld()},lock.runner);
        await new StableEnvironment(q.botId,{dataRoot:this.c.sandboxRoot,image:this.c.image,expectedContainerId:env?.containerId,expectedImageId:env?.imageId,canMutate:()=>!!lock?.isHeld(),canExecute:()=>false,onEnvironment:state=>this.store.observeEnvironment(q.botId,state)},lock.runner).stop();
        await lock.release();lock=null;
      }else if(this.c.mode==='pi')await cleanupStaleContainer(q);
      if(packageOperations.length){policies.containPackages(q.runId);this.store.noteQuarantine(q.runId,'Operator package reconciliation required: a previous package import/install did not durably complete. Environment is stopped; inspect package state, then explicitly confirm reconciliation.');return;}
      this.store.clearQuarantine(q.runId);
    }catch(e){this.store.noteQuarantine(q.runId,e instanceof Error?e.message:String(e));}
    finally{if(lock)try{await lock.release();}catch(e){this.store.noteQuarantine(q.runId,e instanceof Error?e.message:String(e));}}
  }
  private async execute(run:Run){
    let environmentLock:EnvironmentLock|null=null;
    let persistentOptions:PersistentCleanupOptions|undefined;
    let stableEnvironment:StableEnvironment|undefined;
    let environmentBroker:Awaited<ReturnType<typeof startEnvironmentBroker>>|undefined;
    let keepEnvironment=false;
    let packageQuarantine:string|undefined;
    let gateway:Awaited<ReturnType<typeof startModelGateway>>|undefined;
    let memoryBroker: Awaited<ReturnType<typeof startMemoryBroker>> | undefined;
    let adapter:WorkerAdapter|undefined;
    let commandTimer:ReturnType<typeof setInterval>|undefined;
    let commandWork:Promise<void>|undefined;
    let cancelWork:Promise<void>|undefined;
    let promptMayHaveStarted=false,settled=false;
    let ready=false,accepting=true,leaseLost=false,result:string|null=null,error:string|null=null,aborted=false,modelError=false,cleanupConfirmed=this.c.sandboxProfile==='ephemeral';
    let heartbeat:ReturnType<typeof setInterval>|undefined;
    try{
      const authStatus=this.auth!.status();
      const apiProtocol: 'responses'|'chat-completions'=authStatus.preferred||authStatus.connected?'responses':'chat-completions';
      const grant=this.c.mode==='pi'&&apiProtocol==='responses'?this.auth!.grant():undefined;
      const model=grant?(grant.model??this.c.model):this.c.model;
      if(this.c.mode==='pi'){if(grant)await grant.apiKey();else if(!this.c.apiKey)throw new Error('Sign in with ChatGPT or configure an outer worker API key before running real tasks');}
      this.store.ensureEnvironment(run.botId,this.c.sandboxProfile);
      if(this.c.sandboxProfile==='persistent'){
        environmentLock=await (this.deps.acquireLock ?? acquireEnvironmentLock)(join(this.c.root,'control','os-locks'),run.botId);
        if(!environmentLock)throw new Error('Persistent environment OS lock is already owned; cleanup is unverified');
        persistentOptions=this.persistentOptions(run.botId,()=>!!environmentLock?.isHeld()&&this.store.isCurrent(run));
        // Revoke any surviving old guest before publishing a new model socket.
        await (this.deps.cleanupPersistent ?? cleanupPersistentBot)(run,persistentOptions,environmentLock.runner);
        persistentOptions=this.persistentOptions(run.botId,()=>!!environmentLock?.isHeld()&&this.store.isCurrent(run));
      }
      if(this.c.sandboxProfile==='service'){environmentLock=await (this.deps.acquireLock??acquireEnvironmentLock)(join(this.c.root,'control','os-locks'),run.botId);if(!environmentLock)throw new Error('Stable environment OS lock unavailable');}
      this.store.setEnvironmentState(run.botId,'starting');
      const workspace=join(this.c.sandboxRoot,'bots',run.botId,'workspace');
      const sessionDir=join(this.c.sandboxRoot,'sessions',run.taskId);
      const gatewayDirectory=join(this.c.gatewayRoot,this.c.sandboxProfile==='persistent'?run.botId:run.id);
      const gatewaySocketName=this.c.sandboxProfile==='persistent'?`${run.id}.sock`:'model.sock';
      for(const path of [workspace,sessionDir,gatewayDirectory]){
        await mkdir(path,{recursive:true,mode:0o700});
        if((await lstat(path)).isSymbolicLink()||await realpath(path)!==resolve(path))throw new Error('Unsafe sandbox path');
      }
      if(this.c.sandboxProfile==='service'){
        const env=this.store.environment(run.botId),options={dataRoot:this.c.sandboxRoot,image:this.c.image,expectedContainerId:env?.containerId,expectedImageId:env?.imageId,canMutate:()=>!!environmentLock?.isHeld(),canExecute:()=>accepting&&!this.stopping&&this.store.mayExecute(run)&&(!grant||grant.isCurrent())&&!!environmentLock?.isHeld(),onEnvironment:(state:Parameters<Store['observeEnvironment']>[1])=>this.store.observeEnvironment(run.botId,state)};
        stableEnvironment=this.deps.stableEnvironment?.(run.botId,options,environmentLock!.runner)??new StableEnvironment(run.botId,options,environmentLock!.runner);
        environmentBroker=await (this.deps.environmentBroker??startEnvironmentBroker)({socketPath:join(gatewayDirectory,'environment.sock'),environment:stableEnvironment,authorize:options.canExecute,installPackages:async(packages,requestId)=>{
          const policies=new EnvironmentPolicies(this.store),policy=policies.get(run.botId),env=this.store.environment(run.botId);if(!env?.containerId||!env.imageId)throw new Error('Stable environment identity is not ready');
          const result=await installGovernedPackages({botId:run.botId,runId:run.id,requestId,dataRoot:this.c.sandboxRoot,image:this.c.image,expectedContainerId:env.containerId,expectedImageId:env.imageId,allowedPackages:policy.allowedPackages,requestedPackages:packages,canMutate:options.canMutate,canExecute:()=>options.canExecute()&&policies.get(run.botId).revision===policy.revision,onBeforeImport:()=>policies.beginPackage(run.botId,run.id,requestId),onQuarantine:reason=>{packageQuarantine=reason;policies.packageNeedsReview(run.botId,run.id,requestId,reason);}},environmentLock!.runner);
          policies.completePackage(requestId);this.store.appendRunEvent(run,'environment.packages.installed',result);return result;
        },fetchUrl:async(url)=>{const policies=new EnvironmentPolicies(this.store),policy=policies.get(run.botId);return governedFetch(url,policy.allowedHosts,()=>options.canExecute()&&policies.get(run.botId).revision===policy.revision);},onEvent:(type,data)=>this.store.appendRunEvent(run,type,data)});
      }
      if(this.c.mode==='pi')gateway=await (this.deps.gateway ?? startModelGateway)({socketPath:join(gatewayDirectory,gatewaySocketName),apiKey:apiProtocol==='responses'?undefined:this.c.apiKey,getApiKey:grant?signal=>grant.apiKey(signal):undefined,apiProtocol,model,authorize:()=>this.store.mayExecute(run)&&!this.stopping&&(!grant||grant.isCurrent())&&(!environmentLock||environmentLock.isHeld())});
      adapter=this.factory?.(run,gatewayDirectory) ?? (this.c.mode==='demo'?new FakeAdapter({delayMs:this.c.demoDelayMs??2500}):new PiRpcAdapter(stableEnvironment?new ServiceBackend(stableEnvironment,{dataRoot:this.c.sandboxRoot,gatewayDirectory,model,apiProtocol,image:this.c.image,runner:environmentLock!.runner}):persistentOptions?new PersistentDockerBackend({...persistentOptions,gatewaySocketName,model,apiProtocol,networkPolicy:'none',canStart:()=>!this.stopping&&this.store.mayExecute(run)&&!!environmentLock?.isHeld(),runner:environmentLock!.runner}):new RootlessDockerBackend({dataRoot:this.c.sandboxRoot,gatewayDirectory,model,apiProtocol,image:this.c.image}),{requireEnvironmentReady:this.c.sandboxProfile==='service',beforePrompt:()=>{if(this.stopping||!this.store.mayExecute(run)||(grant&&!grant.isCurrent())||(environmentLock&&!environmentLock.isHeld()))throw new Error('Run no longer owns its execution lease');},beforeSteer:()=>{if(this.stopping||!this.store.mayExecute(run)||(grant&&!grant.isCurrent())||(environmentLock&&!environmentLock.isHeld()))throw new Error('Run no longer accepts steering');}}));
      this.active=adapter;
      heartbeat=setInterval(()=>{
        if((grant&&!grant.isCurrent())||(environmentLock&&!environmentLock.isHeld())||!this.store.renew(run)){leaseLost=true;accepting=false;void adapter?.cancel().catch(()=>{});void gateway?.close().catch(()=>{});}
      },2000);
      const consume=async()=>{
        if(!accepting||leaseLost)return;
        const command=this.store.takeCommand(run,ready); if(!command)return;
        try{
          if(command.type==='cancel'){accepting=false;await gateway?.close();await adapter!.cancel();}
          else await adapter!.steer(command.messageId,command.text!);
          this.store.finishCommand(run,command.id,true);
        }catch{this.store.finishCommand(run,command.id,false);}
      };
      commandTimer=setInterval(()=>{
        if(this.c.sandboxProfile==='service'&&accepting){const stop=new EnvironmentPolicies(this.store).stopStatus(run.botId);if(stop?.state==='pending'&&this.store.task(run.botId,run.taskId).state==='running'){try{this.store.command(run.botId,run.taskId,stop.requestId,'cancel');}catch{}}}
        if(!cancelWork && accepting && this.store.task(run.botId,run.taskId).state==='cancelling'){
          accepting=false; const cmd=this.store.takeCommand(run,false);
          cancelWork=(async()=>{try{await gateway?.close();await adapter!.cancel();if(cmd)this.store.finishCommand(run,cmd.id,true);}catch{if(cmd)this.store.finishCommand(run,cmd.id,false);}})();
        }
        if(accepting&&!commandWork)commandWork=consume().finally(()=>{commandWork=undefined;});
      },100);
      const task=this.store.task(run.botId,run.taskId);
      let prompt=task.prompt;
      if(task.parentTaskId){const parent=this.store.task(run.botId,task.parentTaskId);prompt=`Previous task context:\n${parent.prompt.slice(0,12000)}\nPrevious result:\n${(parent.result ?? parent.error ?? '(no result)').slice(0,16000)}\n\nNew user follow-up:\n${task.prompt}`;}
      const displayPrompt = prompt;
      const memory = new MemoryRepository(join(this.c.root, 'control', 'memory'));
      const snapshot = memory.snapshot(run.botId);
      const context = memoryContext(snapshot, task.prompt);
      if (snapshot.enabled) this.store.appendRunEvent(run, 'memory.loaded', { version: snapshot.version, entries: context.entries.map(entry => ({ id: entry.id, title: entry.title, revision: entry.revision })) });
      if (context.text) prompt = `${context.text}\nCurrent user request:\n${prompt}`;
      if (snapshot.enabled && this.c.mode === 'pi') memoryBroker = await (this.deps.memoryBroker ?? startMemoryBroker)({ socketPath: join(gatewayDirectory, this.c.sandboxProfile === 'persistent' ? `${run.id}.memory.sock` : 'memory.sock'), repo: memory, botId: run.botId, taskId: run.taskId, version: snapshot.version,
        authorize: () => this.store.mayExecute(run) && !this.stopping && (!grant||grant.isCurrent()) && (!environmentLock || environmentLock.isHeld()),
        onEvent: (type, data) => this.store.appendRunEvent(run, type, data) });
      const onEvent=(event:WorkerEvent)=>{
        const d=event.data as Record<string,any>|undefined;
        if(event.type==='command_dispatch' && d?.command==='prompt')promptMayHaveStarted=true;
        if(event.type==='agent_settled')settled=true;
        if(event.type==='response' && d?.command==='prompt' && d?.success===true && d?.data?.disposition==='started'){ready=true;promptMayHaveStarted=true;if(this.store.isCurrent(run))this.store.setEnvironmentState(run.botId,'running');}
        if(event.type==='message_end'&&d?.message?.role==='assistant'){
          const m=d.message;
          result=Array.isArray(m.content)?m.content.filter((part:any)=>part.type==='text').map((part:any)=>String(part.text ?? '')).join('\n'):result;
          modelError=m.stopReason==='error';
          error=modelError?String(m.errorMessage ?? 'Model execution failed'):null;
          aborted=m.stopReason==='aborted';
        }
        if(event.type==='agent_settled'&&d?.aborted)aborted=true;
        // Do not persist token deltas: retain bounded structural and final events.
        if(event.type!=='message_update'){
          const encoded=JSON.stringify(event.data ?? null);
          this.store.appendRunEvent(run,`pi.${event.type}`,encoded.length>65536?{truncated:true,preview:encoded.slice(0,65536)}:event.data);
        }
      };
      if(this.stopping||!this.store.mayExecute(run)||(grant&&!grant.isCurrent()))throw new Error('Run stopped or ChatGPT account changed before launch');
      // A writable guest can execute modified startup code before Pi readiness.
      if(this.c.sandboxProfile!=='ephemeral')promptMayHaveStarted=true;
      await adapter.start({botId:run.botId,taskId:run.taskId,runId:run.id,prompt,displayPrompt,workspace,sessionPath:join(sessionDir,'session.jsonl')},onEvent);
    }catch(e){error=e instanceof Error?e.message:String(e);}
    finally{
      accepting=false;
      if(commandTimer)clearInterval(commandTimer);
      await Promise.all([commandWork,cancelWork]);
      let runnerClean=true,brokersClean=true,stableClean=this.c.sandboxProfile==='ephemeral'||!!environmentLock?.isHeld();
      try{await adapter?.dispose();}catch(e){runnerClean=false;error=`Sandbox cleanup could not be verified: ${String(e)}`;}
      if(stableEnvironment&&environmentLock){try{await (this.deps.cleanupEphemeral??cleanupStaleContainer)({runId:run.id,botId:run.botId,taskId:run.taskId},environmentLock.runner);}catch(e){runnerClean=false;error=`Disposable runner cleanup unverified: ${String(e)}`;}}
      try{await gateway?.close();}catch{brokersClean=false;error='Model gateway cleanup could not be verified';}
      try{await memoryBroker?.close();}catch{brokersClean=false;error='Memory broker cleanup could not be verified';}
      try{await environmentBroker?.close();}catch{brokersClean=false;error='Environment broker drain/cleanup unverified';}
      const unresolvedPackages=new EnvironmentPolicies(this.store).packageState(run.id);if(unresolvedPackages.length)packageQuarantine??='Package import/install did not durably complete; inspect the preserved environment before resuming';
      if(packageQuarantine){aborted=true;error??=packageQuarantine;}
      if(environmentBroker&&!environmentBroker.isHealthy()){aborted=true;error??='Environment command outcome uncertain; review before resubmission';}
      if(stableEnvironment){
        keepEnvironment=runnerClean&&brokersClean&&settled&&!error&&!modelError&&!aborted&&!this.stopping&&!leaseLost&&environmentBroker?.isHealthy()===true&&this.store.mayExecute(run);
        try{if(!keepEnvironment)await stableEnvironment.stop();}catch(e){stableClean=false;error=`Stable environment reconciliation failed: ${String(e)}`;}
      }
      if(persistentOptions){try{persistentOptions=this.persistentOptions(run.botId,()=>!!environmentLock?.isHeld());await (this.deps.cleanupPersistent??cleanupPersistentBot)(run,persistentOptions,environmentLock!.runner);}catch(e){stableClean=false;error=`Persistent bot stop unverified: ${String(e)}`;}}
      if(packageQuarantine&&runnerClean&&brokersClean&&stableClean)new EnvironmentPolicies(this.store).containPackages(run.id);
      cleanupConfirmed=runnerClean&&brokersClean&&stableClean&&!packageQuarantine;
      if(heartbeat)clearInterval(heartbeat);
      this.active=undefined;
      if(environmentLock){try{await environmentLock.release();}catch(e){cleanupConfirmed=false;error=`Persistent OS lock retained: ${e instanceof Error?e.message:String(e)}`;}}
      if(this.store.isCurrent(run))this.store.setEnvironmentState(run.botId,cleanupConfirmed?(keepEnvironment?'running':'stopped'):'quarantined');
    }
    const state=this.stopping||leaseLost||aborted||(promptMayHaveStarted&&!settled)?'interrupted':error||modelError?'failed':'succeeded';
    this.store.finish(run,state,result,error,Date.now(),cleanupConfirmed);
    if(packageQuarantine)this.store.noteQuarantine(run.id,`Operator package reconciliation required: ${packageQuarantine}`);
  }
}
