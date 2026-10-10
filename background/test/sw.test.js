import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../../sw.js',import.meta.url),'utf8');
// Run sw.js with a minimal worker stand-in and return its fetch handler.
function worker({online}){
 const handlers={},cached=new Map([['https://lumi729.github.io/Lumi/',new Response('cached app')]]);
 const cache={match:async req=>cached.get(typeof req==='string'?req:req.url),put:async()=>{},addAll:async()=>{}};
 const self={location:new URL('https://lumi729.github.io/Lumi/sw.js'),addEventListener:(type,fn)=>{handlers[type]=fn;},registration:{},clients:{}};
 vm.runInNewContext(source,{self,caches:{open:async()=>cache,keys:async()=>[]},fetch:async()=>{if(!online)throw new TypeError('offline');return new Response('network app');},URL,Request,Response,Set,Promise,setTimeout,clearTimeout,console});
 return handlers.fetch;
}
async function open(handler,url,mode='navigate'){
 let response=null;handler({request:{method:'GET',mode,url},respondWith:p=>{response=p;}});
 return response&&(await response).text();
}
test('offline navigation under /Lumi/ (e.g. notification click) falls back to cached app',async()=>{
 const fetchHandler=worker({online:false});
 assert.equal(await open(fetchHandler,'https://lumi729.github.io/Lumi/?notificationChat=abc'),'cached app');
});
test('online navigation goes to the network; other paths are left alone',async()=>{
 const fetchHandler=worker({online:true});
 assert.equal(await open(fetchHandler,'https://lumi729.github.io/Lumi/?notificationChat=abc'),'network app');
 assert.equal(await open(fetchHandler,'https://lumi729.github.io/other/'),null);
 assert.equal(await open(fetchHandler,'https://lumi729.github.io/Lumi/api/x','cors'),null);
});
test('cache version bumped',()=>{assert.match(source,/CACHE_NAME = 'lumos-v27'/);});
