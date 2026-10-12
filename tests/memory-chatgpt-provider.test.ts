import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chatGptMaintenanceProvider} from '../src/memory/provider.ts';
const input={mode:'extract' as const,tasks:[{id:randomUUID(),createdAt:1,user:['Remember: Use npm.'],result:'Done'}],entries:[],signal:new AbortController().signal};
const auth={grant(){return {model:'account-model',isCurrent:()=>true,async apiKey(){return 'outer-oauth-key';}};}};
test('ChatGPT maintenance uses account model, stateless streamed Responses and waits for completion',async()=>{
 const plan={additions:[],removals:[],conflicts:[]};
 const provider=chatGptMaintenanceProvider(auth,'fallback',async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(new Headers(options!.headers).get('authorization'),'Bearer outer-oauth-key');const body=JSON.parse(options!.body as string);assert.equal(body.model,'account-model');assert.equal(body.stream,true);assert.equal(body.store,false);assert.equal(body.max_output_tokens,undefined);return new Response('data: '+JSON.stringify({type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(plan)}]}]}})+'\n\n');});
 assert.deepEqual(await provider(input),plan);
});
test('interrupted or failed ChatGPT maintenance does not accept a partial JSON plan',async()=>{
 for(const data of [{type:'response.output_text.delta',delta:'{"additions":[]}'},{type:'response.failed',response:{error:{message:'outer-oauth-key'}}}]){const provider=chatGptMaintenanceProvider(auth,'fallback',async()=>new Response('data: '+JSON.stringify(data)+'\n\n'));await assert.rejects(provider(input),error=>error instanceof Error&&!error.message.includes('outer-oauth-key'));}
});

test('maintenance refuses a changed grant before sending context or accepting a result',async()=>{
  let calls=0,current=true;
  const changedDuringKey={grant(){return {model:'first-model',isCurrent:()=>current,async apiKey(){current=false;return 'first-key';}};}};
  await assert.rejects(chatGptMaintenanceProvider(changedDuringKey,'fallback',async()=>{calls++;return new Response();})(input),/account changed/);
  assert.equal(calls,0);
  current=true;
  const changedDuringResponse={grant(){return {model:'first-model',isCurrent:()=>current,async apiKey(){return 'first-key';}};}};
  await assert.rejects(chatGptMaintenanceProvider(changedDuringResponse,'fallback',async()=>{
    current=false;return new Response('data: '+JSON.stringify({type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:'{"additions":[],"removals":[],"conflicts":[]}'}]}]}})+'\n\n');
  })(input),/account changed/);
});
