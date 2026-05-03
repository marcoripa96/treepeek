import { useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { FsEvent, PulseResponse } from "../lib/api";

interface Props {
  data: PulseResponse | null;
  onOpenFile: (path: string) => void;
}

const FILE_SCHEME = "tpfile:";

export function PulseView({ data, onOpenFile }: Props) {
  useRelativeTimeTick();
  const markdown = useMemo(
    () => (data ? buildMarkdown(data) : "_Loading…_"),
    // Tick included so relative timestamps refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data]
  );

  const components = useMemo<Components>(
    () => ({
      a({ href, children, ...props }) {
        if (typeof href === "string" && href.startsWith(FILE_SCHEME)) {
          const path = decodeURIComponent(href.slice(FILE_SCHEME.length));
          return (
            <button
              type="button"
              className="pulse-md-link"
              onClick={() => onOpenFile(path)}
            >
              {children}
            </button>
          );
        }
        return (
          <a {...props} href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
    }),
    [onOpenFile]
  );

  return (
    <article className="pulse-md">
      <ReactMarkdown components={components}>{markdown}</ReactMarkdown>
    </article>
  );
}

function buildMarkdown(data: PulseResponse): string {
  const lines: string[] = [];

  lines.push(`# ${data.branch ?? "(no branch)"}`);
  lines.push("");

  // ---- Status ----
  lines.push(`## Status`);
  const statusBits: string[] = [];
  statusBits.push(
    data.dirtyCount > 0
      ? `**${data.dirtyCount}** uncommitted change${data.dirtyCount === 1 ? "" : "s"}`
      : "clean working tree"
  );
  if (data.aheadBehind) {
    const { ahead, behind, upstream } = data.aheadBehind;
    if (ahead > 0) statusBits.push(`**${ahead}** ahead`);
    if (behind > 0) statusBits.push(`**${behind}** behind`);
    if (ahead === 0 && behind === 0 && upstream) {
      statusBits.push(`up to date with \`${upstream}\``);
    }
  }
  lines.push(statusBits.join(" · "));
  lines.push("");

  // ---- Recent commits ----
  lines.push(`## Recent commits`);
  if (data.recentCommits.length === 0) {
    lines.push("_No commits yet._");
  } else {
    for (const c of data.recentCommits) {
      lines.push(
        `- ${escapeMd(c.subject)}  \n  \`${c.shortHash}\` · ${escapeMd(c.author)} · ${c.relativeDate}`
      );
    }
  }
  lines.push("");

  // ---- Recent activity ----
  lines.push(`## Recent activity`);
  const deduped = dedupeRecent(data.recentEvents, 30);
  if (deduped.length === 0) {
    lines.push("_No file changes recorded yet._");
  } else {
    for (const ev of deduped) {
      const link = `[\`${ev.path}\`](${FILE_SCHEME}${encodeURIComponent(ev.path)})`;
      lines.push(`- ${link}  \n  ${labelForKind(ev.kind)} · ${formatRelative(ev.ts)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}\[\]()#+\-!>])/g, "\\$1");
}

function labelForKind(kind: FsEvent["kind"]): string {
  switch (kind) {
    case "create":
      return "created";
    case "remove":
      return "removed";
    case "modify":
      return "modified";
    default:
      return kind;
  }
}

function dedupeRecent(events: FsEvent[], limit: number): FsEvent[] {
  const seen = new Set<string>();
  const out: FsEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || seen.has(ev.path)) continue;
    seen.add(ev.path);
    out.push(ev);
    if (out.length >= limit) break;
  }
  return out;
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const seconds = Math.max(0, (Date.now() - t) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d ago`;
  return new Date(t).toLocaleDateString();
}

export function useRelativeTimeTick(intervalMs = 30_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
}
