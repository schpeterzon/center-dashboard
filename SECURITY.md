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
   to `http://127.0.0.1:8790` (or the `jarvis` container). See `docker-compose.yml`.
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
JARVIS invokes the fixed `claude` executable with `--safe-mode --strict-mcp-config` (no CLAUDE.md,
skills, plugins, hooks, MCP servers or settings files), offers it no tools, denies every tool name,
disables slash commands and permission prompts, and runs it in an empty working directory. The
browser cannot select a different executable. API and local model requests carry no tool definitions.

The ChatGPT subscription runs through Codex CLI, which cannot switch its shell tool off. It is
therefore **off unless you start the server with `JARVIS_ALLOW_TOOL_CLIS=1`**. Then it runs with a
read-only sandbox (no writes, no network for commands), web search, browser use, computer use and
apps disabled, no approvals, no rules and no saved session, in an empty directory, and untrusted
headlines are left out of its prompt. It can still read files the server user can read; run the
server as a dedicated user (the NixOS module does by default) if that matters to you. Gemini CLI stays
unavailable until it can be locked down the same way.

## What JARVIS may do

JARVIS sees a plain-text summary of your live data when you ask it something. It cannot act:
suggested actions (a todo, a Harness task, an approval, opening a page) appear as buttons and run only
when you click them. Headlines, calendar titles and other third-party text are marked untrusted in
the prompt. Home Assistant actions are limited to toggling lights, switches, fans, covers and media
players, activating scenes, locking or unlocking a lock with an explicit button, and setting a
thermostat between 5 and 35 °C. Harness ids and decisions are validated before they are sent.
Automations (brief, reviews, Harness tasks, AI prompts) run on the server at the times you set; agent
work itself always runs in the Harness, under its own policy and approvals.

Mail is read-only: the mailbox is opened with IMAP `EXAMINE`, only the From, Subject and Date
headers of the newest 25 messages are fetched, and nothing is marked, moved, deleted or sent. IMAP
always uses TLS, except to a bridge on this machine (127.0.0.1) on a port other than 993. Mail
subjects are untrusted text in the AI prompt and are left out entirely for the Codex preset. A
self-signed certificate (Proxmox) is accepted only when its SHA-256 fingerprint matches the one you
saved, checked before any request is sent. A Custom HTTP check with a secret header does not
follow redirects.

## Reporting a problem

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather than
a public issue.
