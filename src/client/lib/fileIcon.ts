const FILE_TYPE_COLORS: Record<string, string> = {
  ts: "#3178c6",
  tsx: "#3178c6",
  cts: "#3178c6",
  mts: "#3178c6",
  js: "#d4a017",
  jsx: "#d4a017",
  cjs: "#d4a017",
  mjs: "#d4a017",
  json: "#a16207",
  jsonc: "#a16207",
  html: "#dd4b25",
  htm: "#dd4b25",
  css: "#7c3aed",
  scss: "#c026d3",
  sass: "#c026d3",
  md: "#475569",
  markdown: "#475569",
  mdx: "#475569",
  yaml: "#b91c1c",
  yml: "#b91c1c",
  toml: "#9c4221",
  py: "#3572a5",
  go: "#0891b2",
  rs: "#b45309",
  java: "#b91c1c",
  rb: "#dc2626",
  php: "#7c3aed",
  sh: "#16a34a",
  bash: "#16a34a",
  zsh: "#16a34a",
  sql: "#0369a1",
  xml: "#dd4b25",
  svg: "#f97316",
  png: "#10b981",
  jpg: "#10b981",
  jpeg: "#10b981",
  gif: "#10b981",
  webp: "#10b981",
  ico: "#10b981",
  bmp: "#10b981",
  avif: "#10b981",
  pdf: "#dc2626",
  zip: "#71717a",
  tar: "#71717a",
  gz: "#71717a",
  lock: "#475569",
  env: "#475569",
  gitignore: "#475569",
  dockerfile: "#0ea5e9",
};

export function fileIconLabel(name: string): { ext: string; color: string } {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) {
    return { ext: "DOCK", color: FILE_TYPE_COLORS.dockerfile! };
  }
  if (lower === "package.json") return { ext: "PKG", color: FILE_TYPE_COLORS.json! };
  if (lower === "tsconfig.json") return { ext: "TS", color: FILE_TYPE_COLORS.ts! };
  if (lower.startsWith(".env")) return { ext: "ENV", color: FILE_TYPE_COLORS.env! };
  if (lower === ".gitignore") return { ext: "GIT", color: FILE_TYPE_COLORS.gitignore! };
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return { ext: "·", color: "#94a3b8" };
  const ext = lower.slice(dot + 1);
  const color = FILE_TYPE_COLORS[ext] ?? "#94a3b8";
  return { ext: ext.slice(0, 4).toUpperCase(), color };
}
