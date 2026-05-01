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
  for (const line of lines) {
    const span = document.createElement("span");
    span.className = "line";
    span.textContent = line || "​";
    code.appendChild(span);
  }
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

async function bootstrap() {
  setStatus("Loading…");
  let data: TreeResponse;
  try {
    const res = await fetch("/api/tree");
    if (!res.ok) {
      setStatus(`Error ${res.status}`);
      return;
    }
    data = await res.json();
  } catch {
    setStatus("Failed to load tree.");
    return;
  }

  setToolbarPath(data.displayRoot);

  const tree = new FileTree({
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
}

bootstrap();
