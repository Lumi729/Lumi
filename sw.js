const CACHE_NAME = 'lumos-v2';
const urlsToCache = ['/Lumi/', '/Lumi/index.html', '/Lumi/manifest.json', '/Lumi/月亮.png', '/Lumi/月亮512.png'];
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
      const response = await fetch(request);
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
  event.waitUntil(self.clients.openWindow('/Lumi/'));
});
