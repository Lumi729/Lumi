export function safeApiUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw new Error('API 地址必须为公开 HTTPS 地址');
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || /(^|\.)localhost$|\.local$|\.internal$/.test(host) || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) throw new Error('不支持本机、内网或 IP 地址');
  return url.href;
}
export function validateSubscription(sub) {
  if (!sub || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') throw new Error('推送订阅无效');
  const u = new URL(sub.endpoint);
  if (u.protocol !== 'https:' || u.username || u.password || u.port) throw new Error('推送地址无效');
  const hosts = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
  if (!hosts.includes(u.hostname)) throw new Error('暂不支持此浏览器的推送服务');
  return sub;
}
export function cleanReply(content, job) {
  let text = String(content || '').replace(/【思考过程】\s*[\s\S]*?\s*【思考结束】/gi, '').trim();
  if (text.startsWith('[AUTO_SKIP]')) return { skipped: true, reason: text.slice(11).trim().slice(0, 500), segments: [] };
  const actions = [];
  if (job?.actionVersion === 1) {
    for (const match of text.matchAll(/\[RECALL:(-?\d+)\]/g)) {
      const n = Number(match[1]);
      const target = n > 0 ? job.recallTargets?.[n-1] : null;
      if (target?.id) actions.push({type:'recall',targetId:target.id});
      else if (n <= 0) actions.push({type:'recall',segmentIndex:Math.abs(n)});
    }
    let balance = Number(job.walletBalance) || 0;
    for (const match of text.matchAll(/\[红包[:：](\d+(?:\.\d+)?)(?:[:：]([^\]]*))?\]/g)) {
      const amount = Math.round(Number(match[1])*100)/100;
      if (Number.isFinite(amount) && amount > 0 && amount <= balance) {
        actions.push({type:'hongbao',amount,note:(match[2]||'').slice(0,200)});
        balance = Math.round((balance-amount)*100)/100;
      }
    }
  }
  text = text.replace(/\[(?:RECALL:-?\d+|BLE[:：][^\]]*|红包[:：][^\]]*|改名[:：][^\]]*|切换[^\]]*)\]/g, '').trim();
  const segments = text.split(/\n{2,}/).map(x => x.trim()).filter(Boolean).slice(0, 5);
  if (!segments.length && !actions.length) throw new Error('回复为空');
  return { skipped: false, segments, ...(actions.length ? {actions} : {}) };
}
export function notificationBodies(segments) {
  return segments.length <= 3 ? segments.map(x => x.slice(0, 120))
    : [`（共${segments.length}条新消息）${segments.slice(0, 3).map(x => x.slice(0, 30)).join('；')}...`];
}
export function dayKey(now, offset) { return new Date(now - offset * 60000).toISOString().slice(0, 10); }
export function nextDay(now, offset) {
  const shifted = new Date(now - offset * 60000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) + offset * 60000;
}
export function dailyState(previous, job, now) {
  const day = dayKey(now, job.offset);
  if (previous?.day === day && previous.version === 2) return {...previous, quota:job.dailyMax};
  // Legacy counters included local activity. Remove that imported baseline once.
  const count = previous?.day === day ? Math.max(0, previous.count - (job.todayDate === day ? job.todayCount || 0 : 0)) : 0;
  return {version:2, day, count, quota:job.dailyMax, succeeded:0, failed:0, skipped:0};
}

