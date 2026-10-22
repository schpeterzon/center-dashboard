// End-to-end checks for the server: sign-in, secrets at rest, request guards and AI streaming.
// Runs against a temporary data directory and a fake OpenAI-compatible model server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_PRESETS } from "../server/cli-presets.mjs";

const root = path.join(import.meta.dirname, "..");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-test-"));
const PORT = 18000 + Math.floor(Math.random() * 1000), B = `http://127.0.0.1:${PORT}`;
let server, model, setupCode, cookie = "";
let redirectSeen = null;
const redirectSink = http.createServer((req, res) => { redirectSeen = req.headers.authorization || req.headers["x-api-key"] || null; res.end("unexpected redirect request"); });

// A stand-in for Ollama / LM Studio / any OpenAI-compatible server.
const fakeModel = http.createServer((req, res) => {
  if (req.url?.includes("/redirect/")) return res.writeHead(302, { location: `http://127.0.0.1:${redirectSink.address().port}/capture` }).end();
  if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "tiny" }, { id: "big" }] }));
  if (req.url === "/v1/chat/completions") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const t of ["Hello", ", ", "world"]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
    return res.end("data: [DONE]\n\n");
  }
  res.writeHead(404).end();
});

const call = async (p, { method = "GET", body, headers = {}, raw } = {}) => {
  const r = await fetch(B + p, { method, redirect: "manual", headers: { "x-jarvis": "1", cookie, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body && JSON.stringify(body) });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  if (raw) return r;
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};

test("Claude subscription preset has no tool execution surface", () => {
  const args = CLI_PRESETS.claude("sonnet");
  assert.ok(args.includes("--bare"));
  assert.ok(args.includes("--tools"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(args.includes("--disallowedTools"));
  assert.equal(args[args.indexOf("--disallowedTools") + 1], "*");
  assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
});

before(async () => {
  await new Promise((r) => redirectSink.listen(0, "127.0.0.1", r));
  await new Promise((r) => fakeModel.listen(0, "127.0.0.1", r));
  model = `http://127.0.0.1:${fakeModel.address().port}/v1`;
  server = spawn(process.execPath, [path.join(root, "server/index.mjs")], { env: { ...process.env, JARVIS_DATA: data, PORT: String(PORT), JARVIS_PASSWORD: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (d) => { log += d; if (log.includes("sign-in:")) resolve(); });
    server.on("exit", (c) => reject(new Error("server exited " + c + log)));
  });
  setupCode = fs.readFileSync(path.join(data, "setup-code"), "utf8").trim();
});
after(() => { server?.kill(); fakeModel.close(); redirectSink.close(); fs.rmSync(data, { recursive: true, force: true }); });

test("nothing personal before sign-in", async () => {
  const r = await call("/", { raw: true });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/login");
  const login = await call("/login", { raw: true });
  const html = await login.text();
  assert.equal(login.status, 200);
  assert.match(login.headers.get("content-security-policy"), /script-src 'sha256-/);
  assert.equal(login.headers.get("x-frame-options"), "DENY");
  assert.match(login.headers.get("x-robots-tag"), /noindex/);
  assert.doesNotMatch(html, /data-id="home"|JarvisOrbModule/);
  assert.equal((await call("/api/session")).status, 401);
  assert.equal((await call("/api/connections")).status, 401);
  assert.deepEqual((await call("/api/auth/state")).body, { authed: false, setup: true, totp: false });
});

test("setup needs the code from the server", async () => {
  assert.equal((await call("/api/auth/setup", { method: "POST", body: { token: "WRONG-CODE-0000", password: "correct horse battery" } })).status, 403);
  assert.equal((await call("/api/auth/setup", { method: "POST", body: { token: setupCode, password: "short" } })).status, 400);
  const ok = await call("/api/auth/setup", { method: "POST", body: { token: setupCode.toLowerCase().replace(/-/g, " "), password: "correct horse battery" } });
  assert.equal(ok.status, 200);
  assert.match(cookie, /^jarvis=/);
  assert.equal(fs.existsSync(path.join(data, "setup-code")), false);
  const again = await call("/api/auth/setup", { method: "POST", body: { token: setupCode, password: "another password!" } });
  assert.equal(again.status, 409);
});

test("signed in: app page with a strict CSP", async () => {
  const r = await call("/", { raw: true });
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  const s = await call("/api/session");
  assert.equal(s.body.jarvis, true);
});

test("state-changing requests need the JARVIS header and the same origin", async () => {
  assert.equal((await call("/api/settings", { method: "PUT", body: {}, headers: { "x-jarvis": "" } })).status, 403);
  assert.equal((await call("/api/settings", { method: "PUT", body: {}, headers: { origin: "https://evil.example" } })).status, 403);
  const ok = await call("/api/settings", { method: "PUT", body: { profile: { name: "Ada" }, junk: { x: 1 } } });
  assert.equal(ok.status, 200);
  const s = await call("/api/session");
  assert.deepEqual(s.body.settings, { profile: { name: "Ada" } });
});

test("secrets are encrypted at rest and never returned", async () => {
  const c = await call("/api/connections", { method: "POST", body: { kind: "ai", type: "compatible", name: "Fake", values: { baseUrl: model, model: "tiny", apiKey: "sk-test-SECRET-123" } } });
  assert.equal(c.status, 200);
  assert.deepEqual(c.body.connection.secrets, { apiKey: true });
  assert.equal(JSON.stringify(c.body).includes("SECRET-123"), false);
  await new Promise((r) => setTimeout(r, 120));
  const disk = fs.readFileSync(path.join(data, "state.json"), "utf8");
  assert.equal(disk.includes("SECRET-123"), false);
  assert.equal(disk.includes("correct horse"), false);
  assert.equal((fs.statSync(path.join(data, "state.json")).mode & 0o777).toString(8), "600");
  // Editing without re-entering the key keeps it.
  const id = c.body.connection.id;
  const e = await call(`/api/connections/${id}`, { method: "PUT", body: { kind: "ai", type: "compatible", name: "Fake 2", values: { baseUrl: model, model: "big", apiKey: "" } } });
  assert.deepEqual(e.body.connection.secrets, { apiKey: true });
  const t = await call("/api/connections/test", { method: "POST", body: { id, kind: "ai", type: "compatible", values: { baseUrl: model, model: "tiny" } } });
  assert.equal(t.body.ok, true);
  assert.deepEqual(t.body.models, ["big", "tiny"]);
});

test("model endpoint redirects cannot forward saved credentials", async () => {
  redirectSeen = null;
  const r = await call("/api/connections/test", { method: "POST", body: { kind: "ai", type: "compatible", values: { baseUrl: `${model}/redirect`, model: "tiny", apiKey: "sk-redirect-secret" } } });
  assert.equal(r.body.ok, false);
  assert.equal(redirectSeen, null);
});

test("CLI connections use a fixed executable and unsafe subscription CLIs fail closed", async () => {
  const r = await call("/api/connections", { method: "POST", body: { kind: "ai", type: "claude-code", values: { command: "/bin/sh" } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.connection.values.command, undefined);
  await call(`/api/connections/${r.body.connection.id}`, { method: "DELETE" });
  const codex = await call("/api/connections", { method: "POST", body: { kind: "ai", type: "codex", values: { model: "tiny", command: "/tmp/codex" } } });
  assert.equal(codex.status, 409);
  assert.match(codex.body.error, /built-in tools/i);
  const gemini = await call("/api/connections/test", { method: "POST", body: { kind: "ai", type: "gemini-cli", values: { model: "tiny" } } });
  assert.equal(gemini.status, 409);
  assert.match(gemini.body.error, /tool access/i);
});

test("AI answers stream through the server", async () => {
  const id = (await call("/api/connections")).body.connections.find((c) => c.kind === "ai").id;
  const r = await call("/api/ai/chat", { method: "POST", raw: true, body: { connection: id, messages: [{ role: "user", content: "hi" }] } });
  const text = await r.text();
  const parts = [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]));
  assert.equal(parts.filter((p) => p.t === "text").map((p) => p.v).join(""), "Hello, world");
  assert.equal(parts.at(-1).t, "done");
});

test("status checks every connection", async () => {
  const s = await call("/api/status?fresh=1");
  assert.equal(s.body.connections.length, 1);
  assert.equal(s.body.connections[0].ok, true);
});

test("sign-in is rate limited and sessions can be revoked", async () => {
  const mine = cookie;
  cookie = "";
  for (let i = 0; i < 5; i++) assert.equal((await call("/api/auth/login", { method: "POST", body: { password: "nope nope nope" } })).status, 401);
  const locked = await call("/api/auth/login", { method: "POST", body: { password: "correct horse battery" } });
  assert.equal(locked.status, 429);
  cookie = mine;
  assert.equal((await call("/api/session")).status, 200);
  await call("/api/auth/logout", { method: "POST" });
  assert.equal((await call("/api/session")).status, 401);
});
