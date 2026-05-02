import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { GitStatusEntry } from "@pierre/trees";
import { fetchSearch, type SearchHit } from "../lib/api";
import { fileIconLabel } from "../lib/fileIcon";

const SEARCH_LIST_LIMIT = 5000;
const SERVER_LIMIT = 100;
const DEBOUNCE_MS = 80;

interface Props {
  paths: string[];
  query: string;
  ws: number | null;
  gitStatus: GitStatusEntry[] | null;
  onOpenFile: (path: string) => void;
  visible: boolean;
}

type Status = GitStatusEntry["status"];

const STATUS_META: Record<Status, { letter: string; color: string; label: string }> = {
  modified: { letter: "M", color: "#f59e0b", label: "modified" },
  added: { letter: "A", color: "#10b981", label: "added" },
  deleted: { letter: "D", color: "#ef4444", label: "deleted" },
  untracked: { letter: "U", color: "#3b82f6", label: "untracked" },
  renamed: { letter: "R", color: "#8b5cf6", label: "renamed" },
  ignored: { letter: "I", color: "#94a3b8", label: "ignored" },
};

export function SearchList({
  paths,
  query,
  ws,
  gitStatus,
  onOpenFile,
  visible,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [serverHits, setServerHits] = useState<SearchHit[] | null>(null);
  const [serverQuery, setServerQuery] = useState("");

  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length === 0) {
      setServerHits(null);
      setServerQuery("");
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      const hits = await fetchSearch(trimmed, ws, SERVER_LIMIT, abort.signal);
      if (abort.signal.aborted) return;
      setServerHits(hits);
      setServerQuery(trimmed);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [trimmed, ws]);

  const statusByPath = useMemo(() => {
    const map = new Map<string, Status>();
    if (!gitStatus) return map;
    for (const e of gitStatus) {
      if (e.status === "ignored") continue;
      map.set(e.path, e.status);
    }
    return map;
  }, [gitStatus]);

  const matches = useMemo(() => {
    if (trimmed.length > 0) {
      // Use server results when fresh; while waiting on a new query, keep
      // showing the previous server results to avoid flicker.
      if (serverHits) return serverHits.map((h) => h.path);
      // First-ever query: empty until server responds.
      return [];
    }
    const out: string[] = [];
    for (const p of paths) {
      if (p.endsWith("/")) continue;
      out.push(p);
      if (out.length >= SEARCH_LIST_LIMIT) break;
    }
    return out;
  }, [trimmed, serverHits, paths]);

  const virtualizer = useVirtualizer({
    count: matches.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 8,
    getItemKey: (i) => matches[i] ?? i,
  });

  const items = virtualizer.getVirtualItems();

  const isStale = trimmed.length > 0 && serverQuery !== trimmed;

  return (
    <div
      ref={parentRef}
      id="search-list"
      className={visible ? "open" : undefined}
      aria-label="search results"
      data-stale={isStale ? "true" : "false"}
    >
      {matches.length === 0 ? (
        <div className="search-empty">
          {trimmed
            ? serverHits === null
              ? "Searching…"
              : `No files match "${query}"`
            : "No files"}
        </div>
      ) : (
        <div
          className="virtual-rows"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {items.map((vi) => {
            const path = matches[vi.index]!;
            const slash = path.lastIndexOf("/");
            const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
            const name = slash >= 0 ? path.slice(slash + 1) : path;
            const { ext, color } = fileIconLabel(name);
            const status = statusByPath.get(path);
            const statusMeta = status ? STATUS_META[status] : null;
            return (
              <button
                key={vi.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                type="button"
                className="search-item"
                data-path={path}
                style={{ transform: `translateY(${vi.start}px)` }}
                onClick={() => onOpenFile(path)}
              >
                <span className="file-icon" style={{ background: color }}>
                  {ext}
                </span>
                <span className="search-item-text">
                  <span className="filename">{name}</span>
                  {dir && <span className="filepath">{dir}</span>}
                </span>
                {statusMeta && (
                  <span
                    className="git-status-badge"
                    style={{ color: statusMeta.color, borderColor: statusMeta.color }}
                    title={statusMeta.label}
                    aria-label={`${statusMeta.label} file`}
                  >
                    {statusMeta.letter}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
