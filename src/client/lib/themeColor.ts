type RGB = [number, number, number];

function parseHex(hex: string): RGB {
  const h = hex.trim().replace(/^#/, "");
  const v = h.length === 3
    ? h.split("").map((c) => c + c).join("")
    : h.padEnd(6, "0").slice(0, 6);
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: RGB): string {
  return (
    "#" +
    [r, g, b]
      .map((c) => {
        const v = Math.max(0, Math.min(255, Math.round(c)));
        return v.toString(16).padStart(2, "0");
      })
      .join("")
  );
}

let raf: number | null = null;
let metaEl: HTMLMetaElement | null = null;

function getMeta(): HTMLMetaElement | null {
  if (typeof document === "undefined") return null;
  if (metaEl && document.head.contains(metaEl)) return metaEl;
  metaEl = document.querySelector('meta[name="theme-color"]');
  return metaEl;
}

export function setThemeColor(hex: string, durationMs = 240): void {
  const meta = getMeta();
  if (!meta) return;
  const current = meta.getAttribute("content") ?? "#ffffff";
  if (current.toLowerCase() === hex.toLowerCase() && raf === null) return;
  const from = parseHex(current);
  const to = parseHex(hex);
  if (raf !== null) {
    cancelAnimationFrame(raf);
    raf = null;
  }
  if (durationMs <= 0) {
    meta.setAttribute("content", toHex(to));
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / durationMs);
    // easeInOutCubic — matches the cubic-bezier(0.32, 0.72, 0, 1) feel closely enough
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const cur: RGB = [
      from[0] + (to[0] - from[0]) * eased,
      from[1] + (to[1] - from[1]) * eased,
      from[2] + (to[2] - from[2]) * eased,
    ];
    meta.setAttribute("content", toHex(cur));
    if (t < 1) {
      raf = requestAnimationFrame(step);
    } else {
      raf = null;
    }
  };
  raf = requestAnimationFrame(step);
}
