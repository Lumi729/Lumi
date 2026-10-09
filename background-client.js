/* Cloudflare connection is opt-in. Credentials stay in this browser, outside chat exports. */
window.createLumosBackground = function(adapter) {
  const storageName = 'lumos_background_connection_v1';
  let config = {}; try { config = JSON.parse(localStorage.getItem(storageName) || '{}'); } catch (_) {}
  let busy = false, dirty = false, timer = null;
  const box = document.createElement('div');
  box.id = 'lumosBackgroundPanel';
  box.style.cssText = 'border-top:1px solid #ddd;margin-top:24px;padding-top:20px';
  const style = document.createElement('style');
  style.textContent = `
    #lumosBackgroundPanel { color:#202a26; font-size:15px; line-height:1.6; min-width:0; }
    #lumosBackgroundPanel h4 { font-size:20px; line-height:1.4; margin:0 0 12px; }
    #lumosBackgroundPanel .hint-text { color:#59645e; font-size:14px; line-height:1.65; margin:10px 0 16px; }
    #lumosBackgroundPanel .setting-row { display:flex; flex-direction:column; align-items:stretch; gap:7px; margin:18px 0; }
    #lumosBackgroundPanel .setting-row label { flex:none; width:auto; font-size:15px; font-weight:600; color:#27352c; }
    #lumosBackgroundPanel input[type=url], #lumosBackgroundPanel input[type=password] { box-sizing:border-box; display:block; width:100%; min-width:0; height:48px; padding:12px; border:1px solid #c8d4cc; border-radius:12px; background:#f7faf8; color:#202a26; font:inherit; font-size:16px; }
    #lumosBackgroundPanel input::placeholder { color:#69776e; opacity:1; }
    #lumosBackgroundPanel input:focus { outline:2px solid #178751; outline-offset:2px; }
    #lumosBackgroundPanel .bg-consent { display:flex; align-items:flex-start; gap:10px; font-size:14px; margin:18px 0; color:#34443a; }
    #lumosBackgroundPanel input[type=checkbox] { flex:none; width:20px; height:20px; margin:3px 0 0; accent-color:#13834b; }
    #lumosBackgroundPanel .bg-actions { display:grid; grid-template-columns:minmax(0,1fr); gap:12px; margin:20px 0; }
    #lumosBackgroundPanel .gen-btn { position:static; display:block; box-sizing:border-box; width:100%; min-height:48px; height:auto; margin:0; padding:12px 14px; border-radius:12px; border:1px solid #178751; background:#fff; color:#176b41; font:inherit; font-weight:600; line-height:1.5; white-space:normal; }
    #lumosBackgroundPanel #bgConnect { background:#13834b; color:#fff; }
    #lumosBackgroundPanel #bgStop { border-color:#dac9c9; color:#904545; }
    #lumosBackgroundPanel .gen-btn:disabled { opacity:.55; }
    #lumosBackgroundPanel #bgStatus { clear:both; padding:14px; border:1px solid #d5e4da; border-radius:12px; background:#f0f7f2; color:#33483b; overflow-wrap:anywhere; margin:16px 0; }
    #lumosBackgroundPanel #bgStatus[data-error=true] { background:#fff4ef; border-color:#eccdbf; color:#86452e; }
    #lumosBackgroundPanel a { display:inline-block; font-size:14px !important; color:#176b41; padding:4px 0; }
  `;
  document.head.appendChild(style);
  box.innerHTML = `<h4 style="margin-bottom:10px">☁️ 后台回复与通知</h4>
    <div class="hint-text">连接你自己的 Cloudflare 后台后，关掉页面也可继续普通回复及定时生成回复。本版支持一个单人聊天角色；群聊仍需页面运行。</div>
    <div class="setting-row"><label>后台地址</label><input id="bgUrl" type="url" placeholder="https://lumos-background.…workers.dev"></div>
    <div class="setting-row"><label>连接口令</label><input id="bgToken" type="password" autocomplete="off" placeholder="部署时生成的连接口令"></div>
    <div class="hint-text">启用会把当前角色的 API 密钥、设定和所选上下文上传到你自己的后台，加密保存用于调用 AI。7 天不打开本机页面则暂停调度；生成结果会在回来时同步。后台不执行蓝牙、红包、撤回或跨聊指令。</div>
    <label class="bg-consent"><input id="bgConsent" type="checkbox"><span>我同意上传这些信息到我填写的后台</span></label>\n    <div class="bg-actions">
    <button id="bgConnect" class="gen-btn" type="button">为当前角色启用后台</button>
    <button id="bgTest" class="gen-btn" type="button">测试手机推送</button>
    <button id="bgSync" class="gen-btn" type="button">同步后台消息</button>
    <button id="bgStop" class="gen-btn" type="button">关闭并删除后台数据</button>
    </div>\n    <div id="bgStatus" class="hint-text" role="status" style="white-space:pre-wrap"></div>
    <a href="https://github.com/Lumi729/Lumi/blob/main/background/README.md" target="_blank" rel="noopener" style="font-size:12px">查看部署步骤</a>`;
  document.getElementById('settingsApi').appendChild(box);
  const el = name => box.querySelector('#' + name);
  el('bgUrl').value = config.url || ''; el('bgToken').value = config.token || '';
  function status(text, error = false) { el('bgStatus').textContent = text; el('bgStatus').dataset.error = String(error); }
  function persist() { localStorage.setItem(storageName, JSON.stringify(config)); }
  async function api(path, method = 'GET', body) {
    const response = await fetch(config.url + path, { method, headers: { Authorization: 'Bearer ' + config.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000), keepalive: path === '/presence', credentials: 'omit', redirect: 'error' });
    const raw = await response.text();
    let result;
    try { result = JSON.parse(raw); } catch (_) {
      throw new Error(`后台返回了网页而不是连接数据（HTTP ${response.status}）。请确认后台地址使用 workers.dev 根地址，不带 /health，并检查 Cloudflare 是否显示验证或错误页面`);
    }
    if (!response.ok) { const error = new Error(result.error || '后台请求失败'); error.status = response.status; throw error; } return result;
  }
  function managed(id) { return Boolean(config.enabled && config.charId === id); }
  async function sync() {
    if (!config.enabled) return;
    if (busy || adapter.isBusy()) { dirty = true; return; }
    busy = true; dirty = false;
    try {
      await api('/presence', 'POST', adapter.presence());
      const remote = await api('/state');
      if (adapter.isBusy()) { dirty = true; return; }
      const ids = await adapter.importReplies(remote.inbox || []);
      const pending = remote.pendingReplies?.find(r => r.charId === config.charId);
      adapter.pending(config.charId, Boolean(pending));
      if (ids.length) await api('/ack', 'POST', { ids });
      const current = await adapter.snapshot(config.charId);
      if (current?.disabled) {
        await api('/job', 'DELETE', { charId: config.charId });
        status('主动回复调度已暂停。普通回复仍可使用后台；请保持该角色的 AI 已启用。');
      } else if (current) {
        try { await api('/job', 'POST', current); } catch (error) { if (error.status === 409) { dirty = true; } else throw error; }
        status(`已连接：${adapter.name(config.charId)}。后台会继续普通回复并独立调度主动回复，回来时同步消息。\n手机推送仍受系统权限、网络与省电影响。`);
      } else status(`后台角色：${adapter.name(config.charId)}。打开该角色可更新后台设定。`);
      const job = remote.jobs?.find(x => x.charId === config.charId);
      if (job?.error) status('后台状态：' + job.error);
      if (remote.subscribed === false) status('手机推送订阅已失效。请先同步消息，再关闭后台并重新连接；后台回复仍可同步。');
      if (job?.nextAt) el('bgStatus').textContent += '\n下一次检查：' + new Date(job.nextAt).toLocaleString();
      if (job?.daily) adapter.updateDaily(config.charId, job.daily);
      if (ids.length) adapter.log('info', `后台已同步 ${ids.length} 轮结果，不重复发送本地通知`);
    } catch (error) { status('后台连接失败：' + error.message + '。后台启用期间不会同时启动本地自动回复；可关闭后台恢复本地模式。'); adapter.log('warn', '后台连接失败：' + error.message); }
    finally { busy = false; if (dirty) queue(); }
  }
  function queue() { if (!config.enabled) return; dirty = true; clearTimeout(timer); timer = setTimeout(sync, 1500); }
  async function subscribe(publicKey) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('当前浏览器不支持 Web Push');
    if (await Notification.requestPermission() !== 'granted') throw new Error('请允许手机通知权限');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const padded = publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - publicKey.length % 4) % 4);
    const key = Uint8Array.from(atob(padded), x => x.charCodeAt(0));
    if (sub) {
      const previousKey = sub.options.applicationServerKey;
      if (previousKey && Array.from(new Uint8Array(previousKey)).join(',') !== Array.from(key).join(',')) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('/subscription', 'POST', sub.toJSON());
  }
  function button(name, action) { el(name).onclick = async () => { el(name).disabled = true; try { await action(); } catch (error) { status(error.message, true); } finally { el(name).disabled = false; } }; }
  button('bgConnect', async () => {
    if (!el('bgConsent').checked) throw new Error('请先勾选上传同意');
    if (config.enabled) throw new Error('已有后台角色，请先关闭并删除后台数据，再重新连接');
    if (adapter.isBusy()) throw new Error('请等这一轮回复完成再连接');
    const currentId = adapter.activeId(), job = await adapter.snapshot(currentId, true);
    if (!job || job.disabled) throw new Error('请先为当前单人角色配置 AI，并确保聊天中已有消息');
    const url = new URL(el('bgUrl').value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('请填写 HTTPS 后台根地址，不带路径');
    if (!el('bgToken').value.trim()) throw new Error('请填写连接口令');
    config = { url: url.origin, token: el('bgToken').value.trim(), charId: currentId, enabled: false };
    const settings = await api('/config');
    // 先更新后台脚本，再启用 push；不清理聊天数据。
    const reg = await navigator.serviceWorker.ready; await reg.update();
    const replacement = reg.installing || reg.waiting;
    if (replacement && replacement.state !== 'activated') await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { replacement.removeEventListener('statechange', changed); reject(new Error('后台脚本仍在更新，请稍后重新启用')); }, 15000);
      function changed() {
        if (replacement.state === 'activated') { clearTimeout(timeout); replacement.removeEventListener('statechange', changed); resolve(); }
        else if (replacement.state === 'redundant') { clearTimeout(timeout); replacement.removeEventListener('statechange', changed); reject(new Error('后台脚本更新失败，请检查网络后重试')); }
      }
      replacement.addEventListener('statechange', changed); changed();
    });
    await subscribe(settings.publicKey);
    config.enabled = true; persist();
    try { if (job.autoEnabled) await api('/job', 'POST', job); else await api('/job', 'DELETE', { charId: currentId }); } catch (error) { config.enabled = false; persist(); throw error; }
    status('后台已启用，普通回复可以在切走后继续。自动回复按角色开关单独控制。请点击“测试手机推送”检查通知。'); adapter.log('info', '已启用 Cloudflare 后台自动回复');
  });
  button('bgTest', async () => { if (!config.enabled) throw new Error('请先启用后台'); const r = await api('/test', 'POST', {}); status(r.submitted === true ? '测试推送已被推送服务接收，请检查通知栏。' : '手机推送订阅已失效，请重新连接。'); });
  button('bgSync', sync);
  button('bgStop', async () => {
    if (!config.url) return;
    // 服务端确认删除后才恢复本地调度，网络失败时保留接管状态防止双发。
    if (busy || adapter.isBusy()) throw new Error('正在同步或回复，请稍后关闭');
    busy = true;
    try { await api('/reset', 'DELETE'); config = {}; persist(); el('bgToken').value = ''; status('后台任务、API 密钥、上下文及待同步结果已删除；恢复本地模式。'); } finally { busy = false; }
  });
  document.addEventListener('visibilitychange', () => { if (!config.enabled) return; api('/presence','POST',adapter.presence()).catch(()=>{}); if (document.visibilityState === 'visible') sync(); else queue(); });
  navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'LUMOS_BACKGROUND_CHANGED') sync(); });
  setInterval(() => { if (config.enabled && document.visibilityState === 'visible') sync(); }, 30000);
  if (config.enabled) { status('正在连接已启用的后台…'); queue(); } else status('未启用；现有聊天与通知继续使用本地模式。');
  async function submitReply(payload) {
    if (!config.enabled) throw new Error('后台未启用');
    if (busy) throw new Error('后台正在同步，请稍后再请求回复');
    busy = true;
    try {
      const remote = await api('/state');
      const ids = await adapter.importReplies(remote.inbox || []);
      if (ids.length) await api('/ack','POST',{ids});
      const snapshot = await adapter.snapshot(config.charId, true);
      if (!snapshot || snapshot.disabled) throw new Error('请先检查当前后台角色的 AI 设置');
      const requestId = 'reply_' + crypto.randomUUID().replace(/-/g,'');
      await api('/presence','POST',adapter.presence());
      // 快照继续供自动回复使用；当前普通回复采用原普通回复提示词和上下文层数。
      if (snapshot.autoEnabled) await api('/job','POST',snapshot);
      await api('/reply','POST',{...snapshot,...payload,requestId});
      adapter.pending(config.charId,true);
      status('普通回复已交给后台。切走后会继续生成，回来自动同步；没在对应聊天页时推送通知。');
      adapter.log('info','普通回复已交给 Cloudflare 后台，页面不会再次调用 AI');
    } finally { busy = false; queue(); }
  }
  return { managed, queue, sync, submitReply };
};
