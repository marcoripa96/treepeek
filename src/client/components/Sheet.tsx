import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchFile,
  fetchOutline,
  type OutlineLink,
  type OutlineSymbol,
} from "../lib/api";
import { formatSize } from "../lib/formatSize";
import { highlightAsync } from "../lib/highlighter";
import { hapticLight, hapticSelection } from "../lib/haptics";
import { formatLineHash, type LineRange } from "../lib/lineHash";
import { ChevronDown, List as ListIcon, Share } from "./icons";
import { OutlinePanel } from "./OutlinePanel";

const DiffView = lazy(() =>
  import("./DiffView").then((m) => ({ default: m.DiffView }))
);

interface Props {
  path: string | null;
  ws: number | null;
  hasDiff: boolean;
  lineRange: LineRange | null;
  onLineRangeChange: (range: LineRange | null) => void;
  onNavigate: (path: string) => void;
  onClose: () => void;
}

type Mode = "content" | "diff";

type RenderState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "text"; content: string; path: string }
  | { kind: "image"; mime: string; base64: string }
  | { kind: "unsupported"; reason: string; size: number };

export function Sheet({
  path,
  ws,
  hasDiff,
  lineRange,
  onLineRangeChange,
  onNavigate,
  onClose,
}: Props) {
  const [state, setState] = useState<RenderState>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>("content");
  const [shareToast, setShareToast] = useState<string | null>(null);
  const [symbols, setSymbols] = useState<OutlineSymbol[]>([]);
  const [links, setLinks] = useState<OutlineLink[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const sheetRef = useRef<HTMLElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMode("content");
    setOutlineOpen(false);
    setSymbols([]);
    setLinks([]);
  }, [path]);

  // Fetch outline whenever the file changes.
  useEffect(() => {
    if (!path) return;
    const abort = new AbortController();
    (async () => {
      const data = await fetchOutline(path, ws, abort.signal);
      if (abort.signal.aborted || !data) return;
      setSymbols(data.symbols);
      setLinks(data.links);
    })();
    return () => abort.abort();
  }, [path, ws]);

  useEffect(() => {
    if (!hasDiff && mode === "diff") setMode("content");
  }, [hasDiff, mode]);

  useEffect(() => {
    if (!path) return;
    setState({ kind: "loading" });
    const abort = new AbortController();
    (async () => {
      try {
        const data = await fetchFile(path, ws, abort.signal);
        if (data.truncated) {
          setState({
            kind: "unsupported",
            reason: data.reason ?? "File too large to preview.",
            size: data.size,
          });
        } else if (
          data.encoding === "base64" &&
          data.content &&
          data.mime.startsWith("image/")
        ) {
          setState({ kind: "image", mime: data.mime, base64: data.content });
        } else if (data.isBinary) {
          setState({
            kind: "unsupported",
            reason: data.reason ?? "Binary file — preview unavailable.",
            size: data.size,
          });
        } else if (data.encoding === "utf8" && data.content !== null) {
          setState({ kind: "text", content: data.content, path });
        } else {
          setState({
            kind: "unsupported",
            reason: "Preview unavailable.",
            size: data.size,
          });
        }
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        const msg = err instanceof Error ? err.message : "Failed to load file.";
        setState({ kind: "error", message: msg });
      }
    })();
    return () => abort.abort();
  }, [path, ws]);

  useEffect(() => {
    const handle = handleRef.current;
    const sheet = sheetRef.current;
    if (!handle || !sheet) return;
    let dragStartY: number | null = null;
    let dragOffset = 0;
    const onPointerDown = (e: PointerEvent) => {
      dragStartY = e.clientY;
      dragOffset = 0;
      handle.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (dragStartY === null) return;
      const dy = e.clientY - dragStartY;
      if (dy < 0) return;
      dragOffset = dy;
      sheet.style.transform = `translateY(${dy}px)`;
    };
    const onPointerUp = () => {
      if (dragStartY === null) return;
      sheet.style.transform = "";
      if (dragOffset > 100) {
        hapticLight();
        onClose();
      }
      dragStartY = null;
      dragOffset = 0;
    };
    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", onPointerUp);
    return () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUp);
    };
  }, [onClose]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let startY = 0;
    let startX = 0;
    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0]?.clientY ?? 0;
      startX = e.touches[0]?.clientX ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const top = body.scrollTop;
      const left = body.scrollLeft;
      const maxY = body.scrollHeight - body.clientHeight;
      const maxX = body.scrollWidth - body.clientWidth;
      const y = e.touches[0]?.clientY ?? 0;
      const x = e.touches[0]?.clientX ?? 0;
      const dy = y - startY;
      const dx = x - startX;
      if (Math.abs(dx) > Math.abs(dy)) {
        if (maxX <= 0) {
          e.preventDefault();
          return;
        }
        if (left <= 0 && dx > 0) e.preventDefault();
        else if (left >= maxX && dx < 0) e.preventDefault();
      } else {
        if (maxY <= 0) {
          e.preventDefault();
          return;
        }
        if (top <= 0 && dy > 0) e.preventDefault();
        else if (top >= maxY && dy < 0) e.preventDefault();
      }
    };
    body.addEventListener("touchstart", onTouchStart, { passive: true });
    body.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      body.removeEventListener("touchstart", onTouchStart);
      body.removeEventListener("touchmove", onTouchMove);
    };
  }, []);


  // Tap / long-press a line number to set or extend the line range.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const LONG_PRESS_MS = 380;
    const MOVE_TOLERANCE = 8;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let downX = 0;
    let downY = 0;
    let downLine: number | null = null;
    let didLongPress = false;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const lineFromTarget = (target: EventTarget | null): number | null => {
      const el = (target as HTMLElement | null)?.closest<HTMLElement>(".ln-num");
      if (!el) return null;
      const n = Number(el.dataset.line);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const onPointerDown = (e: PointerEvent) => {
      const n = lineFromTarget(e.target);
      if (n === null) return;
      downLine = n;
      downX = e.clientX;
      downY = e.clientY;
      didLongPress = false;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        didLongPress = true;
        const anchor = lineRange?.start ?? n;
        const start = Math.min(anchor, n);
        const end = Math.max(anchor, n);
        hapticSelection();
        onLineRangeChange({ start, end });
      }, LONG_PRESS_MS);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (downLine === null) return;
      const dx = Math.abs(e.clientX - downX);
      const dy = Math.abs(e.clientY - downY);
      if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) {
        clearTimer();
        downLine = null;
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const n = downLine;
      const wasLong = didLongPress;
      clearTimer();
      downLine = null;
      didLongPress = false;
      if (n === null) return;
      if (wasLong) return;
      // Tap: shift-click extends, plain click anchors.
      if (e.shiftKey && lineRange) {
        const anchor = lineRange.start;
        const start = Math.min(anchor, n);
        const end = Math.max(anchor, n);
        hapticSelection();
        onLineRangeChange({ start, end });
      } else {
        hapticSelection();
        onLineRangeChange({ start: n, end: n });
      }
    };

    const onPointerCancel = () => {
      clearTimer();
      downLine = null;
      didLongPress = false;
    };

    body.addEventListener("pointerdown", onPointerDown);
    body.addEventListener("pointermove", onPointerMove);
    body.addEventListener("pointerup", onPointerUp);
    body.addEventListener("pointercancel", onPointerCancel);
    return () => {
      body.removeEventListener("pointerdown", onPointerDown);
      body.removeEventListener("pointermove", onPointerMove);
      body.removeEventListener("pointerup", onPointerUp);
      body.removeEventListener("pointercancel", onPointerCancel);
      clearTimer();
    };
  }, [lineRange, onLineRangeChange]);

  const onCopyPath = async () => {
    if (!path) return;
    hapticSelection();
    try {
      await navigator.clipboard.writeText(path);
      setShareToast("Path copied");
    } catch {
      setShareToast("Copy failed");
    }
    setTimeout(() => setShareToast(null), 1400);
  };

  const onShare = async () => {
    if (!path) return;
    const url = new URL(location.origin);
    url.searchParams.set("file", path);
    url.hash = formatLineHash(lineRange);
    const shareUrl = url.toString();
    const title = path.split("/").pop() || path;
    hapticSelection();
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ url: shareUrl, title });
        return;
      } catch {
        // fall through to clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareToast("Link copied");
      setTimeout(() => setShareToast(null), 1400);
    } catch {
      setShareToast("Copy failed");
      setTimeout(() => setShareToast(null), 1400);
    }
  };

  const open = path !== null;
  return (
    <>
      <div
        id="sheet-backdrop"
        className={open ? "open" : undefined}
        onClick={() => {
          hapticLight();
          onClose();
        }}
      />
      <aside
        id="sheet"
        ref={sheetRef}
        className={open ? "open" : undefined}
        aria-hidden={!open}
      >
        <div className="sheet-handle" ref={handleRef} aria-label="Drag to dismiss" />
        <header className="sheet-header">
          <button
            type="button"
            className="sheet-title"
            aria-label="copy file path"
            onClick={onCopyPath}
          >
            {path ?? ""}
          </button>
          {symbols.length > 0 && mode === "content" && (
            <button
              type="button"
              className="sheet-outline-btn"
              aria-pressed={outlineOpen}
              aria-label="toggle outline"
              onClick={() => {
                hapticSelection();
                setOutlineOpen((o) => !o);
              }}
            >
              <ListIcon width={16} height={16} />
              <span className="outline-count">{symbols.length}</span>
              <ChevronDown
                width={14}
                height={14}
                className={
                  "outline-chevron" + (outlineOpen ? " open" : "")
                }
              />
            </button>
          )}
          {hasDiff && (
            <button
              type="button"
              className="sheet-diff-btn"
              aria-pressed={mode === "diff"}
              aria-label="toggle diff view"
              onClick={() => {
                hapticSelection();
                setMode((m) => (m === "diff" ? "content" : "diff"));
              }}
            >
              Diff
            </button>
          )}
          <button
            type="button"
            className="sheet-share-btn"
            aria-label="share link to this file"
            onClick={onShare}
          >
            <Share width={18} height={18} />
          </button>
        </header>
        {outlineOpen && symbols.length > 0 && mode === "content" && (
          <OutlinePanel
            symbols={symbols}
            activeLine={lineRange?.start ?? null}
            onJump={(line) => {
              hapticSelection();
              onLineRangeChange({ start: line, end: line });
              setOutlineOpen(false);
            }}
          />
        )}
        <div className="sheet-body" ref={bodyRef}>
          {mode === "diff" && path ? (
            <Suspense fallback={null}>
              <DiffView path={path} ws={ws} />
            </Suspense>
          ) : (
            <SheetBody
              state={state}
              lineRange={lineRange}
              links={links}
              onNavigate={onNavigate}
            />
          )}
        </div>
        {shareToast !== null && (
          <div className="sheet-toast" role="status">
            {shareToast}
          </div>
        )}
      </aside>
    </>
  );
}

