const CACHE_NAME = 'lumos-v1';
const urlsToCache = [
  '/Lumi/',
  '/Lumi/index.html',
  '/Lumi/manifest.json',
  '/Lumi/月亮.png',
  '/Lumi/月亮512.png'
];

// 安装时跳过等待并预缓存核心文件
self.addEventListener('install', event => {
  self.skipWaiting();
  事件.waitUntil(
    缓存.打开(缓存名称)
      .然后(缓存 => 缓存.addAll(要缓存的URL))
  );
});

// 激活时立即控制所有客户端，并清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
  事件.waitUntil(
    缓存.键().然后(缓存名称 => {
      返回 Promise.全部(
        cacheNames.filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    })
  );
});

// 网络请求处理：缓存优先，若缓存未命中则从网络获取（适用于离线）
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .然后(响应 =>  || 获取事件.请求)
  );
});

// 点击通知时关闭通知并打开主页
self.addEventListener('notificationclick', event => {
  event.notification.close();
  事件.waitUntil(
    客户端.openWindow('/Lumi/')  // 替换为实际主页路径
  );
});
