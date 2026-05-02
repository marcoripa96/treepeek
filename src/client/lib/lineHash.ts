export interface LineRange {
  start: number;
  end: number;
}

const HASH_RE = /^#L(\d+)(?:-L?(\d+))?$/;

export function parseLineHash(hash: string): LineRange | null {
  const m = HASH_RE.exec(hash);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < 1) {
    return null;
  }
  return end < start ? { start: end, end: start } : { start, end };
}

export function formatLineHash(range: LineRange | null): string {
  if (!range) return "";
  if (range.start === range.end) return `#L${range.start}`;
  return `#L${range.start}-L${range.end}`;
}

export function setHashSilently(hash: string) {
  const u = new URL(location.href);
  u.hash = hash;
  history.replaceState(null, "", u.toString());
}
