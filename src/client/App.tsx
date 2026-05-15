import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  fetchInstances,
  fetchHistory,
  fetchPulse,
  fetchTree,
  type FsEvent,
  type GitHistoryEntry,
  type InstanceListEntry,
  type PulseResponse,
  type TreeResponse,
} from "./lib/api";
import { useSettings, type TreeViewMode, type ViewMode } from "./lib/settings";
import { SearchList } from "./components/SearchList";
import { FolderList } from "./components/FolderList";
import { HistoryList } from "./components/HistoryList";
import { PulseView } from "./components/PulseView";
import { ViewToggle } from "./components/ViewToggle";
import { SearchBar } from "./components/SearchBar";
import { FileView } from "./components/FileView";
import { SettingsSheet } from "./components/SettingsSheet";
import { Settings as SettingsIcon, SolarHamburgerMenuLinear } from "./components/icons";
import { setThemeColor } from "./lib/themeColor";
import { hapticSelection } from "./lib/haptics";
import {
  formatLineHash,
  parseLineHash,
  setHashSilently,
  type LineRange,
} from "./lib/lineHash";

const THEME_DEFAULT = "#ffffff";
const THEME_BACKDROP = "#dcdbda";
const THEME_DRAWER = "#ffffff";

type LiveStatus = "connected" | "connecting" | "disconnected";

