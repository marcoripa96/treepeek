export interface Watcher {
  stop: () => void;
}

const DEFAULT_IGNORED_TOP = [
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
  ".svelte-kit",
  ".nuxt",
  "coverage",
  ".vercel",
  ".output",
  ".parcel-cache",
  "out",
  "target",
  "__pycache__",
];

export function startWatcher(
  root: string,
  opts: { includeAll?: boolean; debounceMs?: number; onChange: () => void }
): Watcher {
  const debounceMs = opts.debounceMs ?? 200;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function fire() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      opts.onChange();
    }, debounceMs);
  }

  const cmd = ["inotifywait", "-m", "-q", "-r", "--format", "%e|%w%f", "-e", "modify,create,delete,move,close_write"];
  if (!opts.includeAll) {
    const escaped = DEFAULT_IGNORED_TOP.map((d) => d.replace(/\./g, "\\.")).join("|");
    cmd.push("--exclude", `(^|/)(${escaped})(/|$)`);
  }
  cmd.push(root);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      console.warn(`[treepeek] inotifywait not found in PATH, live-refresh disabled`);
    } else {
      console.warn(`[treepeek] watcher unavailable: ${(err as Error).message}`);
    }
    return { stop: () => {} };
  }

  void (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) fire();
      }
    }
  })();

  void proc.exited.then((code) => {
    if (code !== 0 && code !== 143 && code !== 130) {
      console.warn(`[treepeek] watcher exited unexpectedly (code ${code})`);
    }
  });

  return {
    stop: () => {
      if (timer) clearTimeout(timer);
      try {
        proc.kill("SIGTERM");
      } catch {}
    },
  };
}