function SheetBody({
  state,
  lineRange,
  links,
  onNavigate,
}: {
  state: RenderState;
  lineRange: LineRange | null;
  links: OutlineLink[];
  onNavigate: (path: string) => void;
}) {
  switch (state.kind) {
    case "loading":
      return null;
    case "error":
      return <div className="sheet-empty">{state.message}</div>;
    case "image":
      return <img src={`data:${state.mime};base64,${state.base64}`} alt="" />;
    case "unsupported":
      return (
        <div className="sheet-empty">
          {state.reason}
          <div className="badge">{formatSize(state.size)}</div>
        </div>
      );
    case "text":
      return (
        <TextRender
          content={state.content}
          path={state.path}
          lineRange={lineRange}
          links={links}
          onNavigate={onNavigate}
        />
      );
  }
}

function TextRender({
  content,
  path,
  lineRange,
  links,
  onNavigate,
}: {
  content: string;
  path: string;
  lineRange: LineRange | null;
  links: OutlineLink[];
  onNavigate: (path: string) => void;
}) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrolledKey = useRef<string | null>(null);

  const linkByLine = useMemo(() => {
    const m = new Map<number, string>();
    for (const l of links) m.set(l.line, l.target);
    return m;
  }, [links]);

  useEffect(() => {
    let cancelled = false;
    setHighlighted(null);
    scrolledKey.current = null;
    highlightAsync(content, path).then((html) => {
      if (!cancelled && html) setHighlighted(html);
    });
    return () => {
      cancelled = true;
    };
  }, [content, path]);

  // Apply highlight class to lines inside the active range.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const lines = host.querySelectorAll<HTMLElement>(".line[data-line]");
    const start = lineRange?.start ?? 0;
    const end = lineRange?.end ?? 0;
    for (const el of lines) {
      const n = Number(el.dataset.line);
      const inRange = start > 0 && n >= start && n <= end;
      el.classList.toggle("line-highlight", inRange);
    }
  }, [lineRange, highlighted, content]);

  // Stamp data-import-target on linkable lines so CSS + click delegation can
  // pick them up across re-renders (plain → highlighted handoff).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const lines = host.querySelectorAll<HTMLElement>(".line[data-line]");
    for (const el of lines) {
      const n = Number(el.dataset.line);
      const target = linkByLine.get(n);
      if (target) {
        el.dataset.importTarget = target;
      } else if (el.dataset.importTarget) {
        delete el.dataset.importTarget;
      }
    }
  }, [linkByLine, highlighted, content]);

  // Click delegation for import jumps. Skips clicks on the line-number column.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".ln-num")) return;
      const lnContent = target.closest(".ln-content");
      if (!lnContent) return;
      const line = lnContent.parentElement as HTMLElement | null;
      const dest = line?.dataset.importTarget;
      if (!dest) return;
      e.preventDefault();
      e.stopPropagation();
      hapticSelection();
      onNavigate(dest);
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  }, [onNavigate]);

  // Scroll the anchor line into view when the file/range changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !lineRange) return;
    const key = `${path}:${lineRange.start}-${lineRange.end}`;
    if (scrolledKey.current === key) return;
    const target = host.querySelector<HTMLElement>(
      `.line[data-line="${lineRange.start}"]`
    );
    if (!target) return;
    scrolledKey.current = key;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [lineRange, highlighted, path]);

  if (highlighted) {
    return (
      <div ref={hostRef} dangerouslySetInnerHTML={{ __html: highlighted }} />
    );
  }
  const lines = content.split("\n");
  return (
    <div ref={hostRef}>
      <pre className="plain">
        <code>
          {lines.map((line, i) => (
            <span key={i} className="line" data-line={i + 1}>
              <span className="ln-num" data-line={i + 1}>
                {i + 1}
              </span>
              <span className="ln-content">{line.length === 0 ? "​" : line}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
