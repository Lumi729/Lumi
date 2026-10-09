import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const source=fs.readFileSync(new URL('../../background-client.js',import.meta.url),'utf8');
function client(t,{config,fetcher,snapshot}={}){const dom=new JSDOM('<div id="settingsApi"></div>',{url:'https://lumi729.github.io/Lumi/',runScripts:'outside-only'}),w=dom.window,calls=[];t.after(()=>w.close());w.AbortSignal=AbortSignal;if(config)w.localStorage.setItem('lumos_background_connection_v1',JSON.stringify(config));w.fetch=async(url,init)=>{calls.push({url,init});return fetcher?fetcher(url,init):Response.json(url.endsWith('/state')?{inbox:[],jobs:[],subscribed:true}:url.endsWith('/config')?{publicKey:'AQ'}:{ok:true});};w.Notification={requestPermission:async()=> 'granted'};w.PushManager=function(){};Object.defineProperty(w.navigator,'serviceWorker',{value:{ready:Promise.resolve({update:async()=>{},pushManager:{getSubscription:async()=>null,subscribe:async()=>({toJSON:()=>({})})}}),addEventListener(){}}});w.eval(source);const api=w.createLumosBackground({name:()=> 'A',activeId:()=> 'a',isBusy:()=>false,presence:()=>({}),snapshot:snapshot|| (async(id,normal)=>normal?{autoEnabled:false}:{disabled:true}),importReplies:async()=>[],pending(){},log(){}});return {w,api,calls};}
const connection={enabled:true,charId:'a',url:'https://example.workers.dev',token:'test'};
test('existing connection remembered and background generation independently off by default',async t=>{const {w,api,calls}=client(t,{config:connection});assert.equal(api.managed('a'),false);assert(w.document.querySelector('#bgConsent').checked);await w.document.querySelector('#bgConnect').onclick();assert(calls.some(x=>x.url.endsWith('/job')&&x.init.method==='DELETE'));assert.equal(api.managesAuto('a'),false);w.document.querySelector('#bgGeneration').checked=true;await w.document.querySelector('#bgGeneration').onchange();assert(api.managed('a'));});
test('connecting for ordinary replies needs no automatic reply setting',async t=>{const {w,calls}=client(t);w.document.querySelector('#bgUrl').value=connection.url;w.document.querySelector('#bgToken').value=connection.token;w.document.querySelector('#bgConsent').checked=true;w.document.querySelector('#bgGeneration').checked=true;await w.document.querySelector('#bgConnect').onclick();assert(JSON.parse(w.localStorage.getItem('lumos_background_connection_v1')).enabled);assert(!calls.some(x=>x.url.endsWith('/job')&&x.init.method==='POST'));});
test('ordinary submission waits for sync and coalesces repeated clicks',async t=>{let release;const gate=new Promise(r=>release=r);let first=true;const {api,calls}=client(t,{config:{...connection,backgroundGeneration:true},fetcher:async(url)=>{if(first){first=false;await gate;}return Response.json(url.endsWith('/state')?{inbox:[],jobs:[],subscribed:true}:{ok:true});}});const sync=api.sync(),reply=api.submitReply({});assert.equal(api.submitReply({}),reply);release();await Promise.all([sync,reply]);assert.equal(calls.filter(x=>x.url.endsWith('/reply')).length,1);});
test('HTML backend response produces useful error instead of JSON syntax error',async t=>{const {w,api}=client(t,{config:connection,fetcher:async()=>new Response('<html>verification</html>',{status:403})});await api.sync();assert.match(w.document.querySelector('#bgStatus').textContent,/网页而不是连接数据/);assert(!w.document.querySelector('#bgStatus').textContent.includes('Unexpected token'));});
test('address and token drafts survive reopening without requiring connection success',async t=>{const {w}=client(t);const url=w.document.querySelector('#bgUrl'),token=w.document.querySelector('#bgToken');url.value=connection.url;url.dispatchEvent(new w.Event('input'));token.value=connection.token;token.dispatchEvent(new w.Event('input'));const saved=JSON.parse(w.localStorage.getItem('lumos_background_connection_v1'));assert.equal(saved.url,connection.url);assert.equal(saved.token,connection.token);assert(!saved.enabled);const reopened=client(t,{config:saved});assert.equal(reopened.w.document.querySelector('#bgUrl').value,connection.url);assert.equal(reopened.w.document.querySelector('#bgToken').value,connection.token);assert(!reopened.w.document.querySelector('#bgConsent').checked);});
test('background option change does not reset checked upload consent',async t=>{const {w}=client(t);w.document.querySelector('#bgConsent').checked=true;w.document.querySelector('#bgGeneration').checked=true;await w.document.querySelector('#bgGeneration').onchange();assert(w.document.querySelector('#bgConsent').checked);});

