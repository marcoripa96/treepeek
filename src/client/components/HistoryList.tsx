import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { GitHistoryEntry, GitHistoryStatus } from "../lib/api";
import { fileIconLabel } from "../lib/fileIcon";

interface Props {
  entries: GitHistoryEntry[];
  query: string;
  onOpenFile: (path: string) => void;
  visible: boolean;
}

const STATUS_META: Record<GitHistoryStatus, { letter: string; color: string; label: string }> = {
  modified: { letter: "M", color: "#f59e0b", label: "modified" },
  added: { letter: "A", color: "#10b981", label: "added" },
  deleted: { letter: "D", color: "#ef4444", label: "deleted" },
  untracked: { letter: "U", color: "#3b82f6", label: "untracked" },
  renamed: { letter: "R", color: "#8b5cf6", label: "renamed" },
  ignored: { letter: "I", color: "#94a3b8", label: "ignored" },
  copied: { letter: "C", color: "#06b6d4", label: "copied" },
  typechange: { letter: "T", color: "#a855f7", label: "type changed" },
  unknown: { letter: "?", color: "#94a3b8", label: "changed" },
};

const HISTORY_LIMIT = 2000;

export function HistoryList({ entries, query, onOpenFile, visible }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = query.toLowerCase().trim();
    const out: GitHistoryEntry[] = [];
    for (const entry of entries) {
      if (q) {
        const haystack = `${entry.path} ${entry.subject} ${entry.author}`.toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      out.push(entry);
      if (out.length >= HISTORY_LIMIT) break;
    }
    return out;
  }, [entries, query]);

  const virtualizer = useVirtualizer({
    count: matches.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 6,
    getItemKey: (i) => {
      const e = matches[i];
      return e ? `${e.commitHash ?? "pending"}:${e.path}:${i}` : i;
    },
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      id="history-list"
      className={visible ? "open" : undefined}
      aria-label="edit history"
    >
      {matches.length === 0 ? (
        <div className="search-empty">
          {query.trim() ? `No edits match "${query}"` : "No edit history"}
        </div>
      ) : (
        <div
          className="virtual-rows"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {items.map((vi) => {
            const entry = matches[vi.index]!;
            const slash = entry.path.lastIndexOf("/");
            const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : "";
            const name = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
            const { ext, color } = fileIconLabel(name);
            const status = STATUS_META[entry.status];
            const disabled = entry.status === "deleted";
            return (
              <button
                key={vi.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                type="button"
                className="history-item"
                data-path={entry.path}
                disabled={disabled}
                style={{ transform: `translateY(${vi.start}px)` }}
                onClick={() => onOpenFile(entry.path)}
              >
                <span className="file-icon" style={{ background: color }}>
                  {ext}
                </span>
                <span className="history-item-text">
                  <span className="history-topline">
                    <span className="filename">{name}</span>
                    <span className="history-time">{entry.relativeDate ?? ""}</span>
                  </span>
                  {dir && <span className="filepath">{dir}</span>}
                  <span className="history-subject">
                    {entry.pending ? "Working tree" : entry.commitShortHash} · {entry.subject}
                  </span>
                </span>
                <span
                  className="git-status-badge"
                  style={{ color: status.color, borderColor: status.color }}
                  title={status.label}
                  aria-label={`${status.label} file`}
                >
                  {status.letter}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
