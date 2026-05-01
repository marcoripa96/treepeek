#!/usr/bin/env bun
import { resolve } from "node:path";
import { basename } from "node:path";
import qrcode from "qrcode-terminal";
import { isAuthenticated, buildCookieHeader, loadOrCreateToken } from "./auth.ts";
import { walk } from "./walker.ts";
import { readFileSafe } from "./file.ts";
import { getTailscaleIPv4, getLanIPv4 } from "./network.ts";
import { ICON_SVG, ICON_PNG_192, ICON_PNG_512, SERVICE_WORKER_JS, buildManifest } from "./assets.ts";
import { CLIENT_HTML, CLIENT_CSS, CLIENT_JS } from "./generated/client-bundle.ts";
import { startCloudflaredQuickTunnel, startTailscaleFunnel, type TunnelHandle } from "./tunnel.ts";
import { getGitStatus, type GitStatusEntry } from "./git.ts";
import { startWatcher } from "./watcher.ts";
import type { ServerWebSocket } from "bun";

interface CliOptions {
  port: number;
  bind: string | null;
  all: boolean;
  token: string | undefined;
  rotateToken: boolean;
  noQr: boolean;
  tunnel: boolean;
  funnel: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    port: 7777,
    bind: null,
    all: false,
    token: undefined,
    rotateToken: false,
    noQr: false,
    tunnel: false,
    funnel: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--port" || a === "-p") opts.port = Number(argv[++i]);
    else if (a === "--bind" || a === "-b") opts.bind = argv[++i] ?? null;
    else if (a === "--all") opts.all = true;
    else if (a === "--token") opts.token = argv[++i];
    else if (a === "--rotate-token") opts.rotateToken = true;
    else if (a === "--no-qr") opts.noQr = true;
    else if (a === "--tunnel" || a === "-t") opts.tunnel = true;
    else if (a === "--funnel" || a === "-f") opts.funnel = true;
    else if (a.startsWith("-")) console.warn(`treepeek: unknown flag ${a}`);
  }
  return opts;
}

function printHelp() {
  console.log(`treepeek — browse a remote folder over Tailscale.

Usage:
  treepeek [options]

Options:
  -p, --port <n>       Port to listen on (default 7777)
  -b, --bind <ip>      Address to bind (default: tailscale0 IP, else 0.0.0.0)
      --all            Include node_modules / .git / build dirs
      --token <s>      Use a specific token (else loaded/generated)
      --rotate-token   Force a fresh token
      --no-qr          Don't print the QR code
  -t, --tunnel         Ephemeral public HTTPS URL via Cloudflare quick tunnel
                       (random *.trycloudflare.com per run; binds to 127.0.0.1)
  -f, --funnel         Stable public HTTPS URL via Tailscale Funnel
                       (https://<host>.<tailnet>.ts.net; binds to 127.0.0.1)
  -h, --help           Show this help
`);
}

const TREE_CACHE_TTL_MS = 5_000;
interface TreeCache {
  at: number;
  data: {
    root: string;
    absoluteRoot: string;
    displayRoot: string;
    paths: string[];
    truncated: boolean;
    count: number;
    gitStatus: GitStatusEntry[] | null;
  };
}

