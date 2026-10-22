// Connections: stored, tested and, for AI providers, used to answer. One catalog drives all of it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { AI_PROVIDERS, INTEGRATIONS } from "../src/catalog.mjs";
import { CLI_PRESETS } from "./cli-presets.mjs";
import { state, persist, seal, open, dataDir } from "./store.mjs";
import { httpError } from "./auth.mjs";

const CATALOG = { ai: Object.fromEntries(AI_PROVIDERS.map((p) => [p.id, p])), data: Object.fromEntries(INTEGRATIONS.map((p) => [p.id, p])) };
const ANTHROPIC_VERSION = "2026-10-21";
const sandbox = path.join(dataDir, "cli-sandbox");
fs.mkdirSync(sandbox, { recursive: true, mode: 0o700 });

export const entryOf = (c) => CATALOG[c.kind]?.[c.type];

// What the browser may see: everything except secrets, which only show as "saved".
export const publicConn = (c) => ({ id: c.id, kind: c.kind, type: c.type, name: c.name, values: c.values, secrets: Object.fromEntries(Object.keys(c.secrets || {}).map((k) => [k, true])), created: c.created });

function clean(entry, values = {}, previous) {
  const out = { values: {}, secrets: { ...(previous?.secrets || {}) } };
  for (const f of entry.fields) {
    let v = values[f.k];
    if (v == null) v = "";
    if (typeof v !== "string") throw httpError(400, `${f.label} must be text.`);
    v = v.trim();
    if (v.length > 4000) throw httpError(400, `${f.label} is too long.`);
    if (f.secret) {
      if (v) out.secrets[f.k] = seal(v);
    } else if (v) out.values[f.k] = v;
    else if (f.def) out.values[f.k] = f.def;
  }
  for (const f of entry.fields) {
    const has = f.secret ? out.secrets[f.k] : out.values[f.k];
    if (!has && !f.opt && f.k !== "model") throw httpError(400, `${f.label} is required.`);
  }
  for (const k of ["url", "baseUrl"]) if (out.values[k] && !/^https?:\/\/[^\s]+$/i.test(out.values[k])) throw httpError(400, `${k === "url" ? "URL" : "Base URL"} must start with http:// or https://`);
  return out;
}

export function saveConnection(body, id) {
  const kind = body.kind === "ai" ? "ai" : "data", entry = CATALOG[kind][body.type];
  if (!entry) throw httpError(400, "Unknown connection type.");
  if (entry.available === false) throw httpError(409, entry.unavailableReason || "This provider is not available.");
  const prev = id ? state.connections.find((c) => c.id === id) : null;
  if (id && !prev) throw httpError(404, "No such connection.");
  const { values, secrets } = clean(entry, body.values, prev);
  const name = String(body.name || entry.name).trim().slice(0, 60) || entry.name;
  const c = prev || { id: crypto.randomBytes(6).toString("hex"), kind, type: body.type, created: Date.now() };
  Object.assign(c, { name, values, secrets });
  if (!prev) state.connections.push(c);
  persist();
  return c;
}
export function removeConnection(id) {
  const n = state.connections.length;
  state.connections = state.connections.filter((c) => c.id !== id);
  if (n === state.connections.length) throw httpError(404, "No such connection.");
  persist();
}
// A draft from the form, with stored secrets filled in where the form left them empty.
export function draft(body) {
  const kind = body.kind === "ai" ? "ai" : "data", entry = CATALOG[kind][body.type];
  if (!entry) throw httpError(400, "Unknown connection type.");
  if (entry.available === false) throw httpError(409, entry.unavailableReason || "This provider is not available.");
  const prev = body.id ? state.connections.find((c) => c.id === body.id) : null;
  const { values, secrets } = clean(entry, body.values, prev);
  return { kind, type: body.type, name: entry.name, values, secrets };
}
const secretsOf = (c) => Object.fromEntries(Object.entries(c.secrets || {}).map(([k, v]) => [k, open(v)]));
const all = (c) => ({ ...c.values, ...secretsOf(c) });

