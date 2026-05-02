#!/usr/bin/env bun
import { mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distDir = resolve(root, "dist");
const distClient = resolve(distDir, "client");
const distIcons = resolve(distDir, "icons");

const args = new Set(Bun.argv.slice(2));
const noCompile = args.has("--no-compile");

await rm(distDir, { recursive: true, force: true });
await mkdir(distClient, { recursive: true });
await mkdir(distIcons, { recursive: true });

console.log("[build] rasterizing icon ...");
const iconSvgPath = resolve(root, "src/icon.svg");
const iconSvg = await readFile(iconSvgPath, "utf8");
async function rasterize(size: number, outFile: string): Promise<Buffer> {
  const proc = Bun.spawn({
    cmd: ["rsvg-convert", "-w", String(size), "-h", String(size), iconSvgPath, "-o", outFile],
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
    throw new Error(`rsvg-convert exited ${code}: ${err}`);
  }
  return Buffer.from(await readFile(outFile));
}
await writeFile(resolve(distIcons, "icon.svg"), iconSvg);
const png192 = await rasterize(192, resolve(distIcons, "icon-192.png"));
const png512 = await rasterize(512, resolve(distIcons, "icon-512.png"));
console.log(`[build] icon-192.png: ${(png192.length / 1024).toFixed(1)} KB`);
console.log(`[build] icon-512.png: ${(png512.length / 1024).toFixed(1)} KB`);

console.log("[build] bundling client (split) ...");
const clientResult = await Bun.build({
  entrypoints: [resolve(root, "src/client/main.tsx")],
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
  sourcemap: "none",
  publicPath: "/",
  naming: {
    entry: "client.[ext]",
    chunk: "chunk-[hash].[ext]",
  },
});
if (!clientResult.success) {
  for (const log of clientResult.logs) console.error(log);
  throw new Error("client bundle failed");
}

console.log("[build] bundling highlight worker ...");
const workerResult = await Bun.build({
  entrypoints: [resolve(root, "src/client/highlightWorker.ts")],
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "none",
  naming: { entry: "highlight-worker.[ext]" },
});
if (!workerResult.success) {
  for (const log of workerResult.logs) console.error(log);
  throw new Error("worker bundle failed");
}

const html = await readFile(resolve(root, "src/client/index.html"), "utf8");
const css = await readFile(resolve(root, "src/client/styles.css"), "utf8");

interface AssetSpec {
  url: string;
  contentType: string;
  filename: string;
  bytes: Uint8Array;
}

const assets: AssetSpec[] = [];
const enc = new TextEncoder();
assets.push({ url: "/", contentType: "text/html; charset=utf-8", filename: "index.html", bytes: enc.encode(html) });
assets.push({ url: "/styles.css", contentType: "text/css; charset=utf-8", filename: "styles.css", bytes: enc.encode(css) });

for (const out of [...clientResult.outputs, ...workerResult.outputs]) {
  const filename = out.path.replace(/^\.?\/?/, "");
  const url = "/" + filename;
  const buf = new Uint8Array(await out.arrayBuffer());
  const ct = filename.endsWith(".css")
    ? "text/css; charset=utf-8"
    : filename.endsWith(".html")
      ? "text/html; charset=utf-8"
      : "text/javascript; charset=utf-8";
  assets.push({ url, contentType: ct, filename, bytes: buf });
}

function gz(b: Uint8Array): Buffer {
  return gzipSync(b, { level: 9 });
}
function br(b: Uint8Array): Buffer {
  return brotliCompressSync(b, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: b.length,
    },
  });
}
function etag(b: Uint8Array): string {
  return '"' + createHash("sha256").update(b).digest("base64url").slice(0, 16) + '"';
}

interface ManifestAsset {
  url: string;
  content_type: string;
  etag: string;
  gz: string;
  br: string;
}

const manifestAssets: ManifestAsset[] = [];
let totalRaw = 0;
let totalGz = 0;
let totalBr = 0;
for (const a of assets) {
  const gzBuf = gz(a.bytes);
  const brBuf = br(a.bytes);
  const tag = etag(a.bytes);
  totalRaw += a.bytes.length;
  totalGz += gzBuf.length;
  totalBr += brBuf.length;
  console.log(
    `[build] ${a.url.padEnd(28)} ${(a.bytes.length / 1024).toFixed(1).padStart(7)} KB → gz ${(
      gzBuf.length / 1024
    ).toFixed(1).padStart(6)} KB · br ${(brBuf.length / 1024).toFixed(1).padStart(6)} KB`
  );
  const gzPath = `client/${a.filename}.gz`;
  const brPath = `client/${a.filename}.br`;
  await writeFile(resolve(distDir, gzPath), gzBuf);
  await writeFile(resolve(distDir, brPath), brBuf);
  manifestAssets.push({
    url: a.url,
    content_type: a.contentType,
    etag: tag,
    gz: gzPath,
    br: brPath,
  });
}
console.log(
  `[build] totals: raw ${(totalRaw / 1024).toFixed(1)} KB · gz ${(totalGz / 1024).toFixed(
    1
  )} KB · br ${(totalBr / 1024).toFixed(1)} KB`
);

const manifest = {
  assets: manifestAssets,
  icons: {
    svg: "icons/icon.svg",
    png_192: "icons/icon-192.png",
    png_512: "icons/icon-512.png",
  },
};
await writeFile(resolve(distDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`[build] wrote ${resolve(distDir, "manifest.json")}`);

if (noCompile) {
  console.log("[build] --no-compile, skipping binary");
  process.exit(0);
}

console.log("[build] cargo build --release ...");
const compile = Bun.spawn({
  cmd: ["cargo", "build", "--release", "--manifest-path", resolve(root, "server/Cargo.toml")],
  stdout: "inherit",
  stderr: "inherit",
});
const code = await compile.exited;
if (code !== 0) {
  console.error("[build] cargo build failed");
  process.exit(code);
}
const binSrc = resolve(root, "server/target/release/treepeek");
const binDst = resolve(root, "treepeek");
await copyFile(binSrc, binDst);
console.log(`[build] done → ${binDst}`);
