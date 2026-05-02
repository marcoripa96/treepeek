import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { GitStatusEntry } from "@pierre/trees";
import { fileIconLabel } from "../lib/fileIcon";

const SEARCH_LIST_LIMIT = 5000;

interface Props {
  paths: string[];
  query: string;
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
  gitStatus,
  onOpenFile,
  visible,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

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
    const q = query.toLowerCase().trim();
    const out: string[] = [];
    for (const p of paths) {
      if (p.endsWith("/")) continue;
      if (q && !p.toLowerCase().includes(q)) continue;
      out.push(p);
      if (out.length >= SEARCH_LIST_LIMIT) break;
    }
    return out;
  }, [paths, query]);

  const virtualizer = useVirtualizer({
    count: matches.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 8,
    getItemKey: (i) => matches[i] ?? i,
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      id="search-list"
      className={visible ? "open" : undefined}
      aria-label="search results"
    >
      {matches.length === 0 ? (
        <div className="search-empty">
          {query.trim() ? `No files match "${query}"` : "No files"}
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
