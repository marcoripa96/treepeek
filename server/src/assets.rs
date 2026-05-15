use serde_json::json;

include!(concat!(env!("OUT_DIR"), "/client_assets_generated.rs"));

pub fn build_manifest(name: &str, base_path: &str) -> String {
    // base_path is empty or a leading-slash prefix like "/treepeek". The
    // manifest scope/start_url must end with "/" for installable PWA semantics.
    let base = if base_path.is_empty() {
        "/".to_string()
    } else {
        format!("{}/", base_path)
    };
    json!({
        "name": format!("treepeek · {}", name),
        "short_name": "treepeek",
        "description": "Browse a remote folder.",
        "start_url": base.clone(),
        "scope": base.clone(),
        "display": "standalone",
        "orientation": "any",
        "background_color": "#ffffff",
        "theme_color": "#ffffff",
        "icons": [
            { "src": format!("{}icon.svg", base), "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
            { "src": format!("{}icon-192.png", base), "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
            { "src": format!("{}icon-512.png", base), "sizes": "512x512", "type": "image/png", "purpose": "any maskable" },
        ],
    })
    .to_string()
}

pub const SERVICE_WORKER_JS: &str = r#"const CACHE = 'treepeek-v13';
// SCOPE always ends with '/'. When the app is mounted at site root it's '/',
// in funnel mode it's '/<dir-slug>/'. Everything below is computed against it
// so the same worker source works at any mount point.
const SCOPE = new URL(self.registration.scope).pathname;
const STATIC = new Set([
  SCOPE + 'icon.svg',
  SCOPE + 'icon-192.png',
  SCOPE + 'icon-512.png',
  SCOPE + 'manifest.webmanifest',
]);
const API_PREFIX = SCOPE + 'api/';
const WS_PATH = SCOPE + 'ws';

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
  if (url.pathname.startsWith(API_PREFIX)) return;
  if (url.pathname === WS_PATH) return;

  if (STATIC.has(url.pathname)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
});

self.addEventListener('push', (event) => {
  let payload = { title: 'treepeek', body: 'Files changed', url: SCOPE, file: null };
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
      icon: SCOPE + 'icon-192.png',
      badge: SCOPE + 'icon-192.png',
      tag: 'treepeek-changes',
      renotify: true,
      data: { url: payload.url || SCOPE, file: payload.file || null }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const file = data.file || null;
  // Resolve payload.url relative to scope so the server can send '?file=foo'
  // and have it land at the right mount point.
  const target = data.url
    ? new URL(data.url, self.registration.scope).toString()
    : (file ? SCOPE + '?file=' + encodeURIComponent(file) : SCOPE);
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
