import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuthManager, type OAuthFlow } from '../src/auth.ts';
const credential = () => ({ type: 'oauth' as const, access:'test-access-token',refresh:'test-refresh-token',expires:Date.now()+3600000,clientId:'issued-client-id',scopes:['chatgpt.tokens.use.direct'] });
function fixture(flow: OAuthFlow) { const root=mkdtempSync(join(realpathSync(tmpdir()),'cn-auth-')); return {root,auth:new AuthManager(root,flow),close(){rmSync(root,{recursive:true,force:true});}}; }
test('ChatGPT sign-in stores private credentials, exposes only status and deduplicates retries across restart',async()=>{
  let calls=0;let installation='';
  const flow:OAuthFlow={async login(interaction,options){calls++;installation=options.getDeviceId();interaction.notify({type:'auth_url',url:'https://auth.openai.com/api/accounts/authorize?state=test'});return credential();},async refresh(value){return value;}};
  const f=fixture(flow);try{
    const id=randomUUID();await f.auth.startLogin(id);await f.auth.wait();
    assert.equal(f.auth.status().connected,true);assert.equal(calls,1);assert.match(installation,/^[0-9a-f-]{36}$/);
    assert.ok(!JSON.stringify(f.auth.status()).includes('test-access-token'));assert.ok(!JSON.stringify(f.auth.status()).includes('test-refresh-token'));
    assert.equal(lstatSync(join(f.root,'auth.json')).mode&0o777,0o600);
    const reopened=new AuthManager(f.root,flow);await reopened.startLogin(id);assert.equal(calls,1);assert.equal(await reopened.apiKey(), 'test-access-token');
    assert.ok(readFileSync(join(f.root,'auth.json'),'utf8').includes('issued-client-id'));
  }finally{f.auth.close();f.close();}
});
test('refresh is serialized across two managers and logout cannot resurrect credentials',async()=>{
  let refreshes=0;
  const flow:OAuthFlow={async login(){return {...credential(),expires:Date.now()-1};},async refresh(value){refreshes++;await new Promise(r=>setTimeout(r,40));return {...value,access:'rotated-access',refresh:'rotated-refresh',expires:Date.now()+3600000};}};
  const f=fixture(flow);try{
    await f.auth.startLogin(randomUUID());await f.auth.wait();const other=new AuthManager(f.root,flow);
    assert.deepEqual(await Promise.all([f.auth.apiKey(),other.apiKey()]),['rotated-access','rotated-access']);assert.equal(refreshes,1);
    await other.logout();assert.equal(f.auth.status().connected,false);await assert.rejects(f.auth.apiKey(),/Sign in/);
  }finally{f.auth.close();f.close();}
});
test('cancelled login, invalid direct-use grant and upstream errors never save or reveal credentials',async()=>{
  const flow:OAuthFlow={async login(interaction){interaction.notify({type:'auth_url',url:'https://auth.openai.com/api/accounts/authorize?state=test'});await interaction.prompt({type:'manual_code',signal:interaction.signal});return credential();},async refresh(c){return c;}};
  const f=fixture(flow);try{
    await f.auth.startLogin(randomUUID());await f.auth.logout();await f.auth.wait();assert.equal(f.auth.status().connected,false);
    const invalid=new AuthManager(f.root,{...flow,async login(){return {...credential(),scopes:[]};}});await invalid.startLogin(randomUUID());await invalid.wait();assert.equal(invalid.status().connected,false);
    const failed=new AuthManager(f.root,{...flow,async login(){throw new Error('leaked test-refresh-token');}});await failed.startLogin(randomUUID());await failed.wait();assert.ok(!JSON.stringify(failed.status()).includes('test-refresh-token'));assert.equal(failed.status().login?.state,'failed');
  }finally{f.auth.close();f.close();}
});
test('account model list filters visibility, preserves ordering and selection cannot use an unavailable model',async()=>{
 const flow:OAuthFlow={async login(){return credential();},async refresh(c){return c;}};
 const root=mkdtempSync(join(realpathSync(tmpdir()),'cn-auth-models-'));
 const auth=new AuthManager(root,flow,async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/models');assert.equal(new Headers(options!.headers).get('authorization'),'Bearer test-access-token');return Response.json({models:[{slug:'gpt-6.1-sol',display_name:'Model A',visibility:'list'},{slug:'hidden',display_name:'Hidden',visibility:'hidden'},{slug:'gpt-6-sol',display_name:'Model B',visibility:'list'}]});});
 try{await auth.startLogin(randomUUID());await auth.wait();assert.deepEqual((await auth.models()).map(m=>m.id),['gpt-6.1-sol','gpt-6-sol']);await assert.rejects(auth.selectModel('not-available'),/available/);await auth.selectModel('gpt-6-sol');assert.equal(auth.status().model,'gpt-6-sol');}finally{auth.close();rmSync(root,{recursive:true,force:true});}
});
