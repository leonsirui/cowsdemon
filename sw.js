/* DeepSeek 客户端 —— 离线缓存 Service Worker
 *
 * 目的：App 只要成功打开过一次，页面就永久留在手机本地。
 *       之后即使托管站点（GitHub Pages / Cloudflare 等）在国内访问不了，
 *       从主屏幕打开照样能用 —— 因为只有调用 DeepSeek 接口才需要联网，
 *       而 api.deepseek.com 在国内是可以直连的。
 *
 * 原则：只缓存同源的页面资源；跨域的 API 请求一律放行，绝不拦截
 *       （拦截会破坏流式输出的 SSE）。
 */

const CACHE = 'ds-app-v1'; // 以后改了 index.html，把这个版本号 +1 即可强制更新
const INDEX = new URL('./index.html', self.location).href;

const OFFLINE_HTML =
  '<!doctype html><meta charset="utf-8"><title>暂时打不开</title>' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<body style="font:16px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;' +
  'padding:48px 24px;text-align:center;color:#5d6673;background:#f6f7f9">' +
  '<h2 style="color:#14181f">暂时打不开</h2>' +
  '<p>这台设备上还没有缓存到页面。<br>请先联网成功打开一次，之后就永久离线可用了。</p>' +
  '</body>';

/* 安装：把 index.html 抓一份存进缓存 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        await cache.add(INDEX);
      } catch (e) {
        /* 抓不到也不要让安装失败，下次再试 */
      }
      self.skipWaiting();
    })()
  );
});

/* 激活：清掉旧版本缓存 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 非 GET（我们的 API 调用是 POST）直接放行
  if (req.method !== 'GET') return;

  // 跨域请求（api.deepseek.com）直接放行，不干预流式输出
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  /* 页面导航：先给缓存的（秒开、离线也能开），同时后台悄悄更新 */
  if (req.mode === 'navigate') {
    const cachePromise = caches.open(CACHE);
    const fresh = cachePromise
      .then((cache) =>
        fetch(req).then((res) => {
          if (res && res.ok) cache.put(INDEX, res.clone());
          return res;
        })
      )
      .catch(() => null);
    event.waitUntil(fresh.then(() => {}).catch(() => {}));

    event.respondWith(
      (async () => {
        const cache = await cachePromise;
        const cached = await cache.match(INDEX);
        if (cached) return cached;
        const net = await fresh;
        if (net) return net;
        return new Response(OFFLINE_HTML, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      })()
    );
    return;
  }

  /* 其它同源 GET：缓存优先 */
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch (e) {
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })()
  );
});