function bytes64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function from64(text) { return Uint8Array.from(atob(text), x => x.charCodeAt(0)); }
async function storageKey(secret) {
  const bytes = from64(secret);
  if (bytes.length !== 32) throw new Error('加密密钥未配置');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await storageKey(secret), new TextEncoder().encode(JSON.stringify(value)));
  return { iv: bytes64(iv), data: bytes64(new Uint8Array(data)) };
}
export async function unseal(value, secret) {
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(value.iv) }, await storageKey(secret), from64(value.data));
  return JSON.parse(new TextDecoder().decode(data));
}
export async function sameToken(a, b) {
  if (!a || !b) return false;
  const hash = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const x = await hash(a), y = await hash(b);
  let diff = 0; for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]; return diff === 0;
}
export function validateJob(input, now) {
  const bounded = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  if (!input || !/^[\w-]{1,100}$/.test(input.charId) || typeof input.revision !== 'string' || input.revision.length > 150 || typeof input.convId !== 'string' || input.convId.length > 100) throw new Error('角色信息无效');
  if (!bounded(input.delayMinutes, 1, 120) || !bounded(input.dailyMin, 0, 20) || !bounded(input.dailyMax, input.dailyMin, 20) || !bounded(input.offset, -840, 840)) throw new Error('调度设置无效');
  if (!Number.isFinite(input.lastAt) || input.lastAt < now - 3650 * 86400000 || input.lastAt > now + 60000) throw new Error('消息时间无效');
  if (typeof input.key !== 'string' || input.key.length > 4096 || !input.key || typeof input.body?.model !== 'string' || !Array.isArray(input.body.messages)) throw new Error('AI 设置无效');
  if (input.body.messages.length > 100 || JSON.stringify(input.body).length > 180000) throw new Error('上下文过大');
  for (const m of input.body.messages) if (!['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw new Error('上下文格式无效');
  return { ...input, url: safeApiUrl(input.url), todayCount: Math.min(20, Math.max(0, Number(input.todayCount) || 0)), leaseUntil: now + 7 * 86400000 };
}

export function backgroundTiming(job, now) {
  const time = value => Number.isFinite(value) ? new Date(value - job.offset*60000).toISOString().replace('T',' ').replace('Z','') : '未知';
  const age = value => Number.isFinite(value) ? Math.max(0,Math.floor((now-value)/1000))+' 秒' : '未知';
  const timeline = job.timeline || [];
  const latestUser = job.latestUser || [...timeline].reverse().find(m=>m.role==='user');
  const latestAssistant = job.latestAssistant || [...timeline].reverse().find(m=>m.role==='assistant');
  const describe = m => m ? time(m.timestamp)+'；距现在 '+age(m.timestamp)+'；内容：'+m.content : '无记录';
  const waiting = latestUser && latestAssistant && latestAssistant.timestamp >= latestUser.timestamp;
  const latest = [latestUser,latestAssistant].filter(Boolean).sort((a,b)=>b.timestamp-a.timestamp)[0];
  const silence = latest ? age(latest.timestamp) : '时间未知';
  const autoPrompt = '\n## 自动回复\n你们已经 '+silence+' 没有聊天了。最后一条是「'+(latest?.role==='user' ? job.userName||'用户' : job.charName||'角色')+'」发的：「'+(latest?.content||'无记录')+'」。'+(waiting ? '之后「'+(job.userName||'用户')+'」一直没回复。' : '')+'\n请以「'+(job.charName||'角色')+'」的人设判断：在这个时间点，你会主动发消息吗？\n想发 → 按正常格式回复（会标注为自动回复）\n不想发 → 输出 [AUTO_SKIP] 理由\n';
  return '## 当前聊天时间与状态（每轮更新）\n当前用户本地时间：'+time(now)+
    '\n用户最后一次发言：'+describe(latestUser)+'\n角色最后一次发言：'+describe(latestAssistant)+
    '\n上下文消息时间线：\n'+timeline.map((m,i)=>time(m.timestamp)+' '+(m.role==='user'?'用户':'角色')+'；距前一条 '+(i && Number.isFinite(m.timestamp) && Number.isFinite(timeline[i-1].timestamp)?Math.max(0,Math.floor((m.timestamp-timeline[i-1].timestamp)/1000))+' 秒':'未知')+'；'+m.content).join('\n')+
    (job.manual ? '\n本轮是用户明确请求的普通回复。' : autoPrompt+'\n本轮是主动发言判断，不是重新回答用户最后一句。'+(waiting?'角色已在用户最后发言后回复，用户尚未再次回应。':'')+'结合完整的已提供上下文、双方最后发言及等待间隔判断是否有必要主动说话。不要重复已经答过的问题、换句话重说上一轮或虚构用户的新回复；没有自然的新内容就输出 [AUTO_SKIP] 理由。');
}
export function appendBackgroundContext(job, segments, now) {
  const message={role:'assistant',content:segments.join('\n\n'),timestamp:now};
  job.latestAssistant=message;job.timeline=[...(job.timeline||[]),message].slice(-40);
}

export function applyReplyActionsToJob(job, reply) {
  const recalled = new Set((reply.actions||[]).filter(a=>a.type==='recall').map(a=>a.targetId || 'bg_'+reply.id+'_'+a.segmentIndex));
  for (const target of job.recallTargets||[]) {
    if (!recalled.has(target.id)) continue;
    for (let i=job.body.messages.length-1;i>=1;i--) {
      const m=job.body.messages[i];
      if (m.role==='assistant' && m.content.includes(target.text)) { m.content=m.content.replace(target.text,'[AI撤回了一条消息]'); break; }
    }
    for (const m of job.timeline||[]) if (m.content===target.text) m.content='[AI撤回了一条消息]';
    if (job.latestAssistant?.content===target.text) job.latestAssistant.content='[AI撤回了一条消息]';
  }
  job.recallTargets=[...reply.segments.map((text,i)=>({id:'bg_'+reply.id+'_'+i,text})).reverse(),...(job.recallTargets||[])].filter(t=>!recalled.has(t.id)).slice(0,100);
  const spent=(reply.actions||[]).filter(a=>a.type==='hongbao').reduce((sum,a)=>sum+a.amount,0);
  job.walletBalance=Math.max(0,Math.round(((Number(job.walletBalance)||0)-spent)*100)/100);
}
