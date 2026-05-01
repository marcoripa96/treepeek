import { existsSync } from "node:fs";
import { join } from "node:path";

export type GitStatus = "added" | "deleted" | "ignored" | "modified" | "renamed" | "untracked";
export interface GitStatusEntry {
  path: string;
  status: GitStatus;
}

export async function getGitStatus(root: string): Promise<GitStatusEntry[] | null> {
  if (!existsSync(join(root, ".git"))) return null;
  try {
    const proc = Bun.spawn({
      cmd: ["git", "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    return parsePorcelainV1Z(stdout);
  } catch {
    return null;
  }
}

function classify(xy: string): GitStatus {
  const x = xy[0];
  const y = xy[1];
  if (x === "?" && y === "?") return "untracked";
  if (x === "!" || y === "!") return "ignored";
  if (x === "R" || y === "R") return "renamed";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

function parsePorcelainV1Z(out: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  let i = 0;
  while (i < out.length) {
    const nul = out.indexOf("\0", i);
    if (nul < 0) break;
    const tok = out.slice(i, nul);
    i = nul + 1;
    if (tok.length < 4) continue;
    const xy = tok.slice(0, 2);
    const path = tok.slice(3);
    if (xy[0] === "R" || xy[1] === "R") {
      const next = out.indexOf("\0", i);
      if (next >= 0) i = next + 1;
    }
    entries.push({ path, status: classify(xy) });
  }
  return entries;
}
