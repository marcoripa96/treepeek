import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TOKEN_DIR = join(homedir(), ".config", "treepeek");
const TOKEN_FILE = join(TOKEN_DIR, "token");
const COOKIE_NAME = "tp_session";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export async function loadOrCreateToken(opts: { rotate?: boolean; override?: string } = {}): Promise<string> {
  if (opts.override) return opts.override;
  if (!opts.rotate) {
    try {
      const existing = (await readFile(TOKEN_FILE, "utf8")).trim();
      if (existing.length >= 32) return existing;
    } catch {}
  }
  const fresh = randomBytes(24).toString("base64url");
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_FILE, fresh, { mode: 0o600 });
  return fresh;
}

export function buildCookieHeader(token: string): string {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ].join("; ");
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isAuthenticated(req: Request, token: string): boolean {
  const url = new URL(req.url);
  const queryToken = url.searchParams.get("k");
  if (queryToken && tokenMatches(queryToken, token)) return true;
  const cookieToken = readCookie(req, COOKIE_NAME);
  return tokenMatches(cookieToken, token);
}
