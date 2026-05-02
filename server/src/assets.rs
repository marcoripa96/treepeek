use serde_json::json;

include!(concat!(env!("OUT_DIR"), "/client_assets_generated.rs"));

pub fn build_manifest(name: &str) -> String {
    json!({
        "name": format!("treepeek · {}", name),
        "short_name": "treepeek",
        "description": "Browse a remote folder.",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "orientation": "any",
        "background_color": "#ffffff",
        "theme_color": "#ffffff",
        "icons": [
            { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
            { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
            { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" },
        ],
    })
    .to_string()
}

pub const SERVICE_WORKER_JS: &str = r#"const CACHE = 'treepeek-v12';
const STATIC = new Set([
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.webmanifest',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([...STATIC])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function notifyClients(message) {
  const all = await self.clients.matchAll({ type: 'window' });
  for (const client of all) {
    try { client.postMessage(message); } catch {}
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const resp = await fetch(request);
  if (resp.ok) cache.put(request, resp.clone()).catch(() => {});
  return resp;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(async (resp) => {
    if (resp.status === 304) return resp;
    if (!resp.ok) return resp;
    const newEtag = resp.headers.get('etag') || '';
    const oldEtag = cached ? (cached.headers.get('etag') || '') : '';
    await cache.put(request, resp.clone()).catch(() => {});
    if (cached && newEtag && oldEtag && newEtag !== oldEtag) {
      await notifyClients({ type: 'sw-activated', cache: CACHE });
    }
    return resp;
  }).catch(() => null);
  if (cached) return cached;
  const fresh = await fetchPromise;
  if (fresh) return fresh;
  return new Response('offline', { status: 503 });
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/ws') return;

  if (STATIC.has(url.pathname)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
});

self.addEventListener('push', (event) => {
  let payload = { title: 'treepeek', body: 'Files changed', url: '/', file: null };
  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        payload = { ...payload, ...parsed };
      }
    } catch {
      try { payload.body = event.data.text() || payload.body; } catch {}
    }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'treepeek-changes',
      renotify: true,
      data: { url: payload.url || '/', file: payload.file || null }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const file = data.file || null;
  const target = data.url || (file ? '/?file=' + encodeURIComponent(file) : '/');
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      try {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if (file) {
            try { client.postMessage({ type: 'open-file', path: file }); } catch {}
          }
          return;
        }
      } catch {}
    }
    try { await self.clients.openWindow(target); } catch {}
  })());
});
"#;
