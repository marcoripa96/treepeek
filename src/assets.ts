export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="36" fill="#ffffff"/>
  <g fill="none" stroke="#0284c7" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
    <path d="M40 56h44l10 12h58v76H40z"/>
    <path d="M40 56v-8h32l8 8"/>
  </g>
  <g fill="#0284c7">
    <circle cx="76" cy="116" r="5"/>
    <circle cx="100" cy="116" r="5"/>
    <circle cx="124" cy="116" r="5"/>
  </g>
</svg>
`;

export function buildManifest(name: string): string {
  return JSON.stringify({
    name: `treepeek · ${name}`,
    short_name: "treepeek",
    description: "Browse a remote folder over Tailscale.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  });
}

export const SERVICE_WORKER_JS = `
const CACHE = 'treepeek-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/client.js', '/styles.css'];

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
