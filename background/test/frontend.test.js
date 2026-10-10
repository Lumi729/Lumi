import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {JSDOM, VirtualConsole} from 'jsdom';
import {IDBFactory, IDBKeyRange} from 'fake-indexeddb';
const root=new URL('../../',import.meta.url);
const client=fs.readFileSync(new URL('background-client.js',root),'utf8');
const source=fs.readFileSync(new URL('index.html',root),'utf8');
const hooks=`window.__audit={
 setup(){const a=getActiveCharacter();a.name='A';a.type='single';a.activeConversationId=null;a.conversations=[];a.apiSettings={...a.apiSettings,enabled:true,url:'https://example.test/v1',key:'test-only',model:'test',notificationsEnabled:true,weatherEnabled:false,autoReplyEnabled:false,crossChatEnabled:false};a.chatMessages=[{id:'u1',role:'user',text:'hello',timestamp:Date.now()-600000}];a.messageHistory=[{role:'user',content:'hello'}];const b=structuredClone(a);b.id='test-b';b.name='B';b.chatMessages=[];b.messageHistory=[];characters.push(b);loadActiveCharToGlobals();showView('chat');return a.id;},
 avatar(src){getActiveCharacter().avatarType="image";getActiveCharacter().avatarSrc=src;loadActiveCharToGlobals();},edit(id){reloadChatUI();startInlineEdit(id);},notify:sendAutoReplyNotifications,request:()=>triggerAiReply(false),auto:()=>checkAutoReply(),view:showView,switch:()=>openCharacterChat('test-b'),data:()=>characters,
 enableAuto(){apiSettings.autoReplyEnabled=true;apiSettings.autoReplyDelayMinutes=1;apiSettings.autoReplyDailyMin=1;apiSettings.autoReplyDailyMax=1;apiSettings.autoReplyTodayCount=0;saveGlobalsToActiveChar();},
 notifications(value){apiSettings.notificationsEnabled=value;saveGlobalsToActiveChar();},
 group(){getActiveCharacter().type='group';chatType='group';members=[{id:'m1',name:'Member'}];saveGlobalsToActiveChar();},
 convSetup(){saveGlobalsToActiveChar();const a=getActiveCharacter();a.conversations=[{id:'one',messages:[...a.chatMessages],history:[...a.messageHistory]},{id:'two',messages:[],history:[]}];a.activeConversationId='one';loadActiveCharToGlobals();},
 convSwitch(){saveGlobalsToActiveChar();getActiveCharacter().activeConversationId='two';loadActiveCharToGlobals();reloadChatUI();},
 wallet:walletGetAllTx,addTx:walletAddTx,walletPrompt:getWalletContextForPrompt,busy:()=>autoReplyInProgress,read:markVisibleChatRead,time:buildTimeAwareness,
 sync(){syncHistoryFromChat();return messageHistory;},msgs:()=>chatMessages,sums:()=>summaries,setSums(a){summaries=a;saveGlobalsToActiveChar();},
 setConvs(l){saveGlobalsToActiveChar();getActiveCharacter().conversations=l;loadActiveCharToGlobals();},switchConv:switchConversation,live:returnToLiveChat,delConv:deleteConversation,summary:m=>generateSummary(m),
 ble:t=>extractBleCommands(t),bleOn(v){apiSettings.bleControlEnabled=v;},exportData:getAllSettingsData,waiting:()=>waiting
};`;
// Only test accessors are injected; production handlers and persistence run unchanged.
async function app(t, handler){
 const html=source.replace(/<script src="\/Lumi\/background-client\.js[^"\n]*"><\/script>/,'<script>'+client.replace('window.createLumosBackground = function(adapter) {','window.createLumosBackground = function(adapter) { window.__auditAdapter=adapter;')+'</script>').replace('  function initAll(){','  '+hooks+'\n  function initAll(){');
 const errors=[],calls=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!/Not implemented/.test(e.message))errors.push(e.message)});
 const dom=new JSDOM(html,{url:'https://lumi729.github.io/Lumi/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){w.indexedDB=new IDBFactory();w.IDBKeyRange=IDBKeyRange;w.TextEncoder=TextEncoder;w.structuredClone=structuredClone;Object.defineProperty(w.crypto,'subtle',{value:webcrypto.subtle});w.matchMedia=()=>({matches:false,addEventListener(){}});w.fetch=async(u,init)=>{if(String(u).startsWith('https://example.test/')){calls.push({url:u,init});return handler?handler(u,init):Response.json({choices:[{message:{content:'reply A'}}]});}return Response.json({});};w.Request=Request;w.AbortSignal=AbortSignal;w.alert=()=>{};w.HTMLCanvasElement.prototype.getContext=()=>null;}});
 t.after(()=>dom.window.close());
 for(let i=0;i<100&&!dom.window.document.querySelector('#bgConnect');i++)await new Promise(r=>setTimeout(r,10));
 assert(dom.window.document.querySelector('#bgConnect'),'application mounted');assert.deepEqual(errors,[]);
 const api=dom.window.__audit,id=api.setup();return {w:dom.window,api,id,calls,errors};
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
test('ordinary delayed reply stays in original character and shows banner',async t=>{const gate=deferred(),started=deferred();const {w,api,id}=await app(t,async()=>{started.resolve();await gate.promise;return Response.json({choices:[{message:{content:'reply A'}}]});});const p=api.request();await started.promise;api.switch();gate.resolve();await p;assert(api.data().find(c=>c.id===id).chatMessages.some(m=>m.text==='reply A'));assert.equal(api.data().find(c=>c.id==='test-b').chatMessages.length,0);assert(!w.document.querySelector('#chatArea').textContent.includes('reply A'));assert(w.document.querySelector('#lumosIncomingBanner'));assert.equal(w.document.querySelector('#sendBtn').disabled,false);});
test('delayed reply stays in original conversation of same character',async t=>{const gate=deferred(),started=deferred();const {api,id}=await app(t,async()=>{started.resolve();await gate.promise;return Response.json({choices:[{message:{content:'reply A'}}]});});api.convSetup();const p=api.request();await started.promise;api.convSwitch();gate.resolve();await p;const c=api.data().find(c=>c.id===id);assert(c.conversations[0].messages.some(m=>m.text==='reply A'));assert.equal(c.conversations[1].messages.length,0);});
test('API failure after switching cannot write an error into another role',async t=>{const gate=deferred(),started=deferred();const {api,id}=await app(t,async()=>{started.resolve();await gate.promise;return new Response('',{status:500});});const p=api.request();await started.promise;api.switch();gate.resolve();await p;assert(api.data().find(c=>c.id===id).chatMessages.some(m=>m.text.includes('HTTP 500')));assert.equal(api.data().find(c=>c.id==='test-b').chatMessages.length,0);});
for(const page of ['messages','library','profile']){
 test('ordinary reply banner on '+page,async t=>{const {w,api}=await app(t);api.view(page);await api.request();assert(w.document.querySelector('#lumosIncomingBanner'));});
 test('automatic reply banner on '+page,async t=>{const {w,api,id}=await app(t);api.enableAuto();api.view(page);await api.auto();assert(w.document.querySelector('#lumosIncomingBanner'));assert.equal(api.data().find(c=>c.id===id).unreadCount,1);assert.equal(api.busy(),false);});
}
test('viewing matching chat suppresses banner and unread badge',async t=>{const {w,api,id}=await app(t);await api.request();assert.equal(w.document.querySelector('#lumosIncomingBanner'),null);assert.equal(api.data().find(c=>c.id===id).unreadCount,0);});
test('disabled notifications suppress banner while retaining unread',async t=>{const {w,api,id}=await app(t);api.notifications(false);api.view('messages');await api.request();assert.equal(w.document.querySelector('#lumosIncomingBanner'),null);assert.equal(api.data().find(c=>c.id===id).unreadCount,1);});
test('automatic scheduler does not overlap an ordinary request',async t=>{const gate=deferred(),started=deferred();const {api,calls}=await app(t,async()=>{started.resolve();await gate.promise;return Response.json({choices:[{message:{content:'reply A'}}]});});api.enableAuto();const p=api.request();await started.promise;const auto=api.auto();await new Promise(r=>setTimeout(r,30));const count=calls.length;gate.resolve();await Promise.all([p,auto]);assert.equal(count,1);});
test('group auto reply releases scheduler on API failure',async t=>{const {api}=await app(t,async()=>new Response('',{status:503}));api.group();api.enableAuto();const complete=await Promise.race([api.auto().then(()=>true),new Promise(r=>setTimeout(()=>r(false),350))]);assert.equal(complete,true);assert.equal(api.busy(),false);});
test('clicking in-app banner opens source and clears unread count',async t=>{const {w,api,id}=await app(t);api.view('library');await api.request();assert.equal(api.data().find(c=>c.id===id).unreadCount,1);w.document.querySelector('#lumosIncomingBanner').click();assert.equal(api.data().find(c=>c.id===id).unreadCount,0);assert(w.document.querySelector('#chatViewWrap').classList.contains('active'));});
test('automatic skip produces neither banner nor unread reply',async t=>{const {w,api,id}=await app(t,async()=>Response.json({choices:[{message:{content:'[AUTO_SKIP] later'}}]}));api.enableAuto();api.view('profile');await api.auto();assert.equal(w.document.querySelector('#lumosIncomingBanner'),null);assert.equal(api.data().find(c=>c.id===id).unreadCount,0);});
test('new user message age is separate from preceding conversation gap',async t=>{const {api}=await app(t);const now=2000000000000;const text=api.time([{role:'dog',timestamp:now-7200000},{role:'user',timestamp:now-1000}],now);assert.match(text,/距用户最近一次发言：不到 1 分钟/);assert.match(text,/距角色最近一次回复：2 小时/);assert.match(text,/用户最近一次发言与它前一条聊天消息的间隔：1 小时 59 分钟/);});
test('background inbox import shows banner on other page and deduplicates',async t=>{const {w,api,id}=await app(t);api.view('library');const reply={id:'cloud-one',charId:id,convId:'',timestamp:Date.now(),segments:['cloud reply'],isAutoReply:true};await w.__auditAdapter.importReplies([reply]);assert(w.document.querySelector('#lumosIncomingBanner'));await w.__auditAdapter.importReplies([reply]);const c=api.data().find(c=>c.id===id);assert.equal(c.chatMessages.filter(m=>m.id==='bg_cloud-one_0').length,1);assert.equal(c.unreadCount,1);});
test('banner uses originating role avatar after switching',async t=>{
 const gate=deferred(),started=deferred();const {w,api,id}=await app(t,async()=>{started.resolve();await gate.promise;return Response.json({choices:[{message:{content:'reply'}}]});});api.avatar('https://example.test/avatar-a.png');const c=api.data().find(c=>c.id===id);
 const request=api.request();await started.promise;api.switch();gate.resolve();await request;const img=w.document.querySelector('#lumosIncomingBanner img');assert.equal(img.src,c.avatarSrc);const preview=w.document.querySelector('#lumosIncomingBanner strong').nextElementSibling;assert.equal(preview.style.whiteSpace,'nowrap');assert.equal(preview.style.textOverflow,'ellipsis');img.dispatchEvent(new w.Event('error'));assert(w.document.querySelector('.incoming-banner-avatar').textContent);
});
test('short previews preserve full batch and hand off without ping or ready wait',async t=>{
 const {w,api}=await app(t);const posted=[];w.Notification={permission:'granted'};
 w.MessageChannel=class{constructor(){this.port1={close(){}};this.port2={};}};
 Object.defineProperty(w.navigator,'serviceWorker',{value:{controller:{postMessage:(data)=>posted.push(data)},get ready(){throw new Error('must not wait for ready');}}});
 // Call the real function in the app closure using test-only hook.
 await api.notify(['a'.repeat(200),'second','third']);
 assert.equal(posted.length,1);assert.equal(posted[0].type,'LUMOS_NOTIFY_BATCH');assert.equal(posted[0].notices.length,3);assert.equal(posted[0].notices[0].options.body,'a'.repeat(24)+'…');assert.equal(posted[0].notices[1].options.body,'second');
 await api.notify(['one','two','three','four']);assert.equal(posted[1].notices.length,1);assert.match(posted[1].notices[0].options.body,/共4条/);
});


test('background recall and red packet stay in source role, survive repeated sync, hide topups',async t=>{
 const {w,api,id}=await app(t);
 await api.addTx({id:'fund',charId:id,type:'topup',amount:20,note:'PRIVATE TOPUP',timestamp:Date.now()});
 const prompt=await api.walletPrompt();assert(!prompt.includes('PRIVATE TOPUP'));assert(!prompt.includes('用户充值'));
 const reply={id:'actions-test',charId:id,convId:'',timestamp:Date.now(),segments:['first','second'],actions:[{type:'recall',segmentIndex:0},{type:'hongbao',amount:5,note:'hi'}]};
 api.switch();await w.__auditAdapter.importReplies([reply]);await w.__auditAdapter.importReplies([reply]);
 const c=api.data().find(c=>c.id===id),b=api.data().find(c=>c.id==='test-b');
 assert(c.chatMessages.find(m=>m.id==='bg_actions-test_0').recalled);assert.equal(b.chatMessages.length,0);
 assert.equal((await api.wallet()).filter(t=>t.type==='hongbao').length,1);
 assert.equal(c.chatMessages.filter(m=>m.backgroundHongbao).length,1);
 const tooMuch={...reply,id:'too-much',segments:[],actions:[{type:'hongbao',amount:30,note:'no'}]};
 await w.__auditAdapter.importReplies([tooMuch]);assert.equal((await api.wallet()).filter(t=>t.type==='hongbao').length,1);
});

test('regression: backend daily counts must not overwrite local daily counts',async t=>{
 const {w,api,id}=await app(t);api.enableAuto();
 await w.__auditAdapter.importReplies([{id:'audit-daily',charId:id,convId:'',timestamp:Date.now(),segments:['hello'],daily:{version:2,day:'2026-10-10',count:7,quota:10}}]);
 assert.equal(api.data().find(c=>c.id===id).apiSettings.autoReplyTodayCount,0);
});
test('regression: changing automatic message count must change snapshot revision',async t=>{
 const {w,api,id}=await app(t);api.enableAuto();
 const before=await w.__auditAdapter.snapshot(id);
 const input=w.document.querySelector('#autoReplyMsgCountInput');input.value='5';input.dispatchEvent(new w.Event('change'));
 const after=await w.__auditAdapter.snapshot(id);
 assert.notEqual(before.body.messages[0].content,after.body.messages[0].content);
 assert.notEqual(before.revision,after.revision);
 assert.equal(after.revision,(await w.__auditAdapter.snapshot(id)).revision);
 const layers=w.document.querySelector('#autoReplyContextLayersInput');layers.value='9';layers.dispatchEvent(new w.Event('change'));
 assert.notEqual(after.revision,(await w.__auditAdapter.snapshot(id)).revision);
});
test('regression: deleted conversation inbox must not remain permanently unacknowledged',async t=>{
 const {w,api,id}=await app(t);api.convSetup();
 const ids=await w.__auditAdapter.importReplies([{id:'deleted-conversation',charId:id,convId:'already-deleted',timestamp:Date.now(),segments:['old reply']}]);
 assert.deepEqual(Array.from(ids),['deleted-conversation']);
 const archived=await new Promise((resolve,reject)=>{const r=w.indexedDB.open('lumos_chars_v1',1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const q=db.transaction('chars').objectStore('chars').get('background_orphan_replies_v1');q.onsuccess=()=>{resolve(q.result);db.close();};};});
 assert.equal(archived[0].segments[0],'old reply');
 assert(!api.data().find(c=>c.id===id).chatMessages.some(m=>m.text==='old reply'));
});

 test('edited user text reaches both normal API and background snapshot',async t=>{
 const {w,api,id,calls}=await app(t);
 api.edit('u1');w.document.querySelector('.msg-edit-textarea').value='corrected message';w.document.querySelector('.msg-edit-save').click();
 const snapshot=await w.__auditAdapter.snapshot(id,true);
 assert.equal(snapshot.body.messages.find(m=>m.role==='user').content,'corrected message');
 await api.request();
 const sent=JSON.parse(calls[0].init.body);
 assert.equal(sent.messages.find(m=>m.role==='user').content,'corrected message');
 assert(!sent.messages.some(m=>m.content==='hello'));
 });
test('editing preserves quote and mention context and edited assistant text',async t=>{
 const {w,api,id}=await app(t);await api.request();
 const c=api.data().find(c=>c.id===id),u=c.chatMessages.find(m=>m.id==='u1');
 u.quoteText='quoted words';u.quoteRole='user';u.mentionName='A';
 api.edit('u1');w.document.querySelector('.msg-edit-textarea').value='new user words';w.document.querySelector('.msg-edit-save').click();
 const dog=c.chatMessages.find(m=>m.role==='dog');api.edit(dog.id);w.document.querySelector('.msg-edit-textarea').value='new character words';w.document.querySelector('.msg-edit-save').click();
 const snapshot=await w.__auditAdapter.snapshot(id,true);
 const user=snapshot.body.messages.find(m=>m.role==='user').content;
 assert.match(user,/\[@A\]/);assert.match(user,/quoted words/);assert.match(user,/new user words/);
 assert(snapshot.body.messages.some(m=>m.role==='assistant'&&m.content==='new character words'));
});

test('background range prompt and reasoning bubbles for ordinary and automatic replies',async t=>{
 const {w,api,id}=await app(t);api.enableAuto();
 const snapshot=await w.__auditAdapter.snapshot(id,false,{min:2,max:4});
 assert.match(snapshot.body.messages[0].content,/2~4 条消息/);
 for(const isAutoReply of [false,true]){
  const reply={id:'thought-'+isAutoReply,charId:id,convId:'',timestamp:Date.now(),segments:['hello','again'],reasoning:'saved thought',isAutoReply};
  await w.__auditAdapter.importReplies([reply]);await w.__auditAdapter.importReplies([reply]);
  const first=w.document.getElementById('msg-bg_'+reply.id+'_0');first.querySelector('.reasoning-btn').click();assert.equal(first.querySelector('.reasoning-box').textContent,'saved thought');
  assert.equal(w.document.getElementById('msg-bg_'+reply.id+'_1').querySelector('.reasoning-btn'),null);
 }
});

// ---- 2026-10-10 bug fixes (Claude) ----
test('IndexedDB read failure is not treated as a new user and never overwrites data',async t=>{
 const idb=new IDBFactory();
 await new Promise((res,rej)=>{const r=idb.open('lumos_chars_v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('chars');r.onerror=()=>rej(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('chars','readwrite');tx.objectStore('chars').put([{id:'keep',name:'KEEP',type:'single',chatMessages:[],messageHistory:[]}],'main');tx.oncomplete=()=>{db.close();res();};};});
 const errors=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!/Not implemented/.test(e.message))errors.push(e.message)});
 const dom=new JSDOM(source.replace(/<script src="\/Lumi\/background-client\.js[^"\n]*"><\/script>/,'<script>'+client+'</script>'),{url:'https://lumi729.github.io/Lumi/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
  w.indexedDB=idb;w.IDBKeyRange=IDBKeyRange;w.TextEncoder=TextEncoder;w.structuredClone=structuredClone;Object.defineProperty(w.crypto,'subtle',{value:webcrypto.subtle});w.matchMedia=()=>({matches:false,addEventListener(){}});w.fetch=async()=>Response.json({});w.Request=Request;w.alert=()=>{};w.HTMLCanvasElement.prototype.getContext=()=>null;
 }});
 t.after(()=>dom.window.close());
 // Make the store's get() throw synchronously, the case that used to bypass the catch.
 const {IDBObjectStore}=await import('fake-indexeddb');const orig=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(...a){if(this.name==='chars')throw new Error('read broken');return orig.apply(this,a);};t.after(()=>{IDBObjectStore.prototype.get=orig;});
 for(let i=0;i<100&&!dom.window.document.querySelector('#idbLoadFailed')&&!dom.window.document.querySelector('#bgConnect');i++)await new Promise(r=>setTimeout(r,10));
 assert(dom.window.document.querySelector('#idbLoadFailed'),'shows read-failure prompt');
 assert.match(dom.window.document.querySelector('#idbLoadFailed').textContent,/数据读取失败，请刷新/);
 IDBObjectStore.prototype.get=orig;await new Promise(r=>setTimeout(r,50));
 const stored=await new Promise(res=>{const r=idb.open('lumos_chars_v1',1);r.onsuccess=()=>{const g=r.result.transaction('chars').objectStore('chars').get('main');g.onsuccess=()=>{r.result.close();res(g.result);};};});
 assert.deepEqual(stored.map(c=>c.name),['KEEP'],'stored characters untouched, no default 月 written');
});
test('history rebuild keeps images, quotes, mentions and recall roles; nothing written to localStorage',async t=>{
 const {w,api}=await app(t);const m=api.msgs();m.length=0;
 m.push({id:'i1',role:'user',text:'[图片]',imageDataUrl:'data:image/png;base64,AA',timestamp:1});
 m.push({id:'q1',role:'user',text:'看这个',imageDataUrl:'data:image/png;base64,BB',quoteText:'原话',quoteRole:'dog',mentionName:'小月',timestamp:2});
 m.push({id:'r1',role:'user',text:'',recalled:true,timestamp:3},{id:'r2',role:'dog',text:'',recalled:true,timestamp:4},{id:'h1',role:'hint',text:'x',timestamp:5});
 const h=JSON.parse(JSON.stringify(api.sync())); // 跨窗口对象先转成普通对象再比较
 assert.equal(h.length,4);
 assert.deepEqual(h[0].content[0],{type:'image_url',image_url:{url:'data:image/png;base64,AA'}});
 assert.match(h[0].content[1].text,/用户发送了一张图片/);
 assert.equal(h[1].content[0].image_url.url,'data:image/png;base64,BB');assert.match(h[1].content[1].text,/^\[@小月\] \[用户引用了来自"A"的消息/);assert.match(h[1].content[1].text,/看这个$/);
 assert.deepEqual(h[2],{role:'user',content:'[用户撤回了一条消息]'});assert.deepEqual(h[3],{role:'assistant',content:'[AI撤回了一条消息]'});
 assert.equal(w.localStorage.getItem('dogchat_multi_messageHistory'),null);
});
test('background import with recall rebuilds history with images and user recall text',async t=>{
 const {w,api,id}=await app(t);const c=api.data().find(c=>c.id===id);
 c.chatMessages.push({id:'img',role:'user',text:'[图片]',imageDataUrl:'data:image/png;base64,CC',timestamp:Date.now()-500},{id:'gone',role:'user',text:'',recalled:true,timestamp:Date.now()-400});
 await w.__auditAdapter.importReplies([{id:'r9',charId:id,convId:'',timestamp:Date.now(),segments:['hi'],actions:[{type:'recall',segmentIndex:0}],isAutoReply:true}]);
 const h=api.data().find(c=>c.id===id).messageHistory;
 assert(h.some(x=>Array.isArray(x.content)&&x.content[0].image_url.url==='data:image/png;base64,CC'));
 assert(h.some(x=>x.role==='user'&&x.content==='[用户撤回了一条消息]'));
 assert(h.some(x=>x.role==='assistant'&&x.content==='[AI撤回了一条消息]'));
});
test('returning to live chat restores live summaries, deleting the open conversation too',async t=>{
 const {w,api,id}=await app(t);w.confirm=()=>true;const c=api.data().find(c=>c.id===id);
 api.setSums([{id:'L',content:'live',toIdx:1}]);
 api.setConvs([{id:'two',name:'two',timestamp:'',messages:[{id:'x',role:'user',text:'old',timestamp:1}],history:[],summaries:[{id:'C',content:'conv',toIdx:1}]}]);
 api.switchConv('two');assert.deepEqual(api.sums().map(s=>s.id),['C']);
 api.live();assert.deepEqual(api.sums().map(s=>s.id),['L']);
 api.switchConv('two');api.delConv('two');assert.deepEqual(api.sums().map(s=>s.id),['L']);
});
test('summary finished after switching conversation is stored in the original chat',async t=>{
 const gate=deferred(),started=deferred();
 const {w,api,id}=await app(t,async(u,init)=>{if(String(init.body).includes('叙事总结专家')){started.resolve();await gate.promise;return Response.json({choices:[{message:{content:'总结内容'}}]});}return Response.json({choices:[{message:{content:'reply'}}]});});
 w.confirm=()=>true;const c=api.data().find(c=>c.id===id);
 const m=api.msgs();for(let i=0;i<4;i++)m.push({id:'s'+i,role:i%2?'dog':'user',text:'m'+i,timestamp:Date.now()+i});
 api.setConvs([{id:'other',name:'o',timestamp:'',messages:[],history:[],summaries:[]}]);
 const p=api.summary(false);await started.promise;api.switchConv('other');gate.resolve();await p;
 assert.equal(api.sums().length,0,'not written into the conversation now open');
 assert.equal(api.data().find(c=>c.id===id).conversations.find(v=>v.id==='other').summaries?.length||0,0);
 api.live();assert.deepEqual(JSON.parse(JSON.stringify(api.sums().map(s=>s.content))),['总结内容']);assert.equal(api.sums()[0].toIdx,5);
});
test('red packet only reply: checks balance, is stored as a message and survives reload',async t=>{
 const {w,api,id}=await app(t,async()=>Response.json({choices:[{message:{content:'[红包:5:生日快乐]'}}]}));
 await api.request();
 let c=api.data().find(c=>c.id===id);assert(c.chatMessages.some(m=>m.text.includes('红包未发出')),'no balance → not sent, but shown');
 assert(!(await api.wallet()).some(t=>t.type==='hongbao'));
 await api.addTx({id:'top',charId:id,type:'topup',amount:10,timestamp:Date.now()});
 await api.request();c=api.data().find(c=>c.id===id);
 const hb=c.chatMessages.find(m=>m.backgroundHongbao);assert(hb);assert.equal(hb.backgroundHongbao.amount,5);assert.equal(hb.backgroundHongbao.note,'生日快乐');
 assert.equal((await api.wallet()).filter(t=>t.type==='hongbao').length,1);
 assert(!w.document.querySelector('#chatArea').textContent.includes('没有输出有效消息'));
 assert(w.document.querySelector('#msg-'+hb.id+' .hongbao-bubble'));
});
test('two quick ordinary requests only call the API once',async t=>{
 const {api,calls}=await app(t);await Promise.all([api.request(),api.request()]);assert.equal(calls.length,1);assert.equal(api.waiting(),false);
});
test('backup export strips API keys without touching memory',async t=>{
 const {api,id}=await app(t);const data=api.exportData();
 assert(data.dogchat_multi_characters.every(c=>!c.apiSettings||c.apiSettings.key===''));
 assert.equal(api.data().find(c=>c.id===id).apiSettings.key,'test-only');
});
test('BLE tags are stripped even when disabled; two-digit channel parsed',async t=>{
 const {api}=await app(t);api.bleOn(false);let r=api.ble('a[BLE:30:12]b');assert.equal(r.cleaned,'ab');assert.equal(r.bleMatches.length,0);
 api.bleOn(true);r=api.ble('[BLE:30:12]hi');assert.equal(r.cleaned,'hi');assert.deepEqual(JSON.parse(JSON.stringify(r.bleMatches)),[{val:30,ch:12}]);
});
