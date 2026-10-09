import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { LumosScheduler } from '../src/worker.js';
const job = () => ({charId:'char_demo',convId:'',revision:'one',url:'https://api.example.com/v1/chat/completions',key:'test-key',body:{model:'demo',messages:[{role:'system',content:'demo'}]},lastAt:Date.now()-60000,delayMinutes:1,dailyMin:2,dailyMax:2,offset:-480,todayCount:0,todayDate:''});
function setup() {
  const data=new Map(); let alarm=null;
  const storage={get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),deleteAll:async()=>data.clear(),setAlarm:async t=>{alarm=t},deleteAlarm:async()=>{alarm=null}};
  let lock=Promise.resolve();
  const state={storage,blockConcurrencyWhile(fn){const task=lock.then(fn);lock=task.catch(()=>{});return task;}};
  const env={STORAGE_KEY:Buffer.alloc(32,7).toString('base64'),APP_ORIGIN:'https://lumi729.github.io',ACCESS_TOKEN:'test-token',VAPID_PUBLIC_KEY:'dummy',VAPID_PRIVATE_KEY:'dummy',VAPID_SUBJECT:'https://example.com'};
  const scheduler=new LumosScheduler(state,env);
  const call=async(path,method='GET',body)=>{const r=await scheduler.fetch(new Request('https://worker.example.com'+path,{method,...(body?{body:JSON.stringify(body)}:{})}));return {status:r.status,body:await r.json()};};
  async function due(){await state.blockConcurrencyWhile(async()=>{const d=await scheduler.load();d.jobs.char_demo.nextAt=Date.now()-1;await scheduler.save(d);});}
  return {scheduler,env,call,due,alarm:()=>alarm};
}
test('Worker rejects missing auth and wrong Origin before scheduler access',async()=>{
  const {env}=setup();
  assert.equal((await worker.fetch(new Request('https://example.com/config'),env)).status,401);
  assert.equal((await worker.fetch(new Request('https://example.com/config',{headers:{Origin:'https://evil.example'}}),env)).status,403);
  const r=await worker.fetch(new Request('https://example.com/config',{headers:{Authorization:'Bearer test-token',Origin:env.APP_ORIGIN}}),env);
  assert.equal(r.status,200);assert.equal(r.headers.get('Access-Control-Allow-Origin'),env.APP_ORIGIN);
});
test('alarm reserves paid request, saves reply, sync acknowledges durably',async()=>{
  const {scheduler,call,due}=setup();await call('/job','POST',job());await due();
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:'one\n\ntwo'}}]});};
  try {
    await scheduler.alarm();await scheduler.alarm();assert.equal(calls,1);
    const remote=(await call('/state')).body;assert.equal(remote.inbox[0].segments.length,2);assert.equal(remote.jobs[0].daily.count,1);
    assert.equal((await call('/job','POST',job())).status,409);
    await call('/ack','POST',{ids:[remote.inbox[0].id]});assert.equal((await call('/state')).body.inbox.length,0);
    assert.equal((await call('/job','POST',job())).status,200); // acknowledged results do not block snapshot refresh
    await call('/reset','DELETE');assert.equal((await call('/state')).body.jobs.length,0);
  } finally {globalThis.fetch=original;}
});
test('new revision during generation discards stale result without duplicate request',async()=>{
  const {scheduler,call,due}=setup();await call('/job','POST',job());await due();
  const original=globalThis.fetch;let finish,started;
  const hasStarted=new Promise(r=>{started=r;});
  globalThis.fetch=async()=>{started();return new Promise(r=>{finish=r;});};
  try {
    const running=scheduler.alarm();await hasStarted;
    await call('/job','POST',{...job(),revision:'new-user-message'});
    finish(Response.json({choices:[{message:{content:'outdated'}}]}));await running;
    assert.equal((await call('/state')).body.inbox.length,0);
  } finally {globalThis.fetch=original;}
});
test('polling same revision during request preserves the in-flight result',async()=>{
  const {scheduler,call,due}=setup();await call('/job','POST',job());await due();
  const original=globalThis.fetch;let finish,started;const ready=new Promise(r=>{started=r;});
  globalThis.fetch=async()=>{started();return new Promise(r=>{finish=r;});};
  try {const running=scheduler.alarm();await ready;await call('/job','POST',job());finish(Response.json({choices:[{message:{content:'fresh'}}]}));await running;assert.equal((await call('/state')).body.inbox[0].segments[0],'fresh');}
  finally{globalThis.fetch=original;}
});
test('daily zero quota and expired lease do not call AI',async()=>{
  const {scheduler,call,due,alarm}=setup();await call('/job','POST',{...job(),dailyMin:0,dailyMax:0});await due();
  const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('must not fetch');};
  try {await scheduler.alarm();assert.equal((await call('/state')).body.jobs[0].daily.count,0);const d=await scheduler.load();d.jobs.char_demo.leaseUntil=Date.now()-1;await scheduler.save(d);await scheduler.alarm();assert.equal((await call('/state')).body.jobs.length,0);assert.equal(alarm(),null);}
  finally{globalThis.fetch=original;}
});
test('AI failure records generic status, no immediate paid retry',async()=>{
  const {scheduler,call,due}=setup();await call('/job','POST',job());await due();let calls=0;
  const original=globalThis.fetch;globalThis.fetch=async()=>{calls++;throw Error('secret must not leak');};
  try{await scheduler.alarm();await scheduler.alarm();assert.equal(calls,1);const remote=(await call('/state')).body;assert.match(remote.jobs[0].error,/不自动重试/);assert.ok(!JSON.stringify(remote).includes('secret must not leak'));}
  finally{globalThis.fetch=original;}
});
test('real Web Push encryption is used; accepted push is not repeated',async()=>{
  const {scheduler,env,call,due}=setup();
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  env.VAPID_PUBLIC_KEY=Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey)).toString('base64url');
  env.VAPID_PRIVATE_KEY=(await crypto.subtle.exportKey('jwk',pair.privateKey)).d;
  const subscriber=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const sub={endpoint:'https://fcm.googleapis.com/fcm/send/test-only',keys:{p256dh:Buffer.from(await crypto.subtle.exportKey('raw',subscriber.publicKey)).toString('base64url'),auth:Buffer.alloc(16,8).toString('base64url')}};
  await call('/subscription','POST',sub);await call('/job','POST',job());await due();
  const original=globalThis.fetch;let pushes=0;
  globalThis.fetch=async(url,init)=>{
    if(url===sub.endpoint){pushes++;const headers=new Headers(init.headers);assert.equal(headers.get('Content-Encoding'),'aes128gcm');assert.match(headers.get('Authorization'),/^vapid /);assert.ok(init.body.byteLength>0);return new Response('',{status:201});}
    return Response.json({choices:[{message:{content:'one\n\ntwo'}}]});
  };
  try {await scheduler.alarm();await scheduler.alarm();assert.equal(pushes,1);const item=(await call('/state')).body.inbox[0];assert.equal(item.pushState,'submitted');await call('/ack','POST',{ids:[item.id]});assert.equal((await call('/state')).body.inbox.length,0);}
  finally{globalThis.fetch=original;}
});
