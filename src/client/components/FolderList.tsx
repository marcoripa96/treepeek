import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { GitStatusEntry } from "@pierre/trees";
import { fileIconLabel } from "../lib/fileIcon";
import { hapticSelection } from "../lib/haptics";
import { ChevronRight, Folder } from "./icons";

const FOLDER_LIST_LIMIT = 5000;

type Status = GitStatusEntry["status"];

const STATUS_META: Record<Status, { letter: string; color: string; label: string }> = {
  modified: { letter: "M", color: "#f59e0b", label: "modified" },
  added: { letter: "A", color: "#10b981", label: "added" },
  deleted: { letter: "D", color: "#ef4444", label: "deleted" },
  untracked: { letter: "U", color: "#3b82f6", label: "untracked" },
  renamed: { letter: "R", color: "#8b5cf6", label: "renamed" },
  ignored: { letter: "I", color: "#94a3b8", label: "ignored" },
};

interface Props {
  paths: string[];
  query: string;
  gitStatus: GitStatusEntry[] | null;
  onOpenFile: (path: string) => void;
  visible: boolean;
}

interface DirRow {
  type: "dir";
  path: string;
  name: string;
  childCount: number;
}
interface FileRow {
  type: "file";
  path: string;
  name: string;
  /** Path of the file relative to the current view root, when in flat search mode. */
  relPath: string;
}
type Row = DirRow | FileRow;

