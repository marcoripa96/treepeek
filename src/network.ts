import { networkInterfaces } from "node:os";

export function getTailscaleIPv4(): string | null {
  const ifaces = networkInterfaces();
  const ts = ifaces["tailscale0"];
  if (!ts) return null;
  for (const addr of ts) {
    if (addr.family === "IPv4" && !addr.internal) return addr.address;
  }
  return null;
}

export function getLanIPv4(): string | null {
  const ifaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (name === "lo" || name === "tailscale0" || !addrs) continue;
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}
