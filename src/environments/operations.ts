import type { Store } from '../store.ts';
import { AppError, requireId } from '../types.ts';
export interface EnvironmentOperation {requestId:string;botId:string;action:string;payload:string;state:string;phase:string;result:string|null;error:string|null;updatedAt:number;ownerId?:string|null}
export function publicOperation(o:EnvironmentOperation){const result=o.result?JSON.parse(o.result):null;return {...o,payload:JSON.parse(o.payload),result:result?Object.fromEntries(['id','snapshotId','protectionId','partialSnapshotId','imageId','candidateId','oldContainerId','rolledBack','contained','sessionId','capturedAt','width','height'].filter(key=>Object.hasOwn(result,key)).map(key=>[key,result[key]])):null};}
export class EnvironmentOperations {
  readonly store:Store;
  constructor(store:Store){this.store=store;}
  list(botId:string){this.store.bot(botId);return this.store.all<EnvironmentOperation>('SELECT * FROM environment_operations WHERE botId=? ORDER BY updatedAt DESC LIMIT 30',botId).map(publicOperation);}
  get(botId:string,requestId:string){this.store.bot(botId);requireId(requestId);const o=this.store.get<EnvironmentOperation>('SELECT * FROM environment_operations WHERE botId=? AND requestId=?',botId,requestId);if(!o)throw new AppError(404,'Operation not found for this Bot');return o;}
  request(botId:string,requestId:string,action:string,payload:Record<string,unknown>={}){
    this.store.bot(botId);requireId(requestId);if(!['snapshot','restore','desktop','contain','rollback'].includes(action))throw new AppError(400,'Invalid environment operation');
    if(action==='restore')requireId(payload.snapshotId);if(['contain','rollback'].includes(action))requireId(payload.operationId);
    return this.store.tx(()=>{if(action==='restore'&&!this.store.get('SELECT id FROM environment_snapshots WHERE botId=? AND id=?',botId,payload.snapshotId as string))throw new AppError(404,'Snapshot not found for this Bot');const text=JSON.stringify(payload),old=this.store.get<EnvironmentOperation>('SELECT * FROM environment_operations WHERE requestId=?',requestId);if(old){if(old.botId!==botId||old.action!==action||old.payload!==text)throw new AppError(409,'Request ID reused with different operation');return old;}
      if(this.store.get("SELECT id FROM runs WHERE botId=? AND state='running' LIMIT 1",botId)||this.store.quarantines().some(q=>q.botId===botId))throw new AppError(409,'Stop/reconcile the active task before this environment operation');
      const blocked=this.store.get<EnvironmentOperation>("SELECT * FROM environment_operations WHERE botId=? AND state IN ('queued','running','uncertain') LIMIT 1",botId);
      if(['contain','rollback'].includes(action)){const previous=this.get(botId,payload.operationId as string);if(previous.state!=='uncertain'||blocked?.requestId!==previous.requestId||this.store.all("SELECT requestId FROM environment_operations WHERE botId=? AND state IN ('queued','running','uncertain')",botId).length!==1)throw new AppError(409,'Review the exact blocked operation');if(action==='rollback'&&!(previous.result&&JSON.parse(previous.result).protectionId))throw new AppError(409,'No published protection snapshot; use verified-stop recovery');if(action==='contain'&&previous.result&&JSON.parse(previous.result).protectionId)throw new AppError(409,'Restore may have changed files; use its protection rollback');}
      else if(blocked)throw new AppError(409,'An environment operation is already pending or uncertain');
      const recovery=['contain','rollback'].includes(action)?this.get(botId,payload.operationId as string):null;
      this.store.db.prepare("INSERT INTO environment_operations(requestId,botId,action,payload,state,phase,result,error,updatedAt) VALUES(?,?,?,?,'queued','admitted',?,NULL,?)").run(requestId,botId,action,text,recovery?.result??null,Date.now());
      if(recovery)this.store.db.prepare("UPDATE environment_operations SET state='superseded',updatedAt=? WHERE requestId=? AND state='uncertain'").run(Date.now(),recovery.requestId);return this.get(botId,requestId);
    });
  }
  phase(o:EnvironmentOperation,phase:string,result?:unknown){this.store.db.prepare("UPDATE environment_operations SET phase=?,result=COALESCE(?,result),updatedAt=? WHERE requestId=? AND state='running'").run(phase,result===undefined?null:JSON.stringify(result),Date.now(),o.requestId);}
  finish(o:EnvironmentOperation,result:unknown){this.store.db.prepare("UPDATE environment_operations SET state='succeeded',phase='complete',result=?,error=NULL,updatedAt=? WHERE requestId=? AND state='running'").run(JSON.stringify(result),Date.now(),o.requestId);}
  uncertain(o:EnvironmentOperation,error?:unknown){
    const message=error instanceof Error?error.message:'',reason=/flock/.test(message)?'Linux OS-lock prerequisite failed.':/rootless|cgroup|resource controls/.test(message)?'Rootless Docker/resource prerequisites failed.':/Build the desktop|pinned source image/.test(message)?'Pinned desktop source image prerequisite failed.':/limit|capacity|headroom/.test(message)?'Snapshot capacity admission failed.':/checksum|archive|links|symlink|escaped|provenance/.test(message)?'Snapshot integrity/path admission failed.':'Environment/Docker command outcome unverified.';
    this.store.db.prepare("UPDATE environment_operations SET state='uncertain',error=?,updatedAt=? WHERE requestId=? AND state IN ('queued','running')").run(reason+' Review phase and retained artifacts; no automatic replay.',Date.now(),o.requestId);
  }
  replaceIdentity(o:EnvironmentOperation,expected:string|null,containerId:string,imageId:string,imageRef:string){
    this.store.tx(()=>{const current=this.get(o.botId,o.requestId);if(current.state!=='running'||!['restore','rollback'].includes(current.action))throw new Error('No active restore identity grant');const env=this.store.environment(o.botId);if(env?.containerId!==expected||this.store.get("SELECT id FROM runs WHERE botId=? AND state='running'",o.botId))throw new Error('Restore identity fence changed');this.store.db.prepare("UPDATE bot_environments SET containerId=?,imageId=?,imageRef=?,state='stopped',updatedAt=? WHERE botId=?").run(containerId,imageId,imageRef,Date.now(),o.botId);});
  }
}