function unauthorized(req: Request): Response {
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("application/json") || new URL(req.url).pathname.startsWith("/api/")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return new Response(
    `<!DOCTYPE html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>treepeek</title><body style="background:#0b0d10;color:#94a3b8;font:14px system-ui;margin:0;display:grid;place-items:center;height:100vh;text-align:center;padding:24px"><div><h1 style="color:#e5e7eb;font-size:18px;margin:0 0 8px">Authentication required</h1><p>Open the share URL printed by <code>treepeek</code> on the host.</p></div></body>`,
    { status: 401, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

async function start() {
  const opts = parseArgs(Bun.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const root = resolve(process.cwd());
  const rootName = basename(root);
  const home = process.env.HOME ?? "";
  const displayRoot = home && (root === home || root.startsWith(home + "/")) ? "~" + root.slice(home.length) : root;
  const token = await loadOrCreateToken({ rotate: opts.rotateToken, override: opts.token });
  const manifest = buildManifest(rootName);

  if (opts.tunnel && opts.funnel) {
    console.error("[treepeek] --tunnel and --funnel are mutually exclusive");
    process.exit(2);
  }

  let bind = opts.bind;
  let bindReason = "explicit";
  if ((opts.tunnel || opts.funnel) && !bind) {
    bind = "127.0.0.1";
    bindReason = (opts.tunnel ? "tunnel" : "funnel") + " mode (loopback)";
  } else if (!bind) {
    const ts = getTailscaleIPv4();
    if (ts) {
      bind = ts;
      bindReason = "tailscale0";
    } else {
      bind = "0.0.0.0";
      bindReason = "fallback (Tailscale not detected)";
    }
  }

  const sockets = new Set<ServerWebSocket<unknown>>();
  function broadcast(payload: object) {
    const msg = JSON.stringify(payload);
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  let cache: TreeCache | null = null;
  function invalidateTreeCache() {
    cache = null;
  }
  async function getTree() {
    const now = Date.now();
    if (cache && now - cache.at < TREE_CACHE_TTL_MS) return cache.data;
    const [walked, gitStatus] = await Promise.all([
      walk({ root, includeAll: opts.all }),
      getGitStatus(root),
    ]);
    const data = {
      root: rootName,
      absoluteRoot: root,
      displayRoot,
      paths: walked.paths,
      truncated: walked.truncated,
      count: walked.count,
      gitStatus,
    };
    cache = { at: now, data };
    return data;
  }

  const server = Bun.serve({
    hostname: bind,
    port: opts.port,
    error(err) {
      console.error("[treepeek] error:", err);
      return new Response("Internal error", { status: 500 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message() {},
    },
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/ws") {
        if (!isAuthenticated(req, token)) {
          return new Response("unauthorized", { status: 401 });
        }
        if (server.upgrade(req)) return;
        return new Response("expected websocket upgrade", { status: 426 });
      }

      if (path === "/icon.svg") {
        return new Response(ICON_SVG, {
          headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
        });
      }
      if (path === "/icon-192.png") {
        return new Response(ICON_PNG_192, {
          headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
        });
      }
      if (path === "/icon-512.png") {
        return new Response(ICON_PNG_512, {
          headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
        });
      }
      if (path === "/manifest.webmanifest") {
        return new Response(manifest, {
          headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=300" },
        });
      }

      if (!isAuthenticated(req, token)) return unauthorized(req);

      if (path === "/" && url.searchParams.get("k")) {
        const headers = new Headers({ Location: "/" });
        headers.append("Set-Cookie", buildCookieHeader(token));
        return new Response(null, { status: 303, headers });
      }

      if (path === "/" || path === "/index.html") {
        return new Response(CLIENT_HTML, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
        });
      }
      if (path === "/styles.css") {
        return new Response(CLIENT_CSS, {
          headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" },
        });
      }
      if (path === "/client.js") {
        return new Response(CLIENT_JS, {
          headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" },
        });
      }
      if (path === "/sw.js") {
        return new Response(SERVICE_WORKER_JS, {
          headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
        });
      }

      if (path === "/api/tree") {
        const data = await getTree();
        return Response.json(data);
      }
      if (path === "/api/file") {
        const p = url.searchParams.get("p");
        if (!p) return Response.json({ error: "missing path" }, { status: 400 });
        const data = await readFileSafe(root, p);
        if (!data) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(data);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  const watcher = startWatcher(root, {
    includeAll: opts.all,
    onChange: () => {
      invalidateTreeCache();
      broadcast({ type: "changed" });
    },
  });

  let tunnel: TunnelHandle | null = null;
  let shareUrl: string;
  let originLabel: string;

  if (opts.tunnel) {
    const localUrl = `http://${bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind}:${server.port}`;
    console.log(``);
    console.log(`  treepeek  ${rootName}`);
    console.log(`  bind:     ${bind}:${server.port}  (${bindReason})`);
    console.log(`  tunnel:   starting cloudflared quick tunnel ...`);
    try {
      tunnel = await startCloudflaredQuickTunnel(localUrl);
    } catch (err) {
      console.error(`\n[treepeek] tunnel failed: ${(err as Error).message}`);
      server.stop(true);
      process.exit(1);
    }
    shareUrl = `${tunnel.url}/?k=${token}`;
    originLabel = `${tunnel.url}  (Cloudflare quick tunnel)`;
  } else if (opts.funnel) {
    console.log(``);
    console.log(`  treepeek  ${rootName}`);
    console.log(`  bind:     ${bind}:${server.port}  (${bindReason})`);
    console.log(`  funnel:   configuring tailscale funnel ...`);
    try {
      tunnel = await startTailscaleFunnel(server.port);
    } catch (err) {
      console.error(`\n[treepeek] funnel failed: ${(err as Error).message}`);
      console.error(`  hint: enable Funnel/HTTPS at https://login.tailscale.com/admin/settings`);
      server.stop(true);
      process.exit(1);
    }
    shareUrl = `${tunnel.url}/?k=${token}`;
    originLabel = `${tunnel.url}  (Tailscale Funnel)`;
  } else {
    const displayHost =
      bind === "0.0.0.0" || bind === "::"
        ? getTailscaleIPv4() ?? getLanIPv4() ?? "127.0.0.1"
        : bind;
    shareUrl = `http://${displayHost}:${server.port}/?k=${token}`;
    originLabel = `http://${displayHost}:${server.port}`;
    console.log(``);
    console.log(`  treepeek  ${rootName}`);
    console.log(`  bind:     ${bind}:${server.port}  (${bindReason})`);
  }

  console.log(``);
  console.log(`  open on your phone:`);
  console.log(`    \x1b[36m${shareUrl}\x1b[0m`);
  console.log(``);
  if (!opts.noQr) {
    qrcode.generate(shareUrl, { small: true }, (s: string) => {
      for (const line of s.split("\n")) console.log("  " + line);
    });
  }
  if (tunnel) {
    console.log(`  origin:   ${originLabel}`);
  }
  console.log(`  ctrl-c to stop`);
  console.log(``);

  const shutdown = async (sig: string) => {
    console.log(`\n[treepeek] caught ${sig}, shutting down ...`);
    watcher.stop();
    if (tunnel) await tunnel.stop();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch((err) => {
  console.error("[treepeek] failed to start:", err);
  process.exit(1);
});
