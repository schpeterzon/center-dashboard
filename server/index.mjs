// JARVIS dashboard server. Zero dependencies: Node 20.11+ only.
//
//   npm start                      build, then serve on http://127.0.0.1:8790
//   node server/index.mjs reset    forget the password (and sign everyone out); prints a new setup code
//
// Nothing personal is served before sign-in: unauthenticated visitors only ever get the neutral
// login page. See SECURITY.md for the threat model and the Cloudflare setup.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { state, persist, flush } from "./store.mjs";
import * as auth from "./auth.mjs";
import { saveConnection, removeConnection, publicConn, draft, test, answer, entryOf, optedIn } from "./connect.mjs";
import { hardwareMetrics, invalidateHardwareCache } from "./hardware.mjs";
import * as live from "./live.mjs";
import { chatTools, engines, inventory } from "./tools.mjs";
import { harnessAsk } from "./harness.mjs";
import { homeAssistantAction, homeAssistantHistory } from "./sources.mjs";
import { mail } from "./mail.mjs";
import { SourceError } from "./net.mjs";

const dist = path.join(import.meta.dirname, "../dist");
const PORT = Number(process.env.PORT || 8790), HOST = process.env.HOST || "127.0.0.1";
const VERSION = (() => { try { return fs.readFileSync(path.join(dist, "version.txt"), "utf8").trim(); } catch { return "dev"; } })();

if (process.argv[2] === "reset") {
  auth.resetOwner();
  flush();
  console.log("Password removed and all sessions signed out. Start the server to get a new setup code.");
  process.exit(0);
}