// ---- tests
export async function test(c) {
  const t0 = Date.now();
  try {
    const r = c.kind === "ai" ? await testAi(c) : await probe(c);
    return { ok: true, ms: Date.now() - t0, ...r };
  } catch (error) {
    return { ok: false, ms: Date.now() - t0, error: error.name === "TimeoutError" ? "timed out after 8 s" : error.message };
  }
}
async function probe(c) {
  const e = entryOf(c), v = all(c), p = e.probe;
  const fill = (tpl, encode) => tpl.replace(/\{(\w+)\}/g, (_, k) => {
    let val = String(v[k] ?? "").split("\n").map((s) => s.trim()).find(Boolean) || "";
    if (k === "url" || k === "baseUrl") val = val.replace(/\/+$/, "");
    return encode ? encodeURIComponent(val) : val;
  });
  // Values inside the query string are encoded; the path part is used as given.
  const [base, query] = p.url.split("?");
  const finalUrl = fill(base, false) + (query ? "?" + fill(query, true) : "");
  if (!/^https?:\/\//i.test(finalUrl)) throw new Error("not an http(s) URL");
  const headers = { accept: "application/json, text/plain, */*" };
  for (const [h, tpl] of Object.entries(p.headers || {})) {
    const keys = [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (keys.every((k) => v[k])) headers[h] = fill(tpl, false);
  }
  if (p.basic) headers.authorization = "Basic " + Buffer.from(p.basic.map((t) => fill(t, false)).join(":")).toString("base64");
  if (p.custom && v.header && v.value) headers[v.header.toLowerCase()] = v.value;
  // A configured endpoint must not be able to redirect credential-bearing probes to another host.
  const r = await fetch(finalUrl, { headers, redirect: "error", signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  if (r.status === 401 || r.status === 403) throw new Error(`HTTP ${r.status} · check the credentials`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (p.expect === "json") JSON.parse(text);
  else if (p.expect?.startsWith("text:") && !text.includes(p.expect.slice(5))) throw new Error(`unexpected response (no ${p.expect.slice(5)})`);
  return { detail: `HTTP ${r.status}` };
}
async function testAi(c) {
  const e = entryOf(c), v = all(c);
  if (e.available === false) throw new Error(e.unavailableReason || "This provider is not available.");
  if (e.adapter === "cli") {
    const out = await run(e.bin, ["--version"], "", 15000);
    return { detail: out.trim().split("\n")[0].slice(0, 80) || "installed" };
  }
  const models = await listModels(e, v);
  if (v.model && models.length && !models.includes(v.model)) return { detail: `reachable · ${models.length} models, "${v.model}" not among them`, models };
  return { detail: `reachable · ${models.length} model${models.length === 1 ? "" : "s"}`, models };
}
async function listModels(e, v) {
  if (e.adapter === "anthropic") {
    const r = await fetch(`${v.baseUrl.replace(/\/+$/, "")}/v1/models?limit=100`, { headers: { "x-api-key": v.apiKey, "anthropic-version": ANTHROPIC_VERSION }, redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(await apiError(r));
    return (await r.json()).data.map((m) => m.id);
  }
  const r = await fetch(`${v.baseUrl.replace(/\/+$/, "")}/models`, { headers: v.apiKey ? { authorization: `Bearer ${v.apiKey}` } : {}, redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(await apiError(r));
  const j = await r.json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}
async function apiError(r) {
  const text = await r.text().catch(() => "");
  let msg = text;
  try { const j = JSON.parse(text); msg = j.error?.message || j.error || j.message || text; } catch {}
  return `HTTP ${r.status}${msg ? " · " + String(msg).slice(0, 200) : ""}`;
}
function run(cmd, args, input, timeout) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: sandbox, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGTERM"); reject(new Error("timed out")); }, timeout);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(t); reject(new Error(e.code === "ENOENT" ? `"${cmd}" is not installed on the server` : e.message)); });
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(err.trim().split("\n").pop() || `exit code ${code}`)); });
    p.stdin.end(input);
  });
}

// ---- answering: every adapter yields plain text chunks.
const systemPrompt = (ctx = {}) => [
  "You are JARVIS, the assistant inside a personal home and infrastructure dashboard.",
  ctx.name ? `The user's name is ${String(ctx.name).slice(0, 40)}.` : "",
  ctx.time ? `It is ${String(ctx.time).slice(0, 80)}.` : "",
  ctx.page ? `They are looking at the ${String(ctx.page).slice(0, 30)} page; the board has: ${[].concat(ctx.pages || []).slice(0, 16).join(", ").slice(0, 300)}.` : "",
  "Some pages still show sample data and you cannot see live dashboard data or take actions from here yet; say so plainly when it matters.",
  "Answer briefly in plain text that reads well in a terminal: short paragraphs or simple lists, no tables.",
].filter(Boolean).join(" ");

export async function* answer(c, messages, ctx, signal) {
  const e = entryOf(c), v = all(c), system = systemPrompt(ctx);
  if (e.available === false) throw httpError(503, e.unavailableReason || "This provider is not available.");
  const msgs = messages.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-16).map((m) => ({ role: m.role, content: m.content.slice(0, 20000) }));
  if (!msgs.length || msgs[0].role !== "user") throw httpError(400, "The conversation must start with a question.");
  if (e.adapter === "anthropic") yield* anthropic(v, system, msgs, signal);
  else if (e.adapter === "openai") yield* openai(v, system, msgs, signal);
  else yield* cli(e, v, system, msgs, signal);
}
async function* sse(r) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const ev = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      const data = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) yield data;
    }
  }
}
async function* anthropic(v, system, messages, signal) {
  const r = await fetch(`${v.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST", signal,
    redirect: "error",
    headers: { "content-type": "application/json", "x-api-key": v.apiKey, "anthropic-version": ANTHROPIC_VERSION },
    body: JSON.stringify({ model: v.model || "claude-opus-5-5", max_tokens: 16000, stream: true, system, messages }),
  });
  if (!r.ok) throw new Error(await apiError(r));
  for await (const data of sse(r)) {
    const ev = JSON.parse(data);
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") yield ev.delta.text;
    else if (ev.type === "message_delta" && ev.delta?.stop_reason === "refusal") yield "\n[declined]";
    else if (ev.type === "error") throw new Error(ev.error?.message || "stream error");
  }
}
async function* openai(v, system, messages, signal) {
  const r = await fetch(`${v.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST", signal,
    redirect: "error",
    headers: { "content-type": "application/json", ...(v.apiKey ? { authorization: `Bearer ${v.apiKey}` } : {}) },
    body: JSON.stringify({ model: v.model, stream: true, messages: [{ role: "system", content: system }, ...messages] }),
  });
  if (!r.ok) throw new Error(await apiError(r));
  for await (const data of sse(r)) {
    if (data === "[DONE]") break;
    const ev = JSON.parse(data);
    if (ev.error) throw new Error(ev.error.message || "stream error");
    const t = ev.choices?.[0]?.delta?.content;
    if (t) yield t;
  }
}
// Subscriptions: the official CLI, signed in by the owner, with every tool switched off.
async function* cli(e, v, system, messages, signal) {
  if (e.available === false) throw httpError(503, e.unavailableReason || "This provider is not available.");
  const cmd = e.bin;
  const prompt = `${system}\n\n${messages.map((m) => `${m.role === "user" ? "User" : "JARVIS"}: ${m.content}`).join("\n\n")}\n\nJARVIS:`.slice(-120000);
  const p = spawn(cmd, CLI_PRESETS[e.preset](v.model), { cwd: sandbox, stdio: ["pipe", "pipe", "pipe"] });
  const kill = () => p.kill("SIGTERM");
  signal?.addEventListener("abort", kill);
  const timer = setTimeout(kill, 5 * 60e3);
  let err = "", spawnError = null;
  p.on("error", (x) => (spawnError = x));
  p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
  p.stdin.end(prompt);
  const closed = new Promise((res) => p.on("close", res));
  let streamed = false, buf = "";
  try {
    for await (const chunk of p.stdout) {
      if (e.preset !== "claude") { yield chunk.toString(); continue; }
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") { streamed = true; yield ev.event.delta.text; }
        else if (ev.type === "assistant" && !streamed) for (const b of ev.message?.content || []) if (b.type === "text") yield b.text;
        else if (ev.type === "result" && ev.is_error) throw new Error(String(ev.result || ev.error || "the CLI reported an error").slice(0, 300));
      }
    }
    const code = await closed;
    if (spawnError) throw new Error(spawnError.code === "ENOENT" ? `"${cmd}" is not installed on the server` : spawnError.message);
    if (code !== 0 && !signal?.aborted) throw new Error(err.trim().split("\n").pop()?.slice(0, 300) || `${cmd} exited with ${code}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
    if (p.exitCode === null) kill();
  }
}
