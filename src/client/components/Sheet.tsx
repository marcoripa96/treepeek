import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { fetchFile } from "../lib/api";
import { formatSize } from "../lib/formatSize";
import { highlightAsync } from "../lib/highlighter";
import { hapticLight, hapticSelection } from "../lib/haptics";

const DiffView = lazy(() =>
  import("./DiffView").then((m) => ({ default: m.DiffView }))
);

interface Props {
  path: string | null;
  ws: number | null;
  hasDiff: boolean;
  onClose: () => void;
}

type Mode = "content" | "diff";

type RenderState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "text"; content: string; path: string }
  | { kind: "image"; mime: string; base64: string }
  | { kind: "unsupported"; reason: string; size: number };

export function Sheet({ path, ws, hasDiff, onClose }: Props) {
  const [state, setState] = useState<RenderState>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>("content");
  const sheetRef = useRef<HTMLElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMode("content");
  }, [path]);

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
          <div className="sheet-title">{path ?? ""}</div>
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
        </header>
        <div className="sheet-body" ref={bodyRef}>
          {mode === "diff" && path ? (
            <Suspense fallback={null}>
              <DiffView path={path} ws={ws} />
            </Suspense>
          ) : (
            <SheetBody state={state} />
          )}
        </div>
      </aside>
    </>
  );
}

function SheetBody({ state }: { state: RenderState }) {
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
      return <TextRender content={state.content} path={state.path} />;
  }
}

function TextRender({ content, path }: { content: string; path: string }) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHighlighted(null);
    highlightAsync(content, path).then((html) => {
      if (!cancelled && html) setHighlighted(html);
    });
    return () => {
      cancelled = true;
    };
  }, [content, path]);

  if (highlighted) {
    return <div dangerouslySetInnerHTML={{ __html: highlighted }} />;
  }
  const lines = content.split("\n");
  return (
    <pre className="plain">
      <code>
        {lines.map((line, i) => (
          <span key={i} className="line">
            <span className="ln-num">{i + 1}</span>
            <span className="ln-content">{line.length === 0 ? "​" : line}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}
