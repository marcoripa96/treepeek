import { opendir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
  ".svelte-kit",
  ".nuxt",
  "coverage",
  ".vercel",
  ".output",
  ".parcel-cache",
  "out",
  ".angular",
  ".idea",
  ".vscode",
  "__pycache__",
  ".venv",
  "venv",
  "target",
]);

export interface WalkOptions {
  root: string;
  includeAll?: boolean;
  maxEntries?: number;
}

export interface WalkResult {
  paths: string[];
  truncated: boolean;
  count: number;
}

export async function walk(opts: WalkOptions): Promise<WalkResult> {
  const max = opts.maxEntries ?? 50_000;
  const ignores = opts.includeAll ? new Set<string>() : DEFAULT_IGNORES;
  const out: string[] = [];
  let truncated = false;

  const stack: string[] = [opts.root];
  while (stack.length > 0) {
    if (out.length >= max) {
      truncated = true;
      break;
    }
    const dir = stack.pop()!;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      continue;
    }
    const entries: { name: string; isDir: boolean }[] = [];
    for await (const entry of handle) {
      if (ignores.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      entries.push({ name: entry.name, isDir: entry.isDirectory() });
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (out.length >= max) {
        truncated = true;
        break;
      }
      const abs = join(dir, entry.name);
      const rel = relative(opts.root, abs).split(sep).join("/");
      if (entry.isDir) {
        out.push(rel + "/");
        stack.push(abs);
      } else {
        out.push(rel);
      }
    }
  }
  return { paths: out, truncated, count: out.length };
}
