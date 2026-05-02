import type { GitStatusEntry } from "@pierre/trees";

export interface CommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  date: string;
  relativeDate: string;
}

export interface TreeResponse {
  root: string;
  absoluteRoot: string;
  displayRoot: string;
  paths: string[];
  truncated: boolean;
  count: number;
  gitStatus: GitStatusEntry[] | null;
  branch: string | null;
  commit: CommitInfo | null;
}

export type GitHistoryStatus =
  | GitStatusEntry["status"]
  | "copied"
  | "typechange"
  | "unknown";
export interface GitHistoryEntry {
  path: string;
  status: GitHistoryStatus;
  commitHash: string | null;
  commitShortHash: string | null;
  subject: string;
  author: string;
  date: string | null;
  relativeDate: string | null;
  pending: boolean;
}

export interface HistoryResponse {
  entries: GitHistoryEntry[];
}

export interface FileResponse {
  path: string;
  size: number;
  mime: string;
  encoding: "utf8" | "base64";
  content: string | null;
  isBinary: boolean;
  truncated: boolean;
  reason?: string;
}

export interface InstanceListEntry {
  port: number;
  displayRoot: string;
  root: string;
  isSelf: boolean;
}

export interface InstancesPayload {
  instances: InstanceListEntry[];
  selfPort: number;
}

export function withWs(path: string, ws: number | null): string {
  if (ws == null) return path;
  return path + (path.includes("?") ? "&" : "?") + `ws=${ws}`;
}

export async function fetchTree(ws: number | null): Promise<TreeResponse | null> {
  try {
    const res = await fetch(withWs("/api/tree", ws), { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as TreeResponse;
  } catch {
    return null;
  }
}

export async function fetchInstances(): Promise<InstancesPayload | null> {
  try {
    const res = await fetch("/api/instances", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as InstancesPayload;
  } catch {
    return null;
  }
}

export async function fetchHistory(ws: number | null): Promise<HistoryResponse | null> {
  try {
    const res = await fetch(withWs("/api/history", ws), { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as HistoryResponse;
  } catch {
    return null;
  }
}

export async function fetchFile(
  path: string,
  ws: number | null,
  signal?: AbortSignal
): Promise<FileResponse> {
  const res = await fetch(withWs(`/api/file?p=${encodeURIComponent(path)}`, ws), {
    signal,
  });
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return (await res.json()) as FileResponse;
}

export interface DiffResponse {
  path: string;
  patch: string;
  hasChanges: boolean;
  reason?: string;
}

export async function fetchDiff(
  path: string,
  ws: number | null,
  signal?: AbortSignal
): Promise<DiffResponse> {
  const res = await fetch(withWs(`/api/diff?p=${encodeURIComponent(path)}`, ws), {
    signal,
  });
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return (await res.json()) as DiffResponse;
}
