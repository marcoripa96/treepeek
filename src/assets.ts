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
const CACHE = 'treepeek-v6';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/client.js', '/styles.css'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(event.request, clone)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match('/'));
    })
  );
});
`.trimStart();