test('stopping backend preserves credentials across reopening without reconnecting automatically',async t=>{
 const {w,api,calls}=client(t,{config:{...connection,backgroundGeneration:true}});
 await w.document.querySelector('#bgStop').onclick();
 const saved=JSON.parse(w.localStorage.getItem('lumos_background_connection_v1'));
 assert.equal(saved.token,connection.token);assert.equal(saved.url,connection.url);assert.equal(saved.enabled,false);
 assert.equal(api.managed('a'),false);assert.equal(api.managesAuto('a'),false);
 assert(calls.some(x=>x.url.endsWith('/reset')&&x.init.method==='DELETE'));
 const reopened=client(t,{config:saved});assert.equal(reopened.w.document.querySelector('#bgToken').value,connection.token);
 assert(!reopened.w.document.querySelector('#bgConsent').checked);assert(!reopened.api.managed('a'));
 reopened.w.document.querySelector('#bgConsent').checked=true;
 await reopened.w.document.querySelector('#bgConnect').onclick();
 assert(JSON.parse(reopened.w.localStorage.getItem('lumos_background_connection_v1')).enabled);
});
test('failed backend reset retains active connection and credentials',async t=>{
 const {w,api}=client(t,{config:{...connection,backgroundGeneration:true},fetcher:async()=>Response.json({error:'network failure'},{status:503})});
 await w.document.querySelector('#bgStop').onclick();
 const saved=JSON.parse(w.localStorage.getItem('lumos_background_connection_v1'));assert.equal(saved.token,connection.token);assert(saved.enabled);assert(api.managed('a'));
});

test('invalid token gives actionable message before fetch without exposing it',async t=>{
 const {w,calls}=client(t);w.document.querySelector('#bgUrl').value=connection.url;
 const secret='不可发送的口令';w.document.querySelector('#bgToken').value=secret;w.document.querySelector('#bgConsent').checked=true;
 await w.document.querySelector('#bgConnect').onclick();
 assert.equal(calls.length,0);const status=w.document.querySelector('#bgStatus').textContent;assert.match(status,/ACCESS_TOKEN/);assert(!status.includes(secret));
});

test('manual sync while disconnected explains connection requirement',async t=>{
 const {w,calls}=client(t);await w.document.querySelector('#bgSync').onclick();
 assert.match(w.document.querySelector('#bgStatus').textContent,/尚未连接后台/);assert.equal(calls.length,0);
});
test('manual sync reports completion and scheduler state even with no messages',async t=>{
 const {w}=client(t,{config:connection});await w.document.querySelector('#bgSync').onclick();
 const text=w.document.querySelector('#bgStatus').textContent;assert.match(text,/同步完成/);assert.match(text,/本次同步 0/);assert.match(text,/任务：未登记/);assert.match(text,/尚无运行记录/);
});

test('independent backend limit persists and overrides every scheduled snapshot without mutating local settings',async t=>{
 const local={autoEnabled:true,revision:'same',dailyMin:1,dailyMax:9};
 const {w,calls}=client(t,{config:{...connection,backgroundGeneration:true},snapshot:async()=>local});
 const input=w.document.querySelector('#bgDailyLimit');input.value='6';await input.onchange();
 const sent=JSON.parse(calls.find(x=>x.url.endsWith('/job')&&x.init.method==='POST').init.body);
 assert.equal(sent.dailyMax,6);assert.equal(sent.dailyMin,6);assert.equal(local.dailyMax,9);
 const saved=JSON.parse(w.localStorage.getItem('lumos_background_connection_v1'));assert.equal(saved.dailyLimit,6);
 const reopened=client(t,{config:saved});assert.equal(reopened.w.document.querySelector('#bgDailyLimit').value,'6');
 input.value='0';await input.onchange();const last=calls.filter(x=>x.url.endsWith('/job')&&x.init.method==='POST').at(-1);assert.equal(JSON.parse(last.init.body).dailyMax,0);
});
