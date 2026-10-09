import { buildPushPayload } from '@block65/webcrypto-web-push';
import { validateJob, validateSubscription, sameToken, seal, unseal, cleanReply, notificationBodies, dailyState, nextDay } from './core.js';

const json = (data, status = 200) => Response.json(data, { status });
const LIMIT = 250000;
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = env.APP_ORIGIN;
    const headers = { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Vary': 'Origin', 'Cache-Control': 'no-store' };
    if (origin && origin !== allowed) return json({ error: '来源不允许' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    let response;
    try {
      const path = new URL(request.url).pathname;
      if (path === '/health') {
        const missing = ['ACCESS_TOKEN', 'STORAGE_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'].filter(name => !env[name]);
        response = json({ service: 'Lumos background', version: 3, configured: missing.length === 0, missing });
      }
      else if (!env.ACCESS_TOKEN || !env.STORAGE_KEY || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) response = json({ error: '请先完成后台密钥配置' }, 503);
      else if (!await sameToken(request.headers.get('Authorization')?.replace(/^Bearer /, ''), env.ACCESS_TOKEN)) response = json({ error: '后台连接口令不正确' }, 401);
      else if (path === '/config' && request.method === 'GET') response = json({ publicKey: env.VAPID_PUBLIC_KEY });
      else {
        if (Number(request.headers.get('Content-Length')) > LIMIT) return new Response('请求过大', { status: 413, headers });
        const body = await request.text();
        if (body.length > LIMIT) return new Response('请求过大', { status: 413, headers });
        const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName('owner'));
        response = await stub.fetch(new Request(request.url, { method: request.method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body } : {}) }));
      }
    } catch (_) { response = json({ error: '后台请求失败，请检查配置' }, 500); }
    const result = new Response(response.body, response); for (const [key, value] of Object.entries(headers)) result.headers.set(key, value); return result;
  }
};

