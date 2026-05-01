import { readFile, stat } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";

const TEXT_LIMIT_BYTES = 2 * 1024 * 1024;
const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;

const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

export interface FileResult {
  path: string;
  size: number;
  mime: string;
  encoding: "utf8" | "base64";
  content: string | null;
  isBinary: boolean;
  truncated: boolean;
  reason?: string;
}

export function safeResolve(root: string, requested: string): string | null {
  const cleaned = normalize(requested).replace(/^[\\/]+/, "");
  const abs = resolve(root, cleaned);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

export async function readFileSafe(root: string, relPath: string): Promise<FileResult | null> {
  const abs = safeResolve(root, relPath);
  if (!abs) return null;
  let stats;
  try {
    stats = await stat(abs);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;
  const ext = extname(relPath).toLowerCase();
  const imageMime = IMAGE_EXT[ext];

  if (imageMime) {
    if (stats.size > IMAGE_LIMIT_BYTES) {
      return {
        path: relPath,
        size: stats.size,
        mime: imageMime,
        encoding: "base64",
        content: null,
        isBinary: true,
        truncated: true,
        reason: `Image larger than ${IMAGE_LIMIT_BYTES} bytes`,
      };
    }
    const buf = await readFile(abs);
    return {
      path: relPath,
      size: stats.size,
      mime: imageMime,
      encoding: "base64",
      content: buf.toString("base64"),
      isBinary: true,
      truncated: false,
    };
  }

  if (stats.size > TEXT_LIMIT_BYTES) {
    return {
      path: relPath,
      size: stats.size,
      mime: "application/octet-stream",
      encoding: "utf8",
      content: null,
      isBinary: false,
      truncated: true,
      reason: `File larger than ${TEXT_LIMIT_BYTES} bytes`,
    };
  }

  const buf = await readFile(abs);
  if (looksBinary(buf)) {
    return {
      path: relPath,
      size: stats.size,
      mime: "application/octet-stream",
      encoding: "base64",
      content: null,
      isBinary: true,
      truncated: false,
      reason: "Binary file",
    };
  }
  return {
    path: relPath,
    size: stats.size,
    mime: "text/plain; charset=utf-8",
    encoding: "utf8",
    content: buf.toString("utf8"),
    isBinary: false,
    truncated: false,
  };
}
