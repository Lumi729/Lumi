import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {IDBFactory} from 'fake-indexeddb';
const source=fs.readFileSync(new URL('../../sw.js',import.meta.url),'utf8');
function worker(showNotification,indexedDB){
 const handlers={};
 vm.runInNewContext(source,{URL,Request,console,indexedDB,setTimeout,clearTimeout,self:{location:{origin:'https://lumi729.github.io'},addEventListener:(type,fn)=>handlers[type]=fn,registration:{showNotification},clients:{matchAll:async()=>[]}}});
 return (texts,push=false)=>{let done,result;const notices=texts.map(body=>({title:'reply',options:{body,tag:body,data:{charId:'a'}}}));
 const event={source:{url:'https://lumi729.github.io/Lumi/'},data:push?{json:()=>({type:'LUMOS_PUSH_REPLY',notices})}:{type:'LUMOS_NOTIFY_BATCH',notices},ports:[{postMessage:r=>result=r}],waitUntil:p=>done=p};handlers[push?'push':'message'](event);return {done:()=>done,result:()=>result};};
}
test('entire batch finishes without a second message or live page',async()=>{const shown=[];const send=worker(async(title,options)=>shown.push(options.body));const job=send(['first','middle','last']);await job.done();assert.deepEqual(shown,['first','middle','last']);assert.equal(job.result().sent,3);assert.equal(job.result().items.length,3);});
test('later push cannot interleave an unfinished local batch',async()=>{const shown=[];let release;const gate=new Promise(r=>release=r);const send=worker(async(title,options)=>{shown.push(options.body);if(options.body==='a1')await gate;});const a=send(['a1','a2','a3']);const b=send(['b1','b2'],true);await Promise.resolve();assert.deepEqual(shown,['a1']);release();await Promise.all([a.done(),b.done()]);assert.deepEqual(shown,['a1','a2','a3','b1','b2']);});
test('failed middle notification does not strand tail or next round',async()=>{const shown=[];const send=worker(async(title,options)=>{shown.push(options.body);if(options.body==='bad')throw new Error('failed');});const a=send(['first','bad','last']);await a.done();const b=send(['next']);await b.done();assert.deepEqual(shown,['first','bad','last','next']);assert.equal(a.result().sent,2);assert.equal(a.result().failed,1);});

test('background push gets original role image from device database without open page',async()=>{
 const indexedDB=new IDBFactory();
 await new Promise((resolve,reject)=>{const r=indexedDB.open('lumos_chars_v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('chars');r.onerror=reject;r.onsuccess=()=>{const db=r.result,tx=db.transaction('chars','readwrite');tx.objectStore('chars').put([{id:'a',avatarType:'image',avatarSrc:'data:image/png;base64,AAA'}],'main');tx.oncomplete=()=>{db.close();resolve();};};});
 const icons=[];const send=worker(async(title,options)=>icons.push(options.icon),indexedDB);await send(['reply'],true).done();assert.deepEqual(icons,['data:image/png;base64,AAA']);
});
