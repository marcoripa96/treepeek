import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchInstances,
  fetchHistory,
  fetchTree,
  type GitHistoryEntry,
  type InstanceListEntry,
  type TreeResponse,
} from "./lib/api";
import { useSettings, type ViewMode } from "./lib/settings";
import { SearchList } from "./components/SearchList";
import { FolderList } from "./components/FolderList";
import { HistoryList } from "./components/HistoryList";
import { ViewToggle } from "./components/ViewToggle";
import { SearchBar } from "./components/SearchBar";
import { Sheet } from "./components/Sheet";
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

  const [settings, updateSettings] = useSettings();

  const viewMode: ViewMode = settings.defaultView;
  const setViewMode = useCallback(
    (mode: ViewMode) => updateSettings({ defaultView: mode }),
    [updateSettings]
  );

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

  // Load tree whenever the active instance changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [data, historyData] = await Promise.all([
        fetchTree(currentWs),
        fetchHistory(currentWs),
      ]);
      if (cancelled) return;
      if (data) {
        setTree(data);
        setStatusMsg(null);
      } else {
        setStatusMsg("Failed to load tree.");
      }
      if (historyData) setHistory(historyData.entries);
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
      const [data, historyData] = await Promise.all([
        fetchTree(currentWs),
        fetchHistory(currentWs),
      ]);
      if (stopped) return;
      if (data) setTree(data);
      if (historyData) setHistory(historyData.entries);
    };

    const connect = () => {
      if (stopped) return;
      setLiveStatus("connecting");
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const path = "/ws" + (currentWs == null ? "" : `?ws=${currentWs}`);
      const url = `${proto}//${location.host}${path}`;
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
          const data = JSON.parse(event.data as string) as { type?: string };
          if (data.type === "changed") {
            void refresh();
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
      .register("/sw.js")
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
      <aside className="directory-panel" aria-label="directories">
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

      <main className="directory-main">
        <div
          className="directory-scrim"
          aria-hidden={!directoriesOpen}
          onClick={() => {
            hapticSelection();
            setDirectoriesOpen(false);
          }}
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
          <div className="directory-label" title={tree?.displayRoot ?? ""}>
            {tree?.displayRoot ?? "Loading…"}
          </div>
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

        {tree && (
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
        )}
        <ViewToggle mode={viewMode} onChange={setViewMode} hidden={searchOpen} />
        <SearchBar
          open={searchOpen}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onOpen={() => setSearchOpen(true)}
          onClose={onCloseSearch}
        />
        {statusMsg !== null && <div id="status">{statusMsg}</div>}
        <Sheet
          path={selectedFile}
          ws={currentWs}
          hasDiff={selectedFileHasDiff}
          lineRange={lineRange}
          onLineRangeChange={setLineRange}
          onNavigate={onOpenFile}
          onClose={onCloseFile}
        />
      </main>
      <SettingsSheet
        open={settingsOpen}
        settings={settings}
        onUpdate={updateSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