function readWsFromUrl(): number | null {
  const v = new URLSearchParams(location.search).get("ws");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function setUrlWs(port: number | null) {
  const u = new URL(location.href);
  if (port == null) u.searchParams.delete("ws");
  else u.searchParams.set("ws", String(port));
  history.replaceState(null, "", u.toString());
}

function readFileFromUrl(): string | null {
  const v = new URLSearchParams(location.search).get("file");
  return v && v.length > 0 ? v : null;
}

function clearFileFromUrl() {
  const u = new URL(location.href);
  if (u.searchParams.has("file")) {
    u.searchParams.delete("file");
    history.replaceState(null, "", u.toString());
  }
}

export function App() {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [history, setHistory] = useState<GitHistoryEntry[]>([]);
  const [instances, setInstances] = useState<InstanceListEntry[]>([]);
  const [selfPort, setSelfPort] = useState<number | null>(null);
  const [currentWs, setCurrentWs] = useState<number | null>(readWsFromUrl());
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("connecting");
  const [selectedFile, setSelectedFile] = useState<string | null>(readFileFromUrl);
  const [lineRange, setLineRange] = useState<LineRange | null>(() =>
    parseLineHash(location.hash)
  );
  const [statusMsg, setStatusMsg] = useState<string | null>("Loading…");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [directoriesOpen, setDirectoriesOpen] = useState(false);

  const mainRef = useRef<HTMLElement | null>(null);
  const edgeRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  const [settings, updateSettings] = useSettings();
  // Cold open always lands on Pulse. The user can switch into a tree view via
  // the ViewToggle, and that choice persists as `lastTreeView` so back-from-Pulse
  // restores it.
  const [viewMode, setViewModeState] = useState<ViewMode>("pulse");
  const setViewMode = useCallback(
    (mode: ViewMode) => {
      setViewModeState(mode);
      if (mode !== "pulse") updateSettings({ lastTreeView: mode as TreeViewMode });
    },
    [updateSettings]
  );
  const enterPulse = useCallback(() => setViewModeState("pulse"), []);
  const exitPulse = useCallback(() => {
    setViewModeState(settings.lastTreeView);
  }, [settings.lastTreeView]);
  const [pulse, setPulse] = useState<PulseResponse | null>(null);

  // Bootstrap: load instances once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const inst = await fetchInstances();
      if (cancelled || !inst) return;
      setInstances(inst.instances);
      setSelfPort(inst.selfPort);
      const target = currentWs ?? inst.selfPort;
      const known = inst.instances.some((i) => i.port === target);
      if (!known) {
        setCurrentWs(null);
        setUrlWs(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load tree + pulse whenever the active instance changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [data, historyData, pulseData] = await Promise.all([
        fetchTree(currentWs),
        fetchHistory(currentWs),
        fetchPulse(currentWs),
      ]);
      if (cancelled) return;
      if (data) {
        setTree(data);
        setStatusMsg(null);
      } else {
        setStatusMsg("Failed to load tree.");
      }
      if (historyData) setHistory(historyData.entries);
      if (pulseData) setPulse(pulseData);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentWs]);

  // Live websocket: reconnect on instance change, refetch tree on "changed"
  useEffect(() => {
    let stopped = false;
    let ws: WebSocket | null = null;
    let backoff = 500;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refresh = async () => {
      const [data, historyData, pulseData] = await Promise.all([
        fetchTree(currentWs),
        fetchHistory(currentWs),
        fetchPulse(currentWs),
      ]);
      if (stopped) return;
      if (data) setTree(data);
      if (historyData) setHistory(historyData.entries);
      if (pulseData) setPulse(pulseData);
    };

    const connect = () => {
      if (stopped) return;
      setLiveStatus("connecting");
      // Resolve "ws" against document.baseURI so the connection lands inside
      // the funnel-mount prefix when one is in effect.
      const wsUrl = new URL("ws", document.baseURI);
      wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      if (currentWs != null) wsUrl.searchParams.set("ws", String(currentWs));
      const url = wsUrl.toString();
      try {
        ws = new WebSocket(url);
      } catch {
        setLiveStatus("disconnected");
        scheduleReconnect();
        return;
      }
      ws.addEventListener("open", () => {
        backoff = 500;
        if (!stopped) setLiveStatus("connected");
      });
      ws.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data as string) as {
            type?: string;
            events?: FsEvent[];
          };
          if (data.type === "changed") {
            void refresh();
          } else if (data.type === "fs" && Array.isArray(data.events)) {
            const events = data.events;
            setPulse((prev) =>
              prev
                ? {
                    ...prev,
                    recentEvents: [...prev.recentEvents, ...events].slice(-100),
                  }
                : prev
            );
          }
        } catch {}
      });
      ws.addEventListener("close", () => {
        if (stopped) return;
        setLiveStatus("disconnected");
        scheduleReconnect();
      });
      ws.addEventListener("error", () => {
        try {
          ws?.close();
        } catch {}
      });
    };
    const scheduleReconnect = () => {
      if (stopped) return;
      timer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    };

    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.close();
      } catch {}
    };
  }, [currentWs]);

  // Service worker registration + auto-reload on activation + open-file from notification click
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let didReload = false;
    const onMessage = (event: MessageEvent) => {
      const data = (event.data ?? null) as { type?: string; path?: string } | null;
      if (data?.type === "sw-activated" && !didReload) {
        didReload = true;
        location.reload();
      } else if (data?.type === "open-file" && typeof data.path === "string") {
        setSelectedFile(data.path);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    navigator.serviceWorker
      .register("sw.js")
      .then((reg) => {
        reg.update().catch(() => {});
      })
      .catch(() => {});
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  // Clean ?file= from URL once it's been consumed
  useEffect(() => {
    if (selectedFile !== null) clearFileFromUrl();
  }, [selectedFile]);

  // External hash changes (back/forward, deep link click) → update lineRange.
  useEffect(() => {
    const onHashChange = () => {
      setLineRange(parseLineHash(location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // When the line range changes from in-app interaction, mirror it into the URL hash.
  useEffect(() => {
    const desired = formatLineHash(lineRange);
    if (location.hash !== desired) setHashSilently(desired);
  }, [lineRange]);

  // Closing the file or switching files clears the line range.
  useEffect(() => {
    if (selectedFile === null && lineRange !== null) setLineRange(null);
  }, [selectedFile, lineRange]);

  // Drive iOS / PWA status-bar color from UI state
  useEffect(() => {
    const target =
      selectedFile !== null || settingsOpen
        ? THEME_BACKDROP
        : directoriesOpen
          ? THEME_DRAWER
          : THEME_DEFAULT;
    setThemeColor(target, 240);
  }, [selectedFile, settingsOpen, directoriesOpen]);

  // Native-feel drawer swipe. Listens at the document level so a horizontal
  // drag started anywhere on the page can open or close the drawer — not just
  // a thin edge strip. The strict direction filter (vertical drops the
  // gesture) keeps page scrolling untouched, and we only capture the pointer
  // once a horizontal motion has committed so taps/clicks fall through.
  // Bypassed while another sheet is foregrounded since those own the gesture.
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    if (selectedFile !== null || settingsOpen) return;

    const COMMIT_PX = 6;
    // Window over which release velocity is averaged. Wide enough to ride out
    // the natural tail-off at the end of a flick, narrow enough that a tap
    // doesn't read as motion.
    const VELOCITY_WINDOW_MS = 80;
    // WWDC18 "Designing Fluid Interfaces" projection horizon. Snap by where
    // the finger would land if motion continued at the current velocity,
    // unifying "drag past half" and "tiny fast flick" into a single rule.
    const PROJECTION_MS = 700;
    // UIScrollView rubber-band coefficient — the same formula used in
    // _UIScrollViewRubberBandClampedValue. Past either endpoint the transform
    // decelerates asymptotically toward a fraction of the dimension.
    const RUBBER_COEFF = 0.55;
    const rubberBand = (distance: number, dimension: number) => {
      if (dimension <= 0) return 0;
      return (1 - 1 / ((distance * RUBBER_COEFF) / dimension + 1)) * dimension;
    };

    let panelWidth = 0;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let committed = false;
    let pointerId: number | null = null;
    let cleanupTransition: (() => void) | null = null;
    // Rolling sample buffer for windowed velocity; single-frame velocity is
    // too noisy at release for a small flick to read as intent reliably.
    const samples: { x: number; t: number }[] = [];

    const recordSample = (clientX: number, t: number) => {
      samples.push({ x: clientX, t });
      while (samples.length > 1 && samples[0]!.t < t - VELOCITY_WINDOW_MS) {
        samples.shift();
      }
    };
    const windowedVelocity = (): number => {
      if (samples.length < 2) return 0;
      const oldest = samples[0]!;
      const newest = samples[samples.length - 1]!;
      const dt = newest.t - oldest.t;
      return dt > 0 ? (newest.x - oldest.x) / dt : 0;
    };

    const settleTo = (snapOpen: boolean) => {
      cleanupTransition?.();
      cleanupTransition = null;
      const targetX = snapOpen ? panelWidth : 0;
      main.style.transition = "";
      main.style.transform = `translate3d(${targetX}px, 0, 0)`;
      // Animate the progress variable to the snap target alongside the
      // transform — same transition + curve picks it up. Without this, on
      // release the radius/shadow would jump straight to the final value
      // while the slide tweens.
      main.style.setProperty("--drawer-progress", snapOpen ? "1" : "0");
      if (snapOpen !== directoriesOpen) {
        hapticSelection();
        setDirectoriesOpen(snapOpen);
      }
      const finish = () => {
        // Hand control back to the CSS state-driven rules. Inline styles are
        // cleared so a subsequent tap-toggle animates from the
        // data-attribute-derived value instead of the stale inline one.
        main.style.transform = "";
        main.style.removeProperty("--drawer-progress");
        // Restore browser scrolling: we only need to block it during an
        // active drag, never between gestures.
        main.style.touchAction = "";
        main.removeEventListener("transitionend", onEnd);
        clearTimeout(fallback);
        cleanupTransition = null;
      };
      const onEnd = (e: TransitionEvent) => {
        if (e.propertyName === "transform") finish();
      };
      main.addEventListener("transitionend", onEnd);
      const fallback = window.setTimeout(finish, 320);
      cleanupTransition = finish;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      panelWidth = panelRef.current?.offsetWidth ?? 0;
      if (panelWidth <= 0) return;
      pointerId = e.pointerId;
      startX = lastX = e.clientX;
      startY = lastY = e.clientY;
      committed = false;
      samples.length = 0;
      samples.push({ x: e.clientX, t: e.timeStamp });
    };

    const onPointerMove = (e: PointerEvent) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // Sample on every move — including before commit — so the release
      // velocity reflects the whole gesture, not just the last frame.
      recordSample(e.clientX, e.timeStamp);
      lastX = e.clientX;
      lastY = e.clientY;

      if (!committed) {
        // Wait until horizontal motion clears the threshold. Vertical-only
        // motion never commits the drawer — but we don't *drop* the gesture
        // on a vertical wobble either, because the user might be aiming
        // horizontal and we'd rather wait than reject prematurely.
        if (Math.abs(dx) < COMMIT_PX) return;
        // Decide direction at commit time. If vertical clearly dominates
        // the horizontal threshold-crossing motion, this is a scroll
        // attempt — hand the gesture back to the browser.
        if (Math.abs(dy) > Math.abs(dx)) {
          pointerId = null;
          return;
        }
        if (!directoriesOpen && dx <= 0) {
          pointerId = null;
          return;
        }
        if (directoriesOpen && dx >= 0) {
          pointerId = null;
          return;
        }
        committed = true;
        // Capture the pointer so subsequent moves keep firing to JS even if
        // iOS Safari would otherwise reclaim the gesture for a native pan or
        // back-swipe — without this, a slightly diagonal drag reads as
        // "cancelled" mid-flick. We capture on the document's body since the
        // listeners live at document level.
        try {
          (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
        } catch {}
        cleanupTransition?.();
        cleanupTransition = null;
        main.style.transition = "none";
        // Lock out browser scrolling for the duration of the gesture. Even
        // with `touch-action: pan-y` set, a diagonal drift mid-drag can let
        // the browser claim the touch for vertical scroll and cancel ours;
        // forcing `none` once we own the gesture prevents that race.
        main.style.touchAction = "none";
      }

      const baseX = directoriesOpen ? panelWidth : 0;
      const raw = baseX + dx;
      // Rubber-band when the drag pulls past either endpoint instead of
      // hard-clamping. Past 0 we resist by (raw < 0)'s magnitude, past
      // width by (raw - width)'s magnitude.
      let nextX: number;
      if (raw < 0) {
        nextX = -rubberBand(-raw, panelWidth);
      } else if (raw > panelWidth) {
        nextX = panelWidth + rubberBand(raw - panelWidth, panelWidth);
      } else {
        nextX = raw;
      }
      main.style.transform = `translate3d(${nextX}px, 0, 0)`;
      // Drive --drawer-progress in lockstep with the transform so the corner
      // radius and drop shadow are visible from the very first pixel of the
      // drag — without this they'd only appear after the snap commits.
      // Clamped to [0, 1] so the rubber-band over-pull doesn't over-shade.
      const progress = Math.max(0, Math.min(1, nextX / panelWidth));
      main.style.setProperty("--drawer-progress", String(progress));

      if (e.cancelable) e.preventDefault();
    };

    const onPointerEnd = (e: PointerEvent) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const dx = lastX - startX;
      const dy = lastY - startY;
      // Sub-threshold gestures that are vertical (scroll) or motionless
      // (tap) shouldn't decide anything. Committed drags already passed
      // the direction filter in onPointerMove.
      if (!committed && Math.abs(dx) <= Math.abs(dy)) {
        pointerId = null;
        return;
      }
      const v = windowedVelocity();
      const baseX = directoriesOpen ? panelWidth : 0;
      const currentX = committed
        ? Math.max(0, Math.min(panelWidth, baseX + dx))
        : baseX;
      // Project where the drag would land if motion continued at the
      // current velocity. Snap to whichever side that lands on.
      const projected = currentX + v * PROJECTION_MS;
      settleTo(projected > panelWidth / 2);
      pointerId = null;
      committed = false;
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (pointerId !== null && e.pointerId !== pointerId) return;
      if (committed) settleTo(directoriesOpen);
      pointerId = null;
      committed = false;
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointermove", onPointerMove, { passive: false });
    document.addEventListener("pointerup", onPointerEnd);
    document.addEventListener("pointercancel", onPointerCancel);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerEnd);
      document.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [directoriesOpen, selectedFile, settingsOpen]);

  const onSelectPort = useCallback(
    (port: number) => {
      if (selfPort == null) return;
      hapticSelection();
      const newWs = port === selfPort ? null : port;
      setCurrentWs(newWs);
      setUrlWs(newWs);
      setSearchQuery("");
      setSearchOpen(false);
      setDirectoriesOpen(false);
    },
    [selfPort]
  );

  const onCloseSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  const onOpenFile = useCallback((path: string) => {
    hapticSelection();
    setSelectedFile((prev) => {
      if (prev !== path) setLineRange(null);
      return path;
    });
  }, []);

  const onCloseFile = useCallback(() => {
    setSelectedFile(null);
  }, []);

  const visiblePaths = useMemo(() => {
    if (!tree) return [];
    return tree.paths;
  }, [tree]);

  const selectedPort = currentWs ?? selfPort ?? 0;
  const activeQuery = searchOpen ? searchQuery : "";

  const selectedFileHasDiff = useMemo(() => {
    if (!selectedFile || !tree?.gitStatus) return false;
    const entry = tree.gitStatus.find((e) => e.path === selectedFile);
    if (!entry) return false;
    return entry.status !== "ignored" && entry.status !== "deleted";
  }, [selectedFile, tree?.gitStatus]);

  return (
    <div className="directory-shell" data-directories-open={directoriesOpen ? "true" : "false"}>
      <aside className="directory-panel" aria-label="directories" ref={panelRef}>
        <div className="directory-panel-title">Directories</div>
        <div className="directory-panel-list" role="listbox" aria-label="available directories">
          {instances.length === 0 ? (
            <div className="directory-panel-empty">No directories</div>
          ) : (
            instances.map((instance) => (
              <button
                key={instance.port}
                type="button"
                role="option"
                className="directory-panel-item"
                aria-selected={instance.port === selectedPort}
                onClick={() => onSelectPort(instance.port)}
              >
                {instance.displayRoot}
              </button>
            ))
          )}
        </div>
        <button
          type="button"
          className="directory-panel-settings"
          aria-label="open settings"
          onClick={() => {
            hapticSelection();
            setSettingsOpen(true);
          }}
        >
          <SettingsIcon width={22} height={22} />
          <span>Settings</span>
        </button>
      </aside>

      <main className="directory-main" ref={mainRef}>
        <div
          className="directory-scrim"
          ref={scrimRef}
          aria-hidden={!directoriesOpen}
          onClick={() => {
            hapticSelection();
            setDirectoriesOpen(false);
          }}
        />
        <div
          className="directory-edge-swipe"
          ref={edgeRef}
          aria-hidden="true"
        />
        <div className="directory-topbar">
          <button
            type="button"
            className="directory-toggle"
            aria-label={directoriesOpen ? "close directories" : "open directories"}
            aria-expanded={directoriesOpen}
            onClick={() => {
              hapticSelection();
              setDirectoriesOpen((open) => !open);
            }}
          >
            <SolarHamburgerMenuLinear width={22} height={22} />
          </button>
          <button
            type="button"
            className="directory-label"
            title={tree?.displayRoot ?? ""}
            aria-label="open pulse"
            aria-pressed={viewMode === "pulse"}
            onClick={() => {
              hapticSelection();
              enterPulse();
            }}
          >
            {tree?.displayRoot ?? "Loading…"}
          </button>
        </div>

        <div
          className="toolbar-status"
          data-state={liveStatus}
          aria-label="live connection status"
        >
          <span className="dot" />
          <span className="label">
            {liveStatus === "connected" ? "connected" : liveStatus === "connecting" ? "…" : "offline"}
          </span>
        </div>

        <div className="directory-page">
          {viewMode === "pulse" ? (
            <PulseView data={pulse} onOpenFile={onOpenFile} />
          ) : tree ? (
            <>
              {viewMode === "list" ? (
                <SearchList
                  paths={visiblePaths}
                  query={activeQuery}
                  ws={currentWs}
                  gitStatus={tree.gitStatus}
                  onOpenFile={onOpenFile}
                  visible={true}
                />
              ) : viewMode === "folders" ? (
                <FolderList
                  paths={visiblePaths}
                  query={activeQuery}
                  gitStatus={tree.gitStatus}
                  onOpenFile={onOpenFile}
                  visible={true}
                />
              ) : (
                <HistoryList
                  entries={history}
                  query={activeQuery}
                  onOpenFile={onOpenFile}
                  visible={true}
                />
              )}
            </>
          ) : null}
          <ViewToggle
            mode={viewMode}
            onChange={setViewMode}
            onExitPulse={exitPulse}
            hidden={searchOpen}
          />
          {viewMode !== "pulse" ? (
            <SearchBar
              open={searchOpen}
              query={searchQuery}
              onQueryChange={setSearchQuery}
              onOpen={() => setSearchOpen(true)}
              onClose={onCloseSearch}
            />
          ) : null}
          {statusMsg !== null && <div id="status">{statusMsg}</div>}
        </div>
      </main>
      {selectedFile !== null && (
        <FileView
          path={selectedFile}
          ws={currentWs}
          hasDiff={selectedFileHasDiff}
          lineRange={lineRange}
          onLineRangeChange={setLineRange}
          onNavigate={onOpenFile}
          onClose={onCloseFile}
        />
      )}
      <SettingsSheet
        open={settingsOpen}
        settings={settings}
        onUpdate={updateSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
