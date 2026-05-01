export interface TunnelHandle {
  url: string;
  stop: () => Promise<void>;
  kind: "cloudflared" | "tailscale-funnel";
}

const TRYCLOUDFLARE_URL = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
const READY_TIMEOUT_MS = 60_000;

export async function startCloudflaredQuickTunnel(localUrl: string): Promise<TunnelHandle> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: ["cloudflared", "tunnel", "--no-autoupdate", "--url", localUrl],
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      throw new Error(
        "cloudflared not found in PATH. Install it (e.g. `pacman -S cloudflared` on Arch) and try again."
      );
    }
    throw err;
  }

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`cloudflared did not return a tunnel URL within ${READY_TIMEOUT_MS / 1000}s`)),
      READY_TIMEOUT_MS
    );
    let resolved = false;
    let combined = "";
    const decoder = new TextDecoder();

    async function pump(stream: ReadableStream<Uint8Array> | null) {
      if (!stream) return;
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          const chunk = decoder.decode(value, { stream: true });
          if (resolved) continue;
          combined += chunk;
          const match = combined.match(TRYCLOUDFLARE_URL);
          if (match) {
            resolved = true;
            clearTimeout(timeout);
            resolve(match[0]);
            combined = "";
          }
        }
      } catch {}
    }

    void pump(proc.stdout as ReadableStream<Uint8Array> | null);
    void pump(proc.stderr as ReadableStream<Uint8Array> | null);

    void proc.exited.then((code) => {
      if (resolved) return;
      clearTimeout(timeout);
      reject(new Error(`cloudflared exited (code ${code}) before reporting a URL`));
    });
  });

  return {
    url,
    kind: "cloudflared",
    stop: async () => {
      try {
        proc.kill("SIGTERM");
        await Promise.race([
          proc.exited,
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch {}
    },
  };
}

async function getTailscaleHostname(): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["tailscale", "status", "--json"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error("`tailscale status --json` failed");
  const data = JSON.parse(stdout) as { Self?: { DNSName?: string } };
  const dns = data.Self?.DNSName;
  if (!dns) throw new Error("Tailscale DNSName not found (is MagicDNS enabled?)");
  return dns.replace(/\.$/, "");
}

export async function startTailscaleFunnel(port: number): Promise<TunnelHandle> {
  let hostname: string;
  try {
    hostname = await getTailscaleHostname();
  } catch (err) {
    throw new Error(`Tailscale not available: ${(err as Error).message}`);
  }

  const proc = Bun.spawnSync({
    cmd: ["tailscale", "funnel", "--bg", String(port)],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!proc.success) {
    const stderr = new TextDecoder().decode(proc.stderr);
    const stdout = new TextDecoder().decode(proc.stdout);
    const msg = (stderr || stdout).trim() || "tailscale funnel failed";
    throw new Error(msg);
  }

  return {
    url: `https://${hostname}`,
    kind: "tailscale-funnel",
    stop: async () => {
      try {
        Bun.spawnSync({ cmd: ["tailscale", "funnel", "reset"] });
      } catch {}
    },
  };
}
