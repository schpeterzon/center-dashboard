# Security

The dashboard is personal: it shows your calendar, machines, money and inbox, and it can hold API
keys. It is meant to be reachable from anywhere (for example through a Cloudflare Tunnel) without
anyone else seeing any of it.

## What a visitor sees

Without signing in, a visitor gets exactly two things: a neutral login page (no name, no title,
no data) and `/healthz`. Every other path returns a redirect to the login page or a plain 404.
The dashboard page itself, the settings and every API are only served to a signed-in owner. Search
engines are told not to index anything (`X-Robots-Tag`, `robots.txt`).

The public GitHub Pages build is a **static demo with sample data**. It never accepts or stores a
secret, and nothing in it is personal.

## How sign-in works

- **First run:** the server prints a one-time **setup code** (also written to `data/setup-code`).
  Only someone who can read the server's console or disk can choose the password, so a stranger
  who finds the URL before you do cannot claim it. Alternatively set `JARVIS_PASSWORD` once.
- **Password:** hashed with scrypt (N=2¹⁵, r=8, p=1, 16-byte salt). Minimum 10 characters.
- **Two-factor codes:** optional TOTP (any authenticator app), with replay protection.
- **Rate limits:** after 5 failed attempts from an address it is locked out for 1 minute, doubling
  up to an hour. After 100 failures in 10 minutes, sign-in pauses for everyone for 5 minutes.
- **Sessions:** 256-bit random tokens in an `HttpOnly`, `SameSite=Strict` cookie (`__Host-` and
  `Secure` over HTTPS). Only a SHA-256 of the token is stored. Sessions expire after 30 idle days,
  can be listed and revoked in Settings → Security, and are revoked when the password changes.
- **Recovery:** `npm run reset-password` (or `node server/index.mjs reset`) removes the password and
  all sessions; the next start prints a new setup code.

## Cloudflare

The recommended setup for access from anywhere:

1. **Cloudflare Tunnel.** No port is opened on your router; `cloudflared` connects out and forwards
   to `http://127.0.0.1:8787` (or the `jarvis` container). See `docker-compose.yml`.
2. **Cloudflare Access** in front of the hostname (Zero Trust → Access → Applications), allowing
   only your email. Then set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`: the server verifies
   Cloudflare's signed JWT on **every** request and answers `403` to anything without one, so
   even someone who reaches the origin directly gets nothing.
3. Keep the password (default), or set `JARVIS_AUTH=access` to let Access be the only sign-in
   (Google, GitHub, one-time PIN…).
4. Set `JARVIS_TRUST_PROXY=cloudflare` so the server uses the real client address for rate limits
   and knows the connection is HTTPS. Only set it when a proxy is actually in front.

## Secrets

API keys, tokens and the TOTP seed are encrypted with AES-256-GCM before they are written to
`data/state.json`. The key lives in `data/secret.key` (or `JARVIS_SECRET_KEY`); both files are
created with mode `600`. Secrets are never sent back to the browser: the Settings page only learns
that a key "is saved". Settings exports never include connections.

Back up `data/` as a whole. Without `secret.key` the stored secrets cannot be decrypted.

## Requests

- A strict Content Security Policy: `default-src 'none'`, scripts allowed **by hash** only (no
  inline or remote scripts beyond the page's own), `connect-src 'self'`, `frame-ancestors 'none'`.
- Every state-changing API call needs a custom `X-Jarvis` header (cross-site pages cannot send it
  without a CORS preflight, which is never granted) and a matching `Origin`.
- `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, COOP/CORP `same-origin`, a restrictive
  `Permissions-Policy`, HSTS over HTTPS, and `Cache-Control: no-store` everywhere.

## AI subscriptions

The Claude subscription is used through its official `claude` CLI, signed in by you on the server.
JARVIS invokes the fixed `claude` executable in bare mode, disables its built-in tools, denies all
tool names, and disables permission prompts in an empty working directory. Bare mode also skips
discovery of MCP servers, hooks, plugins, skills and project instructions. The browser cannot
select a different executable. API and local model requests are sent without tool definitions.

Codex and Gemini CLI subscriptions are currently unavailable in the dashboard. Their current
headless invocations do not provide JARVIS with a verified way to remove every tool, so the UI
hides those options, the server rejects new connections, and any old saved connection cannot be
used for chat. Remove old disabled connections in Settings → AI. They can be restored once a
supported text-only invocation can be enforced.

## Reporting a problem

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than
a public issue.
