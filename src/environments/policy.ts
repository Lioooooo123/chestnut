import { randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import { validPackage } from './package-policy.ts';
export { validPackage } from './package-policy.ts';
import { AppError, requireId } from '../types.ts';
export interface EnvironmentPolicy {botId:string;revision:string;allowedPackages:string[];allowedHosts:string[];updatedAt:number}
export function validHost(name:unknown):name is string{return typeof name==='string'&&name.length<=253&&name===name.toLowerCase()&&!name.endsWith('.')&&!/^[0-9.]+$/.test(name)&&/[a-z]/.test(name.split('.').at(-1)!)&&name.split('.').length>=2&&name.split('.').every(part=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));}
export class EnvironmentPolicies {
  private readonly store:Store;
  constructor(store:Store){this.store=store;store.db.exec(`CREATE TABLE IF NOT EXISTS environment_policies(botId TEXT PRIMARY KEY REFERENCES bots(id),revision TEXT NOT NULL,allowedPackages TEXT NOT NULL,allowedHosts TEXT NOT NULL,updatedAt INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS package_operations(requestId TEXT PRIMARY KEY,botId TEXT NOT NULL REFERENCES bots(id),runId TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,updatedAt INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS environment_stop_receipts(requestId TEXT PRIMARY KEY,botId TEXT NOT NULL REFERENCES bots(id),state TEXT NOT NULL,error TEXT,updatedAt INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS environment_stops(botId TEXT PRIMARY KEY REFERENCES bots(id),requestId TEXT UNIQUE NOT NULL,state TEXT NOT NULL,error TEXT,updatedAt INTEGER NOT NULL);`);}
  get(botId:string):EnvironmentPolicy{this.store.bot(botId);const row=this.store.get<any>('SELECT * FROM environment_policies WHERE botId=?',botId);return row?{...row,allowedPackages:JSON.parse(row.allowedPackages),allowedHosts:JSON.parse(row.allowedHosts)}:{botId,revision:'none',allowedPackages:[],allowedHosts:[],updatedAt:0};}
  set(botId:string,input:{expectedRevision:string;allowedPackages:string[];allowedHosts:string[]}):EnvironmentPolicy{
    if(!Array.isArray(input.allowedPackages)||input.allowedPackages.length>128||!input.allowedPackages.every(validPackage)||!Array.isArray(input.allowedHosts)||input.allowedHosts.length>32||!input.allowedHosts.every(validHost))throw new AppError(400,'Use up to 128 Debian package names and 32 exact lowercase DNS hosts; no wildcards, URLs or IPs');
    return this.store.tx(()=>{const previous=this.get(botId);if(input.expectedRevision!==previous.revision)throw new AppError(409,'Environment policy changed; reload before editing');
      const value={botId,revision:randomUUID(),allowedPackages:[...new Set(input.allowedPackages)].sort(),allowedHosts:[...new Set(input.allowedHosts)].sort(),updatedAt:Date.now()};
      this.store.db.prepare('INSERT INTO environment_policies VALUES(?,?,?,?,?) ON CONFLICT(botId) DO UPDATE SET revision=excluded.revision,allowedPackages=excluded.allowedPackages,allowedHosts=excluded.allowedHosts,updatedAt=excluded.updatedAt').run(botId,value.revision,JSON.stringify(value.allowedPackages),JSON.stringify(value.allowedHosts),value.updatedAt);return value;});
  }
  requestStop(botId:string,requestId:string){this.store.bot(botId);requireId(requestId);return this.store.tx(()=>{
    const receipt=this.store.get<any>('SELECT * FROM environment_stop_receipts WHERE requestId=?',requestId);if(receipt){if(receipt.botId!==botId)throw new AppError(409,'Stop request belongs to another bot');return {...receipt,replayed:true};}
    const previous=this.store.get<any>('SELECT * FROM environment_stops WHERE botId=?',botId);if(previous?.state==='pending')throw new AppError(409,'Environment stop already pending');
    const now=Date.now();this.store.db.prepare("INSERT INTO environment_stops VALUES(?,?,'pending',NULL,?) ON CONFLICT(botId) DO UPDATE SET requestId=excluded.requestId,state='pending',error=NULL,updatedAt=excluded.updatedAt").run(botId,requestId,now);
    this.store.db.prepare("INSERT INTO environment_stop_receipts VALUES(?,?,'pending',NULL,?)").run(requestId,botId,now);return {...this.stopStatus(botId)!,replayed:false};});}
  stopStatus(botId:string){this.store.bot(botId);return this.store.get<{botId:string;requestId:string;state:string;error:string|null;updatedAt:number}>('SELECT * FROM environment_stops WHERE botId=?',botId)??null;}
  pendingStops(){return this.store.all<{botId:string;requestId:string}>("SELECT botId,requestId FROM environment_stops WHERE state='pending' ORDER BY updatedAt LIMIT 20");}
  finishStop(botId:string,requestId:string,error?:string){this.store.tx(()=>{this.store.db.prepare("UPDATE environment_stop_receipts SET state=?,error=?,updatedAt=? WHERE botId=? AND requestId=? AND state='pending'").run(error?'failed':'succeeded',error?.slice(0,1000)??null,Date.now(),botId,requestId);this.store.db.prepare("UPDATE environment_stops SET state=?,error=?,updatedAt=? WHERE botId=? AND requestId=? AND state='pending'").run(error?'failed':'succeeded',error?.slice(0,1000)??null,Date.now(),botId,requestId);});}
  beginPackage(botId:string,runId:string,requestId:string){this.store.bot(botId);requireId(runId);requireId(requestId);this.store.db.prepare("INSERT INTO package_operations VALUES(?,?,?,'pending',NULL,?)").run(requestId,botId,runId,Date.now());}
  packageNeedsReview(botId:string,runId:string,requestId:string,reason:string){this.store.db.prepare("INSERT INTO package_operations VALUES(?,?,?,'needs_review',?,?) ON CONFLICT(requestId) DO UPDATE SET state='needs_review',reason=excluded.reason,updatedAt=excluded.updatedAt").run(requestId,botId,runId,reason.slice(0,1000),Date.now());}
  packageState(runId:string){return this.store.all<{requestId:string;botId:string;runId:string;state:string;reason:string|null}>("SELECT * FROM package_operations WHERE runId=? AND state NOT IN ('completed','reviewed')",runId);}
  completePackage(requestId:string){this.store.db.prepare("UPDATE package_operations SET state='completed',updatedAt=? WHERE requestId=?").run(Date.now(),requestId);}
  containPackages(runId:string){this.store.db.prepare("UPDATE package_operations SET state='contained',updatedAt=? WHERE runId=? AND state IN ('pending','needs_review')").run(Date.now(),runId);}
  reviewPackages(runId:string){this.store.db.prepare("UPDATE package_operations SET state='reviewed',updatedAt=? WHERE runId=? AND state='contained'").run(Date.now(),runId);}
}
