import { ICON_SVG_RAW, ICON_PNG_192_B64, ICON_PNG_512_B64 } from "./generated/icons.ts";

export const ICON_SVG = ICON_SVG_RAW;
export const ICON_PNG_192 = Buffer.from(ICON_PNG_192_B64, "base64");
export const ICON_PNG_512 = Buffer.from(ICON_PNG_512_B64, "base64");

export function buildManifest(name: string): string {
  return JSON.stringify({
    name: `treepeek · ${name}`,
    short_name: "treepeek",
    description: "Browse a remote folder.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0284c7",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  });
}

export const SERVICE_WORKER_JS = `
const CACHE = 'treepeek-v8';
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
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      try { client.postMessage({ type: 'sw-activated', cache: CACHE }); } catch {}
    }
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/ws') return;

  if (STATIC.has(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(event.request, clone)).catch(() => {});
        }
        return resp;
      }))
    );
    return;
  }

  event.respondWith((async () => {
    try {
      const resp = await fetch(event.request);
      if (resp.ok) {
        const clone = resp.clone();
        caches.open(CACHE).then((c) => c.put(event.request, clone)).catch(() => {});
      }
      return resp;
    } catch {
      const hit = await caches.match(event.request);
      if (hit) return hit;
      const root = await caches.match('/');
      if (root) return root;
      return new Response('offline', { status: 503 });
    }
  })());
});
`.trimStart();
