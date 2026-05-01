import { FileTree, type GitStatusEntry } from "@pierre/trees";
import { highlight } from "./highlight.ts";

interface TreeResponse {
  root: string;
  absoluteRoot: string;
  displayRoot: string;
  paths: string[];
  truncated: boolean;
  count: number;
  gitStatus: GitStatusEntry[] | null;
}

interface FileResponse {
  path: string;
  size: number;
  mime: string;
  encoding: "utf8" | "base64";
  content: string | null;
  isBinary: boolean;
  truncated: boolean;
  reason?: string;
}

const statusEl = document.getElementById("status") as HTMLElement;
const treeEl = document.getElementById("tree") as HTMLElement;
const toolbarPathEl = document.querySelector(".toolbar-path") as HTMLElement;
const pullEl = document.getElementById("pull") as HTMLElement;
const sheetEl = document.getElementById("sheet") as HTMLElement;
const backdropEl = document.getElementById("sheet-backdrop") as HTMLElement;
const sheetBody = sheetEl.querySelector(".sheet-body") as HTMLElement;
const sheetTitle = sheetEl.querySelector(".sheet-title") as HTMLElement;
const sheetMeta = sheetEl.querySelector(".sheet-meta") as HTMLElement;
const sheetClose = sheetEl.querySelector(".sheet-close") as HTMLButtonElement;
const sheetHandle = sheetEl.querySelector(".sheet-handle") as HTMLElement;

function setStatus(msg: string | null) {
  if (!msg) {
    statusEl.classList.add("hidden");
  } else {
    statusEl.textContent = msg;
    statusEl.classList.remove("hidden");
  }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function openSheet() {
  sheetEl.classList.add("open");
  backdropEl.classList.add("open");
}

function closeSheet() {
  sheetEl.classList.remove("open");
  backdropEl.classList.remove("open");
}

backdropEl.addEventListener("click", closeSheet);
sheetClose.addEventListener("click", closeSheet);

let dragStartY: number | null = null;
let dragOffset = 0;
sheetHandle.addEventListener("pointerdown", (e) => {
  dragStartY = e.clientY;
  dragOffset = 0;
  sheetHandle.setPointerCapture(e.pointerId);
});
sheetHandle.addEventListener("pointermove", (e) => {
  if (dragStartY === null) return;
  const dy = e.clientY - dragStartY;
  if (dy < 0) return;
  dragOffset = dy;
  sheetEl.style.transform = `translateY(${dy}px)`;
});
sheetHandle.addEventListener("pointerup", () => {
  if (dragStartY === null) return;
  sheetEl.style.transform = "";
  if (dragOffset > 100) closeSheet();
  dragStartY = null;
  dragOffset = 0;
});

function renderError(msg: string) {
  sheetBody.innerHTML = "";
  const div = document.createElement("div");
  div.className = "sheet-empty";
  div.textContent = msg;
  sheetBody.appendChild(div);
}

function renderText(content: string, path: string) {
  sheetBody.innerHTML = "";
  const pre = document.createElement("pre");
  pre.className = "plain";
  const code = document.createElement("code");
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    const lineEl = document.createElement("span");
    lineEl.className = "line";
    const num = document.createElement("span");
    num.className = "ln-num";
    num.textContent = String(i + 1);
    const body = document.createElement("span");
    body.className = "ln-content";
    body.textContent = line.length === 0 ? "​" : line;
    lineEl.append(num, body);
    code.appendChild(lineEl);
  });
  pre.appendChild(code);
  sheetBody.appendChild(pre);
  sheetBody.scrollTop = 0;

  queueMicrotask(() => {
    const html = highlight(content, path);
    if (html) {
      sheetBody.innerHTML = html;
      sheetBody.scrollTop = 0;
    }
  });
}

function renderImage(mime: string, base64: string) {
  sheetBody.innerHTML = "";
  const img = document.createElement("img");
  img.src = `data:${mime};base64,${base64}`;
  img.alt = "";
  sheetBody.appendChild(img);
}

function renderUnsupported(reason: string, size: number) {
  sheetBody.innerHTML = "";
  const div = document.createElement("div");
  div.className = "sheet-empty";
  div.textContent = reason;
  const badge = document.createElement("div");
  badge.className = "badge";
  badge.textContent = formatSize(size);
  div.appendChild(badge);
  sheetBody.appendChild(div);
}

let inFlight: AbortController | null = null;
async function openFile(path: string) {
  sheetTitle.textContent = path;
  sheetMeta.textContent = "…";
  sheetBody.innerHTML = "";
  openSheet();

  inFlight?.abort();
  inFlight = new AbortController();
  try {
    const res = await fetch(`/api/file?p=${encodeURIComponent(path)}`, { signal: inFlight.signal });
    if (!res.ok) {
      renderError(`Error ${res.status}`);
      sheetMeta.textContent = "";
      return;
    }
    const data: FileResponse = await res.json();
    sheetMeta.textContent = formatSize(data.size);
    if (data.truncated) {
      renderUnsupported(data.reason ?? "File too large to preview.", data.size);
    } else if (data.encoding === "base64" && data.content && data.mime.startsWith("image/")) {
      renderImage(data.mime, data.content);
    } else if (data.isBinary) {
      renderUnsupported(data.reason ?? "Binary file — preview unavailable.", data.size);
    } else if (data.encoding === "utf8" && data.content !== null) {
      renderText(data.content, path);
    } else {
      renderUnsupported("Preview unavailable.", data.size);
    }
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") return;
    renderError("Failed to load file.");
    sheetMeta.textContent = "";
  }
}

