const CACHE_NAME = 'lumos-v22';
const urlsToCache = ['/Lumi/', '/Lumi/index.html', '/Lumi/manifest.json', '/Lumi/background-client.js?v=20261009-actions18', '/Lumi/月亮.png', '/Lumi/月亮512.png'];
const staticUrls = new Set(urlsToCache.map(path => new URL(path, self.location.origin).href));

// 核心资源全部就绪后启用新版。
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(urlsToCache.map(path => new Request(path, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

// 只清理 Lumos 的旧资源缓存，不影响同域其他应用。
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => /^lumos-v\d+$/.test(name) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

// 仅缓存已知静态资源；联网获取新版，断网回退。聊天/API 请求不缓存。
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !staticUrls.has(request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(new Request(request, { cache: 'no-cache' }));
      if (response.ok) {
        try { await cache.put(request, response.clone()); } catch (_) {}
        return response;
      }
      return (await cache.match(request)) || response;
    } catch (error) {
      const cached = await cache.match(request);
      if (cached) return cached;
      throw error;
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const charId = event.notification.data && event.notification.data.charId;
  const url = new URL('/Lumi/', self.location.origin);
  if (typeof charId === 'string') url.searchParams.set('notificationChat', charId);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      const current = new URL(client.url);
      if (current.origin === url.origin && current.pathname.startsWith('/Lumi/')) {
        await client.focus();
        if (typeof charId === 'string') client.postMessage({ type: 'LUMOS_OPEN_CHAT', charId });
        return;
      }
    }
    await self.clients.openWindow(url.href);
  })());
});

// 串行提交整轮通知，后续轮次不能插进当前轮次；整个任务由 waitUntil 保活。
let notificationQueue = Promise.resolve();
function submitNotificationBatch(notices) {
  const job = notificationQueue.then(async () => {
    const items = [];
    for (const notice of notices) {
      try {
        await self.registration.showNotification(notice.title, notice.options);
        items.push({tag:notice.options.tag, status:'submitted', at:Date.now()});
      } catch (error) {
        items.push({tag:notice.options.tag, status:'failed', error:error.name || 'Error', at:Date.now()});
      }
    }
    const failed = items.filter(item => item.status === 'failed').length;
    return {sent:items.length-failed, failed, items};
  });
  notificationQueue = job.catch(() => {});
  return job;
}

// 接收后由后台保活到整批通知提交结束，页面切走不再留下逐条发送任务。
self.addEventListener('message', event => {
  const source = event.source;
  if (!source || !source.url) return;
  const url = new URL(source.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/Lumi/')) return;
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  if (data.type === 'LUMOS_NOTIFY_PING') {
    if (port) port.postMessage('LUMOS_NOTIFY_READY');
    return;
  }
  if (data.type !== 'LUMOS_NOTIFY_BATCH' || !Array.isArray(data.notices)) return;
  const notices = data.notices.slice(0,3).filter(n => n && typeof n.title === 'string' && n.options && typeof n.options.body === 'string');
  event.waitUntil((async () => {
    const result = await submitNotificationBatch(notices);
    if (port) port.postMessage(result);
  })());
});


// Resolve the source avatar from this device; no avatar or chat data is uploaded for push.
async function pushAvatar(charId) {
  const fallback = '/Lumi/月亮.png';
  if (!charId || typeof indexedDB === 'undefined') return fallback;
  return new Promise(resolve => {
    let db, finished=false;
    const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);if(db)db.close();resolve(value || fallback);};
    const timer=setTimeout(()=>finish(fallback),1500);
    try {
      const request=indexedDB.open('lumos_chars_v1',1);
      request.onupgradeneeded=()=>{request.transaction.abort();};
      request.onerror=()=>finish(fallback);
      request.onsuccess=()=>{
        db=request.result;if(finished){db.close();return;}
        if(!db.objectStoreNames.contains('chars'))return finish(fallback);
        const read=db.transaction('chars','readonly').objectStore('chars').get('main');
        read.onerror=()=>finish(fallback);
        read.onsuccess=()=>{
          const character=Array.isArray(read.result) && read.result.find(c=>c.id===charId);
          const src=character?.avatarSrc;
          finish(character?.avatarType==='image' && typeof src==='string' && /^(https?:|data:image\/)/i.test(src) ? src : fallback);
        };
      };
    } catch (_) {finish(fallback);}
  });
}

// Real Web Push can wake this worker without an open page. It does not run a
// permanent timer: Cloudflare generates the reply and delivers this event.
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let data;
    try { data = event.data && event.data.json(); } catch (_) {}
    const notices = data && data.type === 'LUMOS_PUSH_REPLY' && Array.isArray(data.notices)
      ? data.notices.slice(0,3).filter(n => typeof n.title === 'string' && typeof n.options?.body === 'string') : [];
    if (!notices.length) notices.push({title:'Lumos', options:{body:'后台有新消息，打开后同步。'}});
    const icons = await Promise.all(notices.map(n=>pushAvatar(n.options.data?.charId)));
    const result = await submitNotificationBatch(notices.map((n,i) => ({title:n.title, options:{
      body:n.options.body, tag:n.options.tag, icon:icons[i], data:n.options.data || {}, requireInteraction:false
    }})));
    if (!result.sent) throw new Error('推送通知提交失败');
    const clients = await self.clients.matchAll({type:'window',includeUncontrolled:true});
    clients.forEach(client => client.postMessage({type:'LUMOS_BACKGROUND_CHANGED'}));
  })());
});

