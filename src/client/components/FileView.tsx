import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  fetchFile,
  fetchOutline,
  type OutlineLink,
  type OutlineSymbol,
} from "../lib/api";
import { formatSize } from "../lib/formatSize";
import { highlightAsync } from "../lib/highlighter";
import { hapticSelection } from "../lib/haptics";
import { formatLineHash, type LineRange } from "../lib/lineHash";
import { ChevronDown, ChevronRight, List as ListIcon, Share } from "./icons";
import { OutlinePanel } from "./OutlinePanel";

const DiffView = lazy(() =>
  import("./DiffView").then((m) => ({ default: m.DiffView }))
);

interface Props {
  path: string;
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

export function FileView({
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
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const edgeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMode("content");
    setOutlineOpen(false);
    setSymbols([]);
    setLinks([]);
  }, [path]);

  useEffect(() => {
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

  // Keep horizontal/vertical bounce contained inside the body so the page
  // itself doesn't scroll out from under the topbar on iOS Safari.
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

  // Edge-swipe-from-left dismisses the file page. The root translates with the
  // finger; on release, either snap back (cancel) or call onClose, which the
  // App's startTransition turns into a nav-back view transition.
  useEffect(() => {
    const root = rootRef.current;
    const edge = edgeRef.current;
    if (!root || !edge) return;
    const COMMIT_PX = 8;
    const FLICK_VELOCITY = 0.4; // px/ms
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;
    let committed = false;
    let pointerId: number | null = null;

    const reset = () => {
      root.style.transition = "transform 200ms cubic-bezier(0.32, 0.72, 0, 1)";
      root.style.transform = "";
      const onEnd = () => {
        root.style.transition = "";
        root.removeEventListener("transitionend", onEnd);
      };
      root.addEventListener("transitionend", onEnd);
      window.setTimeout(onEnd, 280);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointerId = e.pointerId;
      startX = lastX = e.clientX;
      startY = e.clientY;
      lastT = e.timeStamp;
      velocity = 0;
      committed = false;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!committed) {
        if (Math.abs(dx) < COMMIT_PX && Math.abs(dy) < COMMIT_PX) return;
        if (Math.abs(dy) > Math.abs(dx) || dx <= 0) {
          pointerId = null;
          return;
        }
        committed = true;
        try {
          edge.setPointerCapture(e.pointerId);
        } catch {}
        root.style.transition = "none";
      }
      const nextX = Math.max(0, dx);
      root.style.transform = `translate3d(${nextX}px, 0, 0)`;
      const dt = e.timeStamp - lastT;
      if (dt > 0) {
        velocity = (e.clientX - lastX) / dt;
        lastX = e.clientX;
        lastT = e.timeStamp;
      }
      e.preventDefault();
    };

    const onPointerEnd = (e: PointerEvent) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const dx = lastX - startX;
      pointerId = null;
      if (!committed) return;
      committed = false;
      const width = window.innerWidth;
      const flicked = velocity > FLICK_VELOCITY;
      const past = dx > width * 0.35;
      if (flicked || past) {
        // Let onClose's startTransition drive the slide-out. We keep the
        // current translated position so the view-transition snapshot picks up
        // from where the finger left off.
        onClose();
      } else {
        reset();
      }
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (pointerId !== null && e.pointerId !== pointerId) return;
      if (committed) reset();
      pointerId = null;
      committed = false;
    };

    edge.addEventListener("pointerdown", onPointerDown);
    edge.addEventListener("pointermove", onPointerMove);
    edge.addEventListener("pointerup", onPointerEnd);
    edge.addEventListener("pointercancel", onPointerCancel);
    return () => {
      edge.removeEventListener("pointerdown", onPointerDown);
      edge.removeEventListener("pointermove", onPointerMove);
      edge.removeEventListener("pointerup", onPointerEnd);
      edge.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [onClose]);

  const onCopyPath = async () => {
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

  return (
    <section
      id="file-view"
      className="file-view"
      aria-label="file viewer"
      ref={rootRef}
    >
      <div
        className="file-view-edge-swipe"
        ref={edgeRef}
        aria-hidden="true"
      />
      <header className="file-view-header">
        <button
          type="button"
          className="file-back-btn"
          aria-label="back to list"
          onClick={() => {
            hapticSelection();
            onClose();
          }}
        >
          <ChevronRight width={20} height={20} className="file-back-chevron" />
        </button>
        <button
          type="button"
          className="file-path-btn"
          aria-label="copy file path"
          onClick={onCopyPath}
        >
          {path}
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
              className={"outline-chevron" + (outlineOpen ? " open" : "")}
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
        {mode === "diff" ? (
          <Suspense fallback={null}>
            <DiffView path={path} ws={ws} />
          </Suspense>
        ) : (
          <FileBody
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
    </section>
  );
}

function FileBody({
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
      return <div className="sheet-empty">Loading…</div>;
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