export function FolderList({
  paths,
  query,
  gitStatus,
  onOpenFile,
  visible,
}: Props) {
  const [currentDir, setCurrentDir] = useState<string>("");
  const parentRef = useRef<HTMLDivElement>(null);

  const childrenByDir = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const p of paths) {
      const isDir = p.endsWith("/");
      const trimmed = isDir ? p.slice(0, -1) : p;
      const slash = trimmed.lastIndexOf("/");
      const parent = slash >= 0 ? trimmed.slice(0, slash + 1) : "";
      const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
      let bucket = map.get(parent);
      if (!bucket) {
        bucket = [];
        map.set(parent, bucket);
      }
      bucket.push(
        isDir
          ? { type: "dir", path: p, name, childCount: 0 }
          : { type: "file", path: p, name, relPath: "" }
      );
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
    for (const list of map.values()) {
      for (const row of list) {
        if (row.type === "dir") {
          row.childCount = map.get(row.path)?.length ?? 0;
        }
      }
    }
    return map;
  }, [paths]);

  // Reset to root if the current dir no longer exists in this paths set.
  useEffect(() => {
    if (currentDir === "") return;
    if (!childrenByDir.has(currentDir)) setCurrentDir("");
  }, [childrenByDir, currentDir]);

  const statusByPath = useMemo(() => {
    const map = new Map<string, Status>();
    if (!gitStatus) return map;
    for (const e of gitStatus) {
      if (e.status === "ignored") continue;
      map.set(e.path, e.status);
    }
    return map;
  }, [gitStatus]);

  // For each ancestor directory, mark whether it (recursively) contains changes.
  const dirsWithChanges = useMemo(() => {
    const set = new Set<string>();
    if (!gitStatus) return set;
    for (const e of gitStatus) {
      if (e.status === "ignored") continue;
      let cur = e.path;
      while (true) {
        const slash = cur.lastIndexOf("/");
        if (slash < 0) break;
        cur = cur.slice(0, slash);
        set.add(cur + "/");
      }
    }
    return set;
  }, [gitStatus]);

  const rows = useMemo<Row[]>(() => {
    const q = query.toLowerCase().trim();
    if (!q) {
      return childrenByDir.get(currentDir) ?? [];
    }
    const out: Row[] = [];
    for (const p of paths) {
      if (p.endsWith("/")) continue;
      if (currentDir && !p.startsWith(currentDir)) continue;
      if (!p.toLowerCase().includes(q)) continue;
      const slash = p.lastIndexOf("/");
      const name = slash >= 0 ? p.slice(slash + 1) : p;
      const relPath = currentDir ? p.slice(currentDir.length) : p;
      out.push({ type: "file", path: p, name, relPath });
      if (out.length >= FOLDER_LIST_LIMIT) break;
    }
    return out;
  }, [childrenByDir, currentDir, paths, query]);

  const breadcrumbs = useMemo(() => {
    if (!currentDir) return [] as { name: string; path: string }[];
    const segments = currentDir.split("/").filter(Boolean);
    const out: { name: string; path: string }[] = [];
    let acc = "";
    for (const seg of segments) {
      acc += seg + "/";
      out.push({ name: seg, path: acc });
    }
    return out;
  }, [currentDir]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 8,
    getItemKey: (i) => rows[i]?.path ?? i,
  });

  const items = virtualizer.getVirtualItems();
  const searching = query.trim().length > 0;

  const navigateTo = (dir: string) => {
    if (dir === currentDir) return;
    hapticSelection();
    setCurrentDir(dir);
    parentRef.current?.scrollTo({ top: 0 });
  };

  return (
    <div
      ref={parentRef}
      id="folder-list"
      className={visible ? "open" : undefined}
      aria-label="folders"
    >
      <div className="folder-breadcrumb" role="navigation" aria-label="current folder">
        <button
          type="button"
          className="folder-crumb folder-crumb-root"
          aria-current={currentDir === "" ? "location" : undefined}
          onClick={() => navigateTo("")}
        >
          <Folder width={15} height={15} />
          <span>Root</span>
        </button>
        {breadcrumbs.map((c, i) => {
          const last = i === breadcrumbs.length - 1;
          return (
            <span key={c.path} className="folder-crumb-wrap">
              <span className="folder-crumb-sep" aria-hidden="true">
                /
              </span>
              <button
                type="button"
                className="folder-crumb"
                aria-current={last ? "location" : undefined}
                onClick={() => navigateTo(c.path)}
              >
                {c.name}
              </button>
            </span>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <div className="search-empty">
          {searching
            ? `No files match "${query}"`
            : currentDir
              ? "Empty folder"
              : "No files"}
        </div>
      ) : (
        <div
          className="virtual-rows"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {items.map((vi) => {
            const row = rows[vi.index]!;
            if (row.type === "dir") {
              const hasChanges = dirsWithChanges.has(row.path);
              return (
                <button
                  key={vi.key}
                  ref={virtualizer.measureElement}
                  data-index={vi.index}
                  type="button"
                  className="folder-item folder-item-dir"
                  data-path={row.path}
                  style={{ transform: `translateY(${vi.start}px)` }}
                  onClick={() => navigateTo(row.path)}
                >
                  <span className="folder-dir-icon" aria-hidden="true">
                    <Folder width={20} height={20} />
                  </span>
                  <span className="folder-item-text">
                    <span className="filename">{row.name}</span>
                    <span className="folder-item-meta">
                      {row.childCount} {row.childCount === 1 ? "item" : "items"}
                    </span>
                  </span>
                  {hasChanges && (
                    <span
                      className="folder-change-dot"
                      title="contains changes"
                      aria-label="contains changes"
                    />
                  )}
                  <ChevronRight
                    className="folder-item-chevron"
                    width={18}
                    height={18}
                  />
                </button>
              );
            }
            const { ext, color } = fileIconLabel(row.name);
            const status = statusByPath.get(row.path);
            const statusMeta = status ? STATUS_META[status] : null;
            return (
              <button
                key={vi.key}
                ref={virtualizer.measureElement}
                data-index={vi.index}
                type="button"
                className="folder-item folder-item-file"
                data-path={row.path}
                style={{ transform: `translateY(${vi.start}px)` }}
                onClick={() => onOpenFile(row.path)}
              >
                <span className="file-icon" style={{ background: color }}>
                  {ext}
                </span>
                <span className="folder-item-text">
                  <span className="filename">{row.name}</span>
                  {searching && row.relPath !== row.name && (
                    <span className="filepath">{row.relPath}</span>
                  )}
                </span>
                {statusMeta && (
                  <span
                    className="folder-status-dot"
                    style={{ background: statusMeta.color }}
                    title={statusMeta.label}
                    aria-label={`${statusMeta.label} file`}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