export class LumosScheduler {
  constructor(state, env) { this.state = state; this.env = env; }
  async load() {
    const encrypted = await this.state.storage.get('owner');
    return encrypted ? unseal(encrypted, this.env.STORAGE_KEY) : { jobs: {}, inbox: [], daily: {}, subscription: null, heartbeat: null };
  }
  async save(data) { await this.state.storage.put('owner', await seal(data, this.env.STORAGE_KEY)); }
  async schedule(data) {
    const now = Date.now();
    const deadlines = Object.values(data.jobs).filter(j => j.leaseUntil > now).map(j => j.nextAt);
    for (const pendingReply of Object.values(data.requests || {})) deadlines.push(pendingReply.nextAt);
    const pending = data.inbox.filter(r => r.pushState === 'pending' && r.pushAttempts < 3);
    if (pending.length && data.subscription) deadlines.push(now + 60000);
    if (deadlines.length) await this.state.storage.setAlarm(Math.max(now + 1000, Math.min(...deadlines)));
    else await this.state.storage.deleteAlarm();
  }
  async fetch(request) {
    return this.state.blockConcurrencyWhile(async () => {
      const path = new URL(request.url).pathname, data = await this.load();
      try {
        if (path === '/state' && request.method === 'GET') return json({ inbox: data.inbox.filter(r => !r.acked), jobs: Object.values(data.jobs).map(j => ({ charId: j.charId, convId: j.convId, nextAt: j.nextAt, leaseUntil: j.leaseUntil, error: j.error || null, daily: data.daily[j.charId] })), heartbeat: data.heartbeat, subscribed: Boolean(data.subscription), pendingReplies: Object.values(data.requests || {}).map(r => ({id:r.requestId,charId:r.charId,convId:r.convId,state:r.state})) });
        if (path === '/presence' && request.method === 'POST') { const presence = await request.json(); data.presence = { charId:typeof presence.charId === 'string' ? presence.charId.slice(0,100) : null, convId:typeof presence.convId === 'string' ? presence.convId.slice(0,100) : '', until:Date.now()+45000 }; }
        else if (path === '/subscription' && request.method === 'POST') { data.subscription = validateSubscription(await request.json()); }
        else if (path === '/reply' && request.method === 'POST') {
          const input = await request.json();
          if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId)) throw new Error('请求编号无效');
          const requestJob = validateJob(input, Date.now());
          data.requests ||= {};
          if (Object.values(data.requests).some(r => r.requestId === input.requestId) || data.inbox.some(r => r.id === input.requestId)) return json({ok:true});
          if (data.requests[input.charId]) return json({error:'上一轮普通回复仍在后台处理中，请先同步结果'},409);
          if (data.inbox.some(r => r.charId === input.charId && !r.acked)) return json({error:'请先同步后台消息'},409);
          requestJob.requestId = input.requestId; requestJob.nextAt = Date.now()+1000; requestJob.state = 'queued';
          data.requests[input.charId] = requestJob;
          // 显式回复优先，取消正在生成的旧自动回复结果，避免同轮双发。
          if (data.jobs[input.charId]) { data.jobs[input.charId].runId = null; data.jobs[input.charId].runUntil = 0; data.jobs[input.charId].nextAt = Date.now() + requestJob.delayMinutes*60000; }
        }
        else if (path === '/job' && request.method === 'POST') {
          const job = validateJob(await request.json(), Date.now());
          const old = data.jobs[job.charId];
          if (!old && Object.keys(data.jobs).length >= 20) return json({ error: '最多启用 20 个后台角色' }, 400);
          // 未同步的后台回复先回到手机，不能用旧页面快照覆盖后台新上下文。
          if (data.inbox.some(r => r.charId === job.charId && !r.acked)) return json({ error: '请先同步后台消息' }, 409);
          job.nextAt = old?.revision === job.revision ? old.nextAt : Math.max(Date.now() + 1000, job.lastAt + job.delayMinutes * 60000);
          if (old?.revision === job.revision) { job.runId = old.runId; job.runUntil = old.runUntil; }
          const previousDaily = data.daily[job.charId];
          const daily = dailyState(previousDaily, job, Date.now());
          data.daily[job.charId] = daily;
          if (old && previousDaily && (previousDaily.version !== 2 || previousDaily.count >= previousDaily.quota) && daily.count < daily.quota && !(old.runUntil > Date.now())) {
            job.nextAt = Math.max(Date.now()+1000, job.lastAt + job.delayMinutes*60000);
          }
          if (old?.revision === job.revision) job.error = old.error;
          data.jobs[job.charId] = job;
        }
        else if (path === '/job' && request.method === 'DELETE') { const { charId } = await request.json(); delete data.jobs[charId]; }
        else if (path === '/ack' && request.method === 'POST') {
          const { ids } = await request.json(); if (!Array.isArray(ids) || ids.length > 100) throw new Error('同步信息无效');
          // 同步成功也保留待推送记录，避免页面确认吞掉尚未发送的推送。
          data.inbox = data.inbox.filter(r => !ids.includes(r.id) || r.pushState === 'pending');
          data.inbox.forEach(r => { if (ids.includes(r.id)) r.acked = true; });
        }
        else if (path === '/test' && request.method === 'POST') {
          if (!data.subscription) return json({ error: '手机尚未订阅推送' }, 400);
          const ok = await this.push(data.subscription, { id: crypto.randomUUID(), charId: null, segments: ['Lumos 后台已连通～这是一条测试通知。'] });
          return json({ submitted: ok });
        }
        else if (path === '/reset' && request.method === 'DELETE') { await this.state.storage.deleteAll(); await this.state.storage.deleteAlarm(); return json({ deleted: true }); }
        else return json({ error: '接口不存在' }, 404);
        await this.save(data); await this.schedule(data); return json({ ok: true });
      } catch (error) { return json({ error: error.message }, 400); }
    });
  }
  async push(subscription, reply) {
    const notices = notificationBodies(reply.segments).map((body, index) => ({ title: 'TA想对你说的是...', options: { body, tag: 'lumos-push-' + reply.id + '-' + index, data: { charId: reply.charId, replyId: reply.id } } }));
    const payload = await buildPushPayload({ data: JSON.stringify({ type: 'LUMOS_PUSH_REPLY', notices }), options: { ttl: 86400 } }, subscription, { subject: this.env.VAPID_SUBJECT, publicKey: this.env.VAPID_PUBLIC_KEY, privateKey: this.env.VAPID_PRIVATE_KEY });
    const response = await fetch(subscription.endpoint, { ...payload, signal: AbortSignal.timeout(15000) });
    if (response.status === 404 || response.status === 410) return 'expired';
    if (!response.ok) throw new Error('推送服务未接收');
    return true;
  }
  async alarm() {
    // 每次只预约一轮请求；预约先持久化，闹钟重试不重复调用付费 AI。
    let reserved;
    await this.state.blockConcurrencyWhile(async () => {
      const data = await this.load(), now = Date.now();
      data.heartbeat = now;
      data.requests ||= {};
      for (const [id, request] of Object.entries(data.requests)) {
        if (request.nextAt > now || reserved) continue;
        if (request.state === 'running') {
          // 进程异常后付费请求的结果未知，不重新发起同一轮。
          data.inbox.push({id:request.requestId,charId:id,convId:request.convId,timestamp:now,segments:[],error:'后台普通回复中断，结果未知；请手动重试',isAutoReply:false,pushState:'skipped',pushAttempts:0});
          delete data.requests[id]; continue;
        }
        request.state = 'running'; request.nextAt = now+120000; request.runId = request.requestId;
        reserved = structuredClone(request); reserved.manual = true;
      }
      for (const [id, job] of Object.entries(data.jobs)) {
        if (job.leaseUntil <= now) { delete data.jobs[id]; continue; }
        if (data.requests[id]) { job.nextAt = Math.max(job.nextAt, data.requests[id].nextAt); continue; }
        if (job.nextAt > now || reserved || (job.runUntil || 0) > now) continue;
        if (data.inbox.filter(r => r.charId === id && !r.acked).length >= 40) { job.nextAt = nextDay(now, job.offset); job.error = '待同步消息较多，打开 Lumos 同步后继续'; continue; }
        const daily = dailyState(data.daily[id], job, now); data.daily[id] = daily;
        if (daily.count >= daily.quota) { job.nextAt = nextDay(now, job.offset); continue; }
        daily.count++;
        const runId = crypto.randomUUID(); job.runId = runId; job.runUntil = now + 120000; job.nextAt = Math.max(job.runUntil, now + job.delayMinutes * 60000); job.error = null;
        reserved = structuredClone(job); reserved.runId = runId;
      }
      await this.save(data); await this.schedule(data);
    });
    if (reserved) {
      let reply, error, stage = 'request';
      try {
        const body = structuredClone(reserved.body);
        body.messages = [...body.messages, { role: 'system', content: `${reserved.manual ? '这是用户已明确请求的一轮普通回复，请直接回复最近用户消息，不输出 [AUTO_SKIP]。' : '这是服务端后台自动回复。'}实际当前时间：${new Date().toISOString()}。距最近消息约 ${Math.max(0, Math.floor((Date.now() - reserved.lastAt) / 60000))} 分钟；如早期快照时间描述冲突，以此为准。只输出聊天文本，用空行分段；不执行撤回、红包、蓝牙或场景切换。${reserved.manual ? '' : '不想主动聊天可输出 [AUTO_SKIP] 理由。'}` }];
        const response = await fetch(reserved.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reserved.key }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000), redirect: 'error' });
        if (!response.ok) throw new Error('AI 接口返回 HTTP ' + response.status);
        stage = 'decode';
        const raw = await response.text();
        if (/^\s*</.test(raw)) throw new Error('AI_RESPONSE_HTML');
        if (/^\s*data:/.test(raw)) throw new Error('AI_RESPONSE_STREAM');
        const result = JSON.parse(raw);
        stage = 'content';
        if (result.error) throw new Error('AI_RESPONSE_ERROR');
        const message = result.choices?.[0]?.message;
        if (!message?.content?.trim()) throw new Error(message?.reasoning_content ? 'AI_REASONING_ONLY' : 'AI_EMPTY');
        reply = cleanReply(message.content);
        if (reserved.manual && reply.skipped) throw new Error('普通回复未返回聊天文本');
      } catch (e) {
        const reasons = {
          AI_RESPONSE_HTML:'AI 地址返回了网页，可能是验证页或重定向页面',
          AI_RESPONSE_STREAM:'AI 接口返回了流式内容，后台目前需要 JSON 回复',
          AI_RESPONSE_ERROR:'AI 接口返回了错误对象，请检查服务商的请求记录',
          AI_REASONING_ONLY:'AI 只返回了思考内容，没有聊天正文，可能耗尽了输出长度',
          AI_EMPTY:'AI 返回了空正文或不兼容的回复格式',
          '回复为空':'AI 正文过滤后为空',
          '普通回复未返回聊天文本':'AI 未返回普通回复正文'
        };
        const reason = reasons[e.message] || (/^AI 接口返回 HTTP \d+$/.test(e.message) ? e.message :
          ['TimeoutError','AbortError'].includes(e.name) ? 'AI 请求超过 90 秒未完成' :
          stage === 'decode' ? 'AI 返回内容不是有效 JSON' :
          stage === 'request' ? 'Cloudflare 无法完成到 AI 地址的网络请求（连接、证书或重定向失败）' : 'AI 回复解析失败');
        error = reason + '；本轮不自动重试，避免重复扣费';
      }
      await this.state.blockConcurrencyWhile(async () => {
        const data = await this.load(), current = reserved.manual ? data.requests?.[reserved.charId] : data.jobs[reserved.charId];
        // 新消息/关闭开关/删除任务在生成期间发生时，丢弃过期结果。
        if (!current || current.revision !== reserved.revision || current.runId !== reserved.runId) return;
        if (reserved.manual) {
          delete data.requests[reserved.charId];
          if (data.jobs[reserved.charId]) data.jobs[reserved.charId].nextAt = Date.now()+current.delayMinutes*60000;
        }
        if (!reserved.manual) {
          const daily = data.daily[reserved.charId];
          if (daily) { const field = error ? 'failed' : reply.skipped ? 'skipped' : 'succeeded'; daily[field] = (daily[field] || 0) + 1; }
        }
        current.runUntil = 0; current.nextAt = Date.now() + current.delayMinutes * 60000;
        if (error) {
          current.error = error;
          if (reserved.manual) data.inbox.push({id:reserved.runId,charId:reserved.charId,convId:reserved.convId,timestamp:Date.now(),segments:[],error,isAutoReply:false,pushState:'skipped',pushAttempts:0});
        }
        else {
          const now = Date.now();
          const item = { ...reply, id: reserved.runId, charId: reserved.charId, convId: reserved.convId, timestamp: now, pushState: reply.skipped ? 'skipped' : reserved.notificationsEnabled === false ? 'muted' : 'pending', pushAttempts: 0, isAutoReply:!reserved.manual, daily: data.daily[reserved.charId] };
          if (!reply.skipped && data.presence?.charId === item.charId && data.presence.convId === item.convId && data.presence.until > now) item.pushState = 'viewing';
          data.inbox.push(item);
          if (reserved.manual && data.jobs[reserved.charId] && !reply.skipped) {
            const autoJob = data.jobs[reserved.charId];
            autoJob.lastAt = now; autoJob.body.messages.push({role:'assistant',content:reply.segments.join('\n\n')});
            autoJob.body.messages = [autoJob.body.messages[0], ...autoJob.body.messages.slice(1).slice(-40)];
          }
          if (!reply.skipped) {
            current.lastAt = now;
            // 最近上下文追加后台已发送的内容；原始系统设定不裁掉。
            current.body.messages.push({ role: 'assistant', content: reply.segments.join('\n\n') });
            current.body.messages = [current.body.messages[0], ...current.body.messages.slice(1).slice(-40)];
          }
        }
        await this.save(data); await this.schedule(data);
      });
    }
    // 记录 push 提交状态；重试使用同一个通知 tag，手机端覆盖而不是叠加。
    const queued = await this.load();
    for (const item of queued.inbox.filter(r => r.pushState === 'pending' && r.pushAttempts < 3)) {
      if (!queued.subscription) break;
      let status = 'pending';
      try { status = await this.push(queued.subscription, item); } catch (_) {}
      await this.state.blockConcurrencyWhile(async () => {
        const data = await this.load(), saved = data.inbox.find(r => r.id === item.id);
        if (!saved) return;
        saved.pushAttempts++;
        if (status === true) saved.pushState = 'submitted';
        else if (status === 'expired') { data.subscription = null; saved.pushState = 'subscription-expired'; }
        else if (saved.pushAttempts >= 3) saved.pushState = 'failed';
        data.inbox = data.inbox.filter(r => !(r.acked && r.pushState !== 'pending'));
        await this.save(data); await this.schedule(data);
      });
    }
  }
}