function setToolbarPath(displayRoot: string) {
  toolbarPathEl.innerHTML = "";
  const slash = displayRoot.lastIndexOf("/");
  if (slash <= 0 || slash === displayRoot.length - 1) {
    toolbarPathEl.textContent = displayRoot;
    return;
  }
  const parent = displayRoot.slice(0, slash + 1);
  const base = displayRoot.slice(slash + 1);
  const parentSpan = document.createElement("span");
  parentSpan.textContent = parent;
  const baseSpan = document.createElement("span");
  baseSpan.className = "basename";
  baseSpan.textContent = base;
  toolbarPathEl.append(parentSpan, baseSpan);
}

async function fetchTree(): Promise<TreeResponse | null> {
  try {
    const res = await fetch("/api/tree", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as TreeResponse;
  } catch {
    return null;
  }
}

let tree: FileTree | null = null;

async function refreshTree(): Promise<boolean> {
  const data = await fetchTree();
  if (!data || !tree) return false;
  setToolbarPath(data.displayRoot);
  tree.resetPaths(data.paths);
  tree.setGitStatus(data.gitStatus ?? []);
  return true;
}

const PULL_THRESHOLD = 70;
const PULL_MAX = 120;

let pullStartY = 0;
let pullDistance = 0;
let pullActive = false;
let refreshing = false;

function getTreeScrollTop(): number {
  const root = (treeEl as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot;
  if (!root) return 0;
  const list = root.querySelector("[data-file-tree-virtualized-list]") as HTMLElement | null;
  return list?.scrollTop ?? 0;
}

function isInSheet(target: EventTarget | null): boolean {
  let el = target as Node | null;
  while (el) {
    if (el instanceof HTMLElement && (el.id === "sheet" || el.id === "sheet-backdrop")) {
      return true;
    }
    el = el.parentNode;
  }
  return false;
}

function setPullVisual(distance: number, ready: boolean) {
  pullEl.style.opacity = String(Math.min(distance / PULL_THRESHOLD, 1));
  pullEl.style.transform = `translateY(${Math.min(distance, PULL_MAX)}px)`;
  pullEl.classList.toggle("ready", ready);
}

function resetPullVisual() {
  pullEl.style.transform = "";
  pullEl.style.opacity = "";
  pullEl.classList.remove("ready");
}

document.addEventListener(
  "touchstart",
  (e) => {
    if (refreshing) return;
    if (sheetEl.classList.contains("open")) return;
    if (isInSheet(e.target)) return;
    if (getTreeScrollTop() > 0) return;
    if (e.touches.length !== 1) return;
    pullStartY = e.touches[0]!.clientY;
    pullDistance = 0;
    pullActive = true;
  },
  { passive: true }
);

document.addEventListener(
  "touchmove",
  (e) => {
    if (!pullActive || refreshing) return;
    const dy = e.touches[0]!.clientY - pullStartY;
    if (dy <= 0) {
      pullDistance = 0;
      resetPullVisual();
      return;
    }
    if (getTreeScrollTop() > 0) {
      pullActive = false;
      resetPullVisual();
      return;
    }
    pullDistance = dy * 0.55;
    setPullVisual(pullDistance, pullDistance >= PULL_THRESHOLD);
  },
  { passive: true }
);

async function endPull() {
  if (!pullActive) return;
  pullActive = false;
  if (pullDistance >= PULL_THRESHOLD) {
    refreshing = true;
    pullEl.classList.add("refreshing");
    pullEl.style.transform = "translateY(24px)";
    pullEl.style.opacity = "1";
    pullEl.style.setProperty("--pull-y", "24px");
    const startedAt = Date.now();
    await refreshTree();
    const elapsed = Date.now() - startedAt;
    if (elapsed < 500) await new Promise((r) => setTimeout(r, 500 - elapsed));
    pullEl.classList.remove("refreshing");
    resetPullVisual();
    refreshing = false;
  } else {
    resetPullVisual();
  }
  pullDistance = 0;
}

document.addEventListener("touchend", endPull);
document.addEventListener("touchcancel", endPull);

async function bootstrap() {
  setStatus("Loading…");
  const data = await fetchTree();
  if (!data) {
    setStatus("Failed to load tree.");
    return;
  }

  setToolbarPath(data.displayRoot);

  tree = new FileTree({
    paths: data.paths,
    initialExpansion: "open",
    search: true,
    flattenEmptyDirectories: true,
    density: "relaxed",
    gitStatus: data.gitStatus ?? undefined,
  });
  treeEl.classList.add("tp-tree-host");
  tree.render({ containerWrapper: treeEl });

  treeEl.addEventListener("click", (event) => {
    for (const node of event.composedPath()) {
      if (!(node instanceof HTMLElement)) continue;
      const path = node.dataset.itemPath;
      const type = node.dataset.itemType;
      if (path && type === "file") {
        openFile(path);
        return;
      }
    }
  });

  setStatus(null);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  connectLiveSocket();
}

let liveBackoff = 500;
function connectLiveSocket() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.addEventListener("open", () => {
    liveBackoff = 500;
  });
  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data as string) as { type?: string };
      if (data.type === "changed") {
        void refreshTree();
      }
    } catch {}
  });
  ws.addEventListener("close", scheduleReconnect);
  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {}
  });
}
function scheduleReconnect() {
  setTimeout(connectLiveSocket, liveBackoff);
  liveBackoff = Math.min(liveBackoff * 2, 10_000);
}

bootstrap();
