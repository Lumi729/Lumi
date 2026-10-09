import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationBodies, cleanReply, safeApiUrl, seal, unseal, sameToken, dayKey, nextDay, dailyState, backgroundTiming, appendBackgroundContext, validateJob, validateSubscription } from '../src/core.js';
const secret = Buffer.alloc(32, 7).toString('base64');
export const job = (now = Date.now()) => ({ charId:'char_demo',convId:'',revision:'one',url:'https://api.example.com/v1/chat/completions',key:'test-only-key',body:{model:'demo',messages:[{role:'system',content:'demo'},{role:'user',content:'hello'}]},lastAt:now-60000,delayMinutes:1,dailyMin:2,dailyMax:2,offset:-480,todayCount:0,todayDate:'' });
test('one to three separate notices, more than three summarized', () => {
  assert.deepEqual(notificationBodies(['a','b','c']),['a','b','c']);
  assert.equal(notificationBodies(['a','b','c','d']).length,1);
  assert.match(notificationBodies(['a','b','c','d'])[0],/共4条/);
});
test('reasoning and controls never become push text, skips do not notify', () => {
  assert.deepEqual(cleanReply('【思考过程】private【思考结束】\nhello[BLE:40]\n\nworld[RECALL:1][红包:5]'),{skipped:false,segments:['hello','world'],reasoning:'private'});
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

test('background timing keeps user age distinct and advances role after autonomous replies',()=>{
 const now=Date.now(),j={offset:-480,latestUser:{role:'user',content:'old question',timestamp:now-600000},timeline:[{role:'user',content:'old question',timestamp:now-600000}]};
 appendBackgroundContext(j,['already answered'],now-120000);appendBackgroundContext(j,['new topic'],now-60000);
 const prompt=backgroundTiming(j,now);assert.match(prompt,/600 秒/);assert.match(prompt,/60 秒/);assert.match(prompt,/already answered/);assert.match(prompt,/new topic/);assert.match(prompt,/用户尚未再次回应/);assert.match(prompt,/不是重新回答用户最后一句/);
});

test('background controls are retained as actions with pinned recall IDs and capped wallet',()=>{
 const j={actionVersion:1,walletBalance:8,recallTargets:[{id:'old',text:'old text'}]};
 const r=cleanReply('new[RECALL:1][红包:5:给你][红包:5:超额][BLE:50]',j);
 assert.deepEqual(r.segments,['new']);assert.deepEqual(r.actions,[{type:'recall',targetId:'old'},{type:'hongbao',amount:5,note:'给你'}]);
 assert.equal(cleanReply('[红包:5]',j).actions[0].amount,5);
 assert.equal(cleanReply('new[RECALL:0]',j).actions[0].segmentIndex,0);
 assert.match(backgroundTiming({...j,offset:0,charName:'长夏',userName:'你',latestAssistant:{role:'assistant',content:'刚才说的话',timestamp:Date.now()-60000}},Date.now()),/你们已经 .*没有聊天了/);
});

test('API reasoning and think blocks remain separate from notification text',()=>{
 const r=cleanReply('<think>internal</think>Hello',null,'API thought');
 assert.equal(r.reasoning,'API thought');assert.deepEqual(notificationBodies(r.segments),['Hello']);
 assert.equal(cleanReply('<think>wait</think>[AUTO_SKIP] later').skipped,true);
});
