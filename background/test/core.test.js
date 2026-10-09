import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationBodies, cleanReply, safeApiUrl, seal, unseal, sameToken, dayKey, nextDay, dailyState, validateJob, validateSubscription } from '../src/core.js';
const secret = Buffer.alloc(32, 7).toString('base64');
export const job = (now = Date.now()) => ({ charId:'char_demo',convId:'',revision:'one',url:'https://api.example.com/v1/chat/completions',key:'test-only-key',body:{model:'demo',messages:[{role:'system',content:'demo'},{role:'user',content:'hello'}]},lastAt:now-60000,delayMinutes:1,dailyMin:2,dailyMax:2,offset:-480,todayCount:0,todayDate:'' });
test('one to three separate notices, more than three summarized', () => {
  assert.deepEqual(notificationBodies(['a','b','c']),['a','b','c']);
  assert.equal(notificationBodies(['a','b','c','d']).length,1);
  assert.match(notificationBodies(['a','b','c','d'])[0],/共4条/);
});
test('reasoning and controls never become push text, skips do not notify', () => {
  assert.deepEqual(cleanReply('【思考过程】private【思考结束】\nhello[BLE:40]\n\nworld[RECALL:1][红包:5]'),{skipped:false,segments:['hello','world']});
  assert.equal(cleanReply('[AUTO_SKIP] later').skipped,true);
  assert.throws(()=>cleanReply('【思考过程】only【思考结束】'));
});
test('encrypted storage hides key and message; wrong secret fails', async () => {
  const input={key:'private-key',message:'private-message'};
  const encrypted=await seal(input,secret); assert.ok(!JSON.stringify(encrypted).includes('private'));
  assert.deepEqual(await unseal(encrypted,secret),input);
  await assert.rejects(()=>unseal(encrypted,Buffer.alloc(32,8).toString('base64')));
  assert.equal(await sameToken('test','test'),true);assert.equal(await sameToken('test','other'),false);assert.equal(await sameToken('',''),false);
});
test('daily limit resets at phone local midnight; fixed quota per day', () => {
  const now=Date.parse('2026-10-09T15:59:00Z'),j=job(now);
  assert.equal(dayKey(now,-480),'2026-10-09');assert.equal(nextDay(now,-480),Date.parse('2026-10-09T16:00:00Z'));
  const daily=dailyState(null,j,now,()=>0);assert.equal(daily.quota,2);daily.count=2;
  assert.equal(dailyState(daily,j,now,()=>0.9).count,2);assert.equal(dailyState(daily,j,now+60000).count,0);
});
test('reject unsafe endpoints, malformed jobs, and arbitrary push proxy requests', () => {
  for(const value of ['http://api.example.com','https://127.0.0.1/','https://[::1]/','https://localhost/','https://x.local/','https://name:pass@api.example.com/']) assert.throws(()=>safeApiUrl(value));
  assert.throws(()=>validateJob({...job(),dailyMax:30},Date.now()));
  assert.throws(()=>validateSubscription({endpoint:'https://api.example.com/',keys:{p256dh:'a',auth:'b'}}));
  assert.equal(validateJob(job(),Date.now()).delayMinutes,1);
});

test('backend uses maximum and never imports local counters into new day',()=>{
 const now=Date.now(),j={...job(now),dailyMin:1,dailyMax:5,todayDate:dayKey(now,-480),todayCount:3};
 const fresh=dailyState(null,j,now);assert.equal(fresh.count,0);assert.equal(fresh.quota,5);
 const migrated=dailyState({day:j.todayDate,count:3,quota:1},j,now);assert.equal(migrated.count,0);
 migrated.count=2;assert.equal(dailyState(migrated,j,now).count,2);
 assert.equal(dailyState(migrated,{...j,dailyMax:8},now).quota,8);
});
