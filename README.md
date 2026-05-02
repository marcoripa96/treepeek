# treepeek

Single-binary Rust server that exposes the current directory as a mobile-first installable PWA file browser. Runs over your Tailscale tailnet and is protected by a token URL.

Built on top of [`@pierre/trees`](https://trees.software/).

## Build

Requires Rust (stable) and [Bun](https://bun.sh) (build-time only — bundles the React client).

```bash
bun install
bun run build
```

The build script bundles the React client with Bun, then runs `cargo build --release` and copies the binary to `./treepeek`.

Optionally drop it on your `$PATH`:

```bash
sudo install -m 0755 ./treepeek /usr/local/bin/treepeek
```

## Use

From any folder:

```bash
treepeek
```

It walks the current directory, picks your `tailscale0` IP automatically, prints the share URL plus an ASCII QR code, and waits.

```
  treepeek  my-project
  bind:     100.79.3.50:7777  (tailscale0)

  open on your phone:
    http://100.79.3.50:7777/?k=k7n…

  ▄▄▄▄▄▄▄ ▄▄ ▄ ▄▄▄▄▄▄▄
  …
```

Open the URL on your phone. On first visit the token is verified and a long-lived cookie is set; from then on `https://…/` works without the `?k=` query.

Tap **Add to Home Screen** to install it as a PWA.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `-p, --port <n>` | `7777` | Port to listen on |
| `-b, --bind <ip>` | tailscale0 IP, else `0.0.0.0` | Address to bind |
| `--all` | off | Include `node_modules` / `.git` / `dist` etc. |
| `--token <s>` | persisted | Use a specific token |
| `--rotate-token` | off | Force a fresh token (invalidates existing PWA installs) |
| `--no-qr` | off | Don't print the QR code |

## How auth works

- On first run, a 24-byte random token is generated and persisted in `~/.config/treepeek/token` (mode 0600).
- `?k=<token>` sets a `HttpOnly`, `SameSite=Lax`, 1-year cookie and redirects to `/`.
- All routes except the icon and manifest require either the cookie or `?k=<token>`.
- Token is constant-time-compared.
- `--rotate-token` invalidates everything; the user has to scan the new URL.

The token file is the secret; lose it = lose access until rotated.

## What it shows

- Full-screen file tree powered by `@pierre/trees`. Built-in search.
- Tap a file → bottom sheet slides up with the content (text or image).
- 2 MB cap for text, 5 MB cap for images. Larger / binary files are flagged.
- Default ignores: `node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `.cache`, `coverage`, `.svelte-kit`, `.nuxt`, `.vercel`, `.output`, `.parcel-cache`, `out`, `.idea`, `.vscode`, `__pycache__`, `.venv`, `venv`, `target`. Override with `--all`.

## Notes on PWA + HTTPS

Service workers (offline shell) require a secure context. Over plain Tailscale HTTP, "Add to Home Screen" still works on iOS Safari and Android Chrome — you just won't get offline caching.

If you want full PWA over HTTPS, put `tailscale serve` in front:

```bash
tailscale serve --https=443 --bg http://localhost:7777
```

Then visit `https://<your-host>.<tailnet>.ts.net/?k=<token>` from your phone.

## Dev

```bash
bun install
bun run build:client          # rebuild only the client bundle into dist/
bun run dev -- --port 7777    # run the server via cargo (reads dist/ at compile time)
```

Server source lives in `server/` (Rust); client source in `src/client/` (React).