// Pages are read once; their inline scripts are allowed by hash, so no other script can run.
function page(file) {
  // The meta tag tells the page it came from this server, so it never falls back to the sample demo.
  const html = fs.readFileSync(path.join(dist, file), "utf8").replace("<head>", '<head><meta name="jarvis-server" content="1">');
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash("sha256").update(m[1]).digest("base64")}'`);
  const csp = [
    "default-src 'none'", `script-src ${hashes.join(" ")}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src data:",
    "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'", "manifest-src 'self'",
  ].join("; ");
  // Compressed once: the page is ~650 KB of inlined code and fonts, about a quarter of that compressed.
  return { html, csp, br: zlib.brotliCompressSync(html, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }), gz: zlib.gzipSync(html, { level: 9 }) };
}
// Sends a body compressed when the browser accepts it (pages, and the large live snapshot).
function sendPacked(req, res, status, body, type, packed = {}) {
  const accept = String(req.headers["accept-encoding"] || ""), buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const enc = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
  const out = enc === "br" ? packed.br || zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }) : enc === "gzip" ? packed.gz || zlib.gzipSync(buf, { level: 6 }) : buf;
  res.writeHead(status, { "content-type": type, vary: "accept-encoding", ...(enc ? { "content-encoding": enc } : {}) });
  res.end(out);
}
let pages;
try {
  pages = { app: page("index.html"), login: page("login.html") };
} catch {
  console.error("dist/ is missing. Run `npm run build` first, or use `npm start`.");
  process.exit(1);
}

function headers(req, res, extra = {}) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("cache-control", "no-store");
  if (auth.isHttps(req)) res.setHeader("strict-transport-security", "max-age=31536000");
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}
const send = (res, status, body, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const json = (res, status, body) => send(res, status, body);
async function readBody(req, limit = 512 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw auth.httpError(413, "Request too large.");
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw auth.httpError(400, "Expected a JSON object.");
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Who is asking: a valid session, or (with JARVIS_AUTH=access) a valid Cloudflare Access identity.
async function identify(req) {
  const access = await auth.verifyAccess(req);
  if (auth.ACCESS && !access) return { blocked: true };
  if (auth.MODE === "access") return { access, user: access };
  const session = auth.currentSession(req);
  return { access, session, user: session ? { owner: true } : null };
}

const SETTINGS_KEYS = ["profile", "appearance", "layout", "jarvis", "ai"];
let statusCache = { at: 0, list: [] };
const pendingTotp = new Map(); // session hash -> secret, kept in memory only until confirmed

async function api(req, res, url, who) {
  const p = url.pathname.slice(5), m = req.method;
  const ip = auth.clientIp(req);

  // ---- public: just enough to sign in, nothing about the owner
  if (p === "auth/state" && m === "GET")
    return json(res, 200, { authed: !!who.user, setup: auth.MODE === "password" && !state.owner, totp: !!state.owner?.totp });
  if (p === "auth/setup" && m === "POST") {
    if (auth.lockedFor(ip)) return json(res, 429, { error: `Too many attempts. Try again in ${auth.lockedFor(ip)} s.` });
    const b = await readBody(req, 4096);
    try {
      auth.finishSetup(b.token, b.password);
    } catch (e) {
      if (e.status === 403) auth.recordMiss(ip);
      throw e;
    }
    auth.clearMisses(ip);
    console.log(`setup completed from ${ip}`);
    auth.startSession(req, res);
    return json(res, 200, { ok: true });
  }
  if (p === "auth/login" && m === "POST") {
    if (auth.MODE !== "password" || !state.owner) return json(res, 409, { error: "Sign-in is not available." });
    const wait = auth.lockedFor(ip);
    if (wait) return json(res, 429, { error: `Too many attempts. Try again in ${wait} s.` });
    const b = await readBody(req, 4096);
    await sleep(250 + Math.random() * 250);
    if (!auth.checkPassword(String(b.password || ""), state.owner.hash)) {
      auth.recordMiss(ip);
      console.log(`failed sign-in from ${ip}`);
      return json(res, 401, { error: "That password is not right." });
    }
    const secret = auth.ownerTotp();
    if (secret) {
      if (!b.code) return json(res, 401, { error: "Enter the code from your authenticator.", totp: true });
      const step = auth.checkTotp(secret, b.code, state.owner.totpStep || 0);
      if (!step) {
        auth.recordMiss(ip);
        return json(res, 401, { error: "That code is not right.", totp: true });
      }
      state.owner.totpStep = step;
      persist();
    }
    auth.clearMisses(ip);
    auth.startSession(req, res);
    console.log(`signed in from ${ip}`);
    return json(res, 200, { ok: true });
  }

  // ---- everything below needs a signed-in owner
  if (!who.user) return json(res, 401, { error: "Sign in first." });

  if (p === "session" && m === "GET")
    return json(res, 200, {
      jarvis: true, version: VERSION, auth: auth.MODE === "access" ? `Cloudflare Access · ${who.user.email}` : "password",
      settings: state.settings, connections: state.connections.map(publicConn), optIn: optedIn(),
      security: { mode: auth.MODE === "access" ? "Cloudflare Access" : auth.ACCESS ? "password + Cloudflare Access" : "password", https: auth.isHttps(req), proxy: auth.proxyName(req), access: auth.ACCESS, totp: !!state.owner?.totp, local: auth.isLocal(req) },
    });
  if (p === "settings" && m === "PUT") {
    const b = await readBody(req);
    state.settings = Object.fromEntries(SETTINGS_KEYS.filter((k) => b[k] && typeof b[k] === "object").map((k) => [k, b[k]]));
    persist();
    return json(res, 200, { ok: true });
  }
  if (p === "auth/logout" && m === "POST") {
    auth.endSession(req, res);
    return json(res, 200, { ok: true });
  }
  if (p === "auth/sessions" && m === "GET")
    return json(res, 200, { sessions: state.sessions.filter((s) => s.exp > Date.now()).map((s) => ({ created: s.created, seen: s.seen, agent: s.agent, ip: s.ip, current: s === who.session })) });
  if (p === "auth/sessions" && m === "DELETE") return json(res, 200, { revoked: auth.revokeOthers(who.session) });
  if (p === "auth/password" && m === "POST") {
    if (auth.MODE !== "password") return json(res, 409, { error: "Sign-in is handled by Cloudflare Access." });
    const b = await readBody(req, 4096);
    if (!auth.checkPassword(String(b.current || ""), state.owner.hash)) { auth.recordMiss(ip); return json(res, 403, { error: "The current password is not right." }); }
    const problem = auth.passwordProblem(b.password);
    if (problem) return json(res, 400, { error: problem });
    state.owner.hash = auth.hashPassword(b.password);
    auth.revokeOthers(who.session);
    persist();
    return json(res, 200, { ok: true });
  }
  if (p === "auth/totp/setup" && m === "POST") {
    if (auth.MODE !== "password") return json(res, 409, { error: "Sign-in is handled by Cloudflare Access." });
    const secret = auth.newTotpSecret();
    pendingTotp.set(who.session.h, secret);
    return json(res, 200, { secret, uri: auth.totpUri(secret) });
  }
  if (p === "auth/totp/enable" && m === "POST") {
    const b = await readBody(req, 1024), secret = who.session && pendingTotp.get(who.session.h);
    if (!secret) return json(res, 409, { error: "Start the setup again." });
    if (!auth.checkTotp(secret, b.code)) return json(res, 400, { error: "That code is not right — check the time on your phone." });
    pendingTotp.delete(who.session.h);
    auth.setOwnerTotp(secret);
    return json(res, 200, { ok: true });
  }
  if (p === "auth/totp/disable" && m === "POST") {
    const b = await readBody(req, 4096);
    if (!auth.checkPassword(String(b.password || ""), state.owner.hash)) { auth.recordMiss(ip); return json(res, 403, { error: "The password is not right." }); }
    auth.setOwnerTotp(null);
    return json(res, 200, { ok: true });
  }

  if (p === "connections" && m === "GET") return json(res, 200, { connections: state.connections.map(publicConn) });
  if (p === "connections" && m === "POST") { const c = saveConnection(await readBody(req)); statusCache.at = 0; invalidateHardwareCache(); live.refreshStream(); return json(res, 200, { connection: publicConn(c) }); }
  if (p === "connections/test" && m === "POST") return json(res, 200, await test(draft(await readBody(req))));
  const cm = /^connections\/([0-9a-f]{12})$/.exec(p);
  if (cm && m === "PUT") { const c = saveConnection(await readBody(req), cm[1]); statusCache.at = 0; invalidateHardwareCache(); live.refreshStream(); return json(res, 200, { connection: publicConn(c) }); }
  if (cm && m === "DELETE") { removeConnection(cm[1]); statusCache.at = 0; invalidateHardwareCache(); live.refreshStream(); return json(res, 200, { ok: true }); }

  if (p === "hardware" && m === "GET") return json(res, 200, await hardwareMetrics());

  // ---- terminal conversations, so "/resume" finds them on any device
  if (p === "chats" && m === "GET") return json(res, 200, { chats: (state.chats || []).slice().sort((x, y) => y.updated - x.updated).map(({ id, title, kind, updated, messages }) => ({ id, title, kind, updated, count: messages.filter((x) => x.role === "user").length })) });
  const chm = /^chats\/([a-z0-9-]{4,60})$/i.exec(p);
  if (chm && m === "GET") { const ch = (state.chats || []).find((x) => x.id === chm[1]); return ch ? json(res, 200, ch) : json(res, 404, { error: "That conversation is gone." }); }
  if (chm && m === "PUT") {
    const b = await readBody(req, 2 * 1024 * 1024), list = (state.chats ||= []);
    const messages = (Array.isArray(b.messages) ? b.messages : []).filter((x) => ["user", "assistant", "note", "tool"].includes(x?.role) && typeof x.content === "string").slice(-150).map((x) => ({ role: x.role, content: x.content.slice(0, 20000) }));
    const ch = list.find((x) => x.id === chm[1]) || { id: chm[1], created: Date.now() };
    Object.assign(ch, { engine: typeof b.engine === "string" ? b.engine.slice(0, 220) : "", via: typeof b.via === "string" ? b.via.slice(0, 220) : "", viaLabel: typeof b.viaLabel === "string" ? b.viaLabel.slice(0, 160) : "", title: String(b.title || "").replace(/\s+/g, " ").trim().slice(0, 100) || "Conversation", kind: b.kind === "task" ? "task" : "chat", messages, updated: Date.now() });
    if (!list.includes(ch)) list.push(ch);
    // The newest 60 conversations are kept.
    if (list.length > 60) state.chats = list.sort((x, y) => y.updated - x.updated).slice(0, 60);
    persist();
    return json(res, 200, { id: ch.id, updated: ch.updated });
  }
  if (chm && m === "DELETE") { state.chats = (state.chats || []).filter((x) => x.id !== chm[1]); persist(); return json(res, 200, { ok: true }); }

  // ---- live data and the actions the board can take
  if (p === "live" && m === "GET") return sendPacked(req, res, 200, await live.snapshot(url.searchParams.has("fresh")), "application/json; charset=utf-8");
  // Server-sent events: "change" whenever the Harness reports something, so the board updates at once.
  if (p === "stream" && m === "GET") {
    if (live.listenerCount() >= 50) return json(res, 503, { error: "Too many open boards." });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" });
    const alive = () => !who.session || state.sessions.includes(who.session);
    const send = (ev, o) => { if (!alive()) return res.end(); res.write(`event: ${ev}\ndata: ${JSON.stringify(o)}\n\n`); };
    send("hello", live.streamState());
    const off = live.onChange((e) => send("change", e));
    const beat = setInterval(() => send("state", live.streamState()), 25e3);
    // Reconnecting now and then signs the stream in again (EventSource does it on its own).
    const stop = setTimeout(() => res.end(), 30 * 60e3);
    res.on("close", () => { off(); clearInterval(beat); clearTimeout(stop); });
    return;
  }
  const lm = /^live\/(harness|home|local|ai|mail)\/([a-z]+)(?:\/([a-z]+))?$/.exec(p);
  if (lm && (m === "POST" || (m === "GET" && lm[2] === "history"))) {
    const b = m === "POST" ? await readBody(req, 64 * 1024) : {};
    try {
      if (lm[1] === "harness") {
        const all = state.connections.filter((x) => x.kind === "data" && x.type === "harness");
        if (!all.length) return json(res, 409, { error: "Connect a Harness in Settings → Connections first." });
        // Approvals and tasks from the chat may live on another Harness than the board's first one.
        let r = null, err = null;
        for (const c of lm[2] === "decide" || lm[2] === "detail" || lm[2] === "cancel" || lm[2] === "run" ? all : all.slice(0, 1)) {
          try { r = await live.harnessAction(c, lm[2], b); err = null; break; } catch (e) { err = e; if (!/HTTP 404/.test(e.message)) break; }
        }
        if (err) throw err;
        live.addLog(`Harness · ${lm[2]}${b.decision ? " " + b.decision : ""}${r.id ? " " + r.id : ""}`);
        return json(res, 200, r);
      }
      if (lm[1] === "home") {
        const c = live.pick("home-assistant");
        if (!c) return json(res, 409, { error: "Connect Home Assistant in Settings → Connections first." });
        if (lm[2] === "history") return json(res, 200, { series: await homeAssistantHistory(c, String(url.searchParams.get("ids") || "").split(","), url.searchParams.get("days")) });
        return json(res, 200, await homeAssistantAction(c, b));
      }
      // Read the mailbox again now and wait for it, so the next snapshot has new and deleted mail.
      if (lm[1] === "mail" && lm[2] === "refresh") {
        const c = live.pick("email");
        if (!c) return json(res, 409, { error: "Connect your mailbox in Settings → Connections first." });
        const r = await mail(c, true);
        return json(res, 200, { unseen: r.unseen, checked: r.checked });
      }
      if (lm[1] === "local") return json(res, 200, live.localAction(lm[2], lm[3], b));
      if (lm[1] === "ai" && lm[2] === "brief") { const text = await live.complete("Write my brief for right now: what is on, what needs me, anything worth knowing. 4–7 short lines, most important first. No greeting line.", { name: state.settings?.profile?.name }); state.brief = { at: Date.now(), text }; persist(); return json(res, 200, { brief: state.brief }); }
      if (lm[1] === "ai" && lm[2] === "review") { live.localAction("automations", "run", { id: (state.automations || []).find((a) => a.kind === "review" && a.scope === (b.scope === "weekly" ? "weekly" : "daily"))?.id }); return json(res, 202, { started: true }); }
    } catch (e) {
      // 422, not 502: Cloudflare swaps a 502 for its own error page, and the reason would be lost.
      return json(res, e instanceof SourceError ? 422 : 400, { error: e.message });
    }
    return json(res, 404, { error: "Not found." });
  }

  if (p === "status" && m === "GET") {
    if (url.searchParams.has("fresh") || Date.now() - statusCache.at > 60e3) {
      const list = await Promise.all(state.connections.map(async (c) => ({ id: c.id, type: c.type, kind: c.kind, name: c.name, entry: entryOf(c), r: await test(c) })));
      statusCache = { at: Date.now(), list: list.map(({ id, type, kind, name, entry, r }) => ({ id, type, kind, name, kind2: entry?.name, ok: r.ok, ms: r.ms, error: r.error, detail: r.detail })) };
    }
    return json(res, 200, { checked: statusCache.at, connections: statusCache.list.map((c) => ({ ...c, kind: `${c.kind2 || c.type}${c.detail ? " · " + c.detail : ""}` })) });
  }

  if (p === "ai/chat" && m === "POST") {
    const b = await readBody(req);
    const c = state.connections.find((x) => x.id === b.connection && x.kind === "ai");
    if (!c) return json(res, 404, { error: "That AI connection does not exist any more." });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" });
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const emit = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    try {
      const ctx = { ...(b.context && typeof b.context === "object" ? b.context : {}), live: await live.liveContext().catch(() => "") };
      // Comments keep the stream alive through proxies while a tool works for minutes.
      const beat = setInterval(() => res.write(": working\n\n"), 20e3);
      res.on("close", () => clearInterval(beat));
      const tools = await chatTools({ auto: b.auto === true, engine: typeof b.engine === "string" ? b.engine.slice(0, 220) : "", chatModel: c.values?.model }).catch(() => null);
      ctx.auto = b.auto === true;
      for await (const t of answer(c, Array.isArray(b.messages) ? b.messages : [], ctx, ac.signal, tools)) emit(typeof t === "string" ? { t: "text", v: t } : { t: "status", v: t.status });
      emit({ t: "done" });
    } catch (e) {
      // A rate-limited or exhausted API key: offer to answer through a Harness on a subscription instead.
      if (!ac.signal.aborted && /rate limit|quota|429|insufficient/i.test(e.message)) {
        const alt = (await engines(c.values?.model).catch(() => [])).filter((x) => /subscription/.test(x.label)).map(({ id, label }) => ({ id, label }));
        if (alt.length) emit({ t: "fallback", v: alt });
      }
      if (!ac.signal.aborted) emit({ t: "error", v: e.message });
    }
    return res.end();
  }

  // Which Harnesses and models can answer the terminal (Settings → AI → Routing).
  if (p === "ai/engines" && m === "GET") {
    const chatModel = state.connections.find((x) => x.kind === "ai")?.values?.model;
    return json(res, 200, { engines: (await engines(chatModel).catch(() => [])).map(({ id, label }) => ({ id, label })) });
  }

  // The same conversation answered by a Harness agent (for example on a ChatGPT subscription
  // when the API key is rate-limited). Streams like ai/chat: status lines, then the answer.
  if (p === "ai/harness" && m === "POST") {
    const b = await readBody(req);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" });
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const emit = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const beat = setInterval(() => res.write(": working\n\n"), 20e3);
    res.on("close", () => clearInterval(beat));
    try {
      const engineId = typeof b.engine === "string" ? b.engine.slice(0, 220) : "";
      const eng = (await engines().catch(() => [])).find((x) => x.id === engineId);
      if (!eng) throw new Error("That Harness is not connected any more; pick another in Settings → AI.");
      const msgs = (Array.isArray(b.messages) ? b.messages : []).filter((x) => (x?.role === "user" || x?.role === "assistant") && typeof x.content === "string").slice(-8);
      const last = msgs.at(-1);
      if (!last || last.role !== "user") throw new Error("Ask something first.");
      const earlier = msgs.slice(0, -1).map((x) => `${x.role === "user" ? "Owner" : "JARVIS"}: ${x.content.slice(0, 2500)}`).join("\n\n");
      const question = `${earlier ? "Conversation so far:\n" + earlier + "\n\n" : ""}The owner's message:\n${last.content.slice(0, 6000)}`;
      // In auto mode a request to do something becomes a job; anything else is answered with the
      // board's data. A job never carries mail or headline text, which must not steer changes.
      const change = b.auto === true && /\b(install|fix|restart|reboot|deploy|update|upgrade|create|set ?up|configure|enable|disable|start|stop|remove|delete|add|change|move|rename|clean ?up|run)\b/i.test(last.content);
      const snap = await live.snapshot(false, 8000).catch(() => ({ sources: {} }));
      let context = await live.liveContext().catch(() => "");
      if (change) context = "";
      emit({ t: "status", v: `${eng.conn.name} · ${change ? "job" : "answering"}${context ? " with your board's data" : ""}` });
      const r = await harnessAsk(eng.conn, question, { model: eng.model, change, chat: true, context, auto: b.auto === true, inventory: inventory(snap.sources), signal: ac.signal, onStatus: (v) => emit({ t: "status", v: `${eng.conn.name} · ${v}` }) });
      emit({ t: "status", v: `${r.id} · ${r.status}` });
      emit({ t: "text", v: r.text });
      emit({ t: "done" });
    } catch (e) {
      if (!ac.signal.aborted) emit({ t: "error", v: e.message });
    }
    return res.end();
  }
  return json(res, 404, { error: "Not found." });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/healthz") { headers(req, res); return send(res, 200, "ok", "text/plain"); }
    if (url.pathname === "/robots.txt") { headers(req, res); return send(res, 200, "User-agent: *\nDisallow: /\n", "text/plain"); }
    const who = await identify(req);
    // Behind Cloudflare Access, anything without a valid Access token gets nothing at all.
    if (who.blocked) { headers(req, res); return send(res, 403, "Forbidden", "text/plain"); }

    if (url.pathname.startsWith("/api/")) {
      headers(req, res);
      if (req.method !== "GET") {
        // Cross-site requests cannot set this header without a CORS preflight, which never succeeds.
        if (req.headers["x-jarvis"] !== "1") return json(res, 403, { error: "Missing request header." });
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: "Cross-origin request refused." });
      }
      return await api(req, res, url, who);
    }
    if (req.method !== "GET" && req.method !== "HEAD") { headers(req, res); return send(res, 405, "Method not allowed", "text/plain"); }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (!who.user) { headers(req, res); res.writeHead(302, { location: "/login" }); return res.end(); }
      headers(req, res, { "content-security-policy": pages.app.csp });
      return sendPacked(req, res, 200, pages.app.html, "text/html; charset=utf-8", pages.app);
    }
    if (url.pathname === "/login") {
      if (who.user) { headers(req, res); res.writeHead(302, { location: "/" }); return res.end(); }
      headers(req, res, { "content-security-policy": pages.login.csp });
      return sendPacked(req, res, 200, pages.login.html, "text/html; charset=utf-8", pages.login);
    }
    headers(req, res);
    return send(res, 404, "Not found", "text/plain");
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : "Something went wrong.", ...(e.extra || {}) });
    else res.end();
    if (!e.status) console.error(e);
  }
});
server.requestTimeout = 10 * 60e3;
server.headersTimeout = 20e3;

auth.initOwner();
live.startScheduler();
live.startStream();
setInterval(() => live.watchHarness(), 60e3).unref();
server.listen(PORT, HOST, () => {
  console.log(`JARVIS ${VERSION} · http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} · sign-in: ${auth.MODE}${auth.ACCESS ? " + Cloudflare Access" : ""}`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1" && !auth.ACCESS) console.log("Listening beyond localhost: put it behind HTTPS (for example a Cloudflare Tunnel) before exposing it.");
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { flush(); server.close(); process.exit(0); });
