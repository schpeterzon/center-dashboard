// End-to-end checks for the live board: every source adapter, the actions the board can take,
// and the parsers. Uses tools/fixtures.mjs and a fake Harness that follows its REST contract.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFixtures } from "./fixtures.mjs";
import { parseIcs } from "../server/calendar.mjs";
import { parseFeed, parseHoldings } from "../server/sources.mjs";

const root = path.join(import.meta.dirname, "..");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-live-"));
const PORT = 19000 + Math.floor(Math.random() * 1000), B = `http://127.0.0.1:${PORT}`;
let server, fx, harness, hx, cookie = "";
const decisions = [], created = [];

// A Harness that answers like hermes-opencode-harness v1, with one task waiting for approval.
function fakeHarness() {
  const task = { id: "task_0abc123def", title: "Restart a service", status: "waiting_approval", ui_state: "waiting_approval", worker_role: "infrastructure", risk: "critical", activity: { phase: "waiting_approval" }, usage: { total_tokens: 1200, cost: 0.02 }, elapsed_ms: 4000, created_at: new Date().toISOString(), started_at: new Date().toISOString(), completed_at: null };
  const approval = { id: "apr_0xyz789uvw", task_id: task.id, kind: "task_start", status: "pending", permission: "task_start", patterns: [], risk: "critical", categories: [], description: "Start critical-risk task: Restart a service", created_at: new Date().toISOString() };
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname !== "/api/health" && req.headers.authorization !== "Bearer hx-token") return json({ error: { code: "UNAUTHORIZED", message: "no" } }, 401);
    let b = ""; req.on("data", (d) => (b += d)).on("end", () => {
      const body = b ? JSON.parse(b) : {};
      if (u.pathname === "/api/status") return json({ harness: { version: "0.1.0", uptime_s: 5, executing: 0, max_concurrent_tasks: 4 }, opencode: { connected: true, version: "1.19.3" }, inference_queue: { state: "available", age_seconds: 1, snapshot: { active: true, queued: 1, max_queue: 8, oldest_wait_seconds: 2.5, admitted: 20 } }, ui_state: "waiting_approval", tasks: { counts: { waiting_approval: 1, completed: 3 }, total: 4, active: [task] }, approvals: { pending: approval.status === "pending" ? 1 : 0 }, workspace: { default_directory: "/srv", allowed_directories: ["/srv"] }, events: { last_seq: 10 } });
      if (u.pathname === "/api/tasks" && req.method === "GET") return json({ tasks: [task], total: 1 });
      if (u.pathname === "/api/tasks" && req.method === "POST") { created.push(body); return json({ task_id: "task_0new000001", status: "running", task: {} }, 201); }
      if (u.pathname === "/api/approvals") return json({ approvals: approval.status === "pending" ? [approval] : [] });
      if (u.pathname === `/api/approvals/${approval.id}`) { decisions.push(body.decision); approval.status = body.decision === "reject" ? "rejected" : "approved"; return json({ approval, task_id: task.id, status: "running" }); }
      if (u.pathname === "/api/usage") return json({ totals: { total_tokens: 1200, cost: 0.02, messages: 4 }, by_model: [{ provider: "ollama", model: "qwen3.8:9b", total_tokens: 1200, cost: 0, messages: 4 }] });
      if (u.pathname === "/api/workers") return json({ workers: [{ name: "infrastructure", max_risk: "critical", preferred_models: ["ollama/qwen3.8:9b"] }] });
      if (u.pathname === "/api/events") return json({ events: [{ seq: 9, timestamp: new Date().toISOString(), type: "task.created", task_id: task.id, payload: { title: task.title } }], next_after: 10, last_seq: 10 });
      if (u.pathname === "/api/models") return json({ models: [{ id: "ollama/qwen3.8:9b", provider: "ollama", name: "Qwen3.8 9B", billing_hint: "local", context: 65536 }] });
      if (u.pathname === "/api/usage/hourly") return json({ hours: [{ hour: new Date().toISOString().slice(0, 13) + ":00:00Z", provider: "ollama", model: "qwen3.8:9b", input_tokens: 800, output_tokens: 400, cost: 0, tasks: 1 }] });
      json({ error: { code: "NOT_FOUND", message: u.pathname } }, 404);
    });
  });
}

const call = async (p, { method = "GET", body } = {}) => {
  const r = await fetch(B + p, { method, headers: { "x-jarvis": "1", cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};
const connect = (type, values, kind = "data") => call("/api/connections", { method: "POST", body: { kind, type, values } });

before(async () => {
  fx = await startFixtures(0);
  hx = fakeHarness();
  await new Promise((r) => hx.listen(0, "127.0.0.1", r));
  harness = `http://127.0.0.1:${hx.address().port}`;
  server = spawn(process.execPath, [path.join(root, "server/index.mjs")], { env: { ...process.env, JARVIS_DATA: data, PORT: String(PORT), JARVIS_PASSWORD: "correct horse battery" }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { let log = ""; server.stdout.on("data", (d) => { log += d; if (log.includes("sign-in:")) resolve(); }); server.on("exit", (c) => reject(new Error("server exited " + c))); });
  assert.equal((await call("/api/auth/login", { method: "POST", body: { password: "correct horse battery" } })).status, 200);
  const f = `http://127.0.0.1:${fx.port}`;
  for (const [t, v] of [["harness", { url: harness, token: "hx-token" }], ["calendar", { url: `${f}/cal.ics` }], ["home-assistant", { url: f, token: "ha-token" }], ["uptime-kuma", { url: f, apiKey: "k" }], ["adguard", { url: f, user: "u", password: "p" }]])
    assert.equal((await connect(t, v)).status, 200, t);
});
after(() => { server?.kill(); fx?.server.close(); hx?.close(); fs.rmSync(data, { recursive: true, force: true }); });

test("the live snapshot reads every connected source", async () => {
  const { body } = await call("/api/live?fresh=1");
  for (const k of ["harness", "calendar", "home", "uptime", "adguard"]) assert.equal(body.sources[k]?.ok, true, `${k}: ${body.sources[k]?.error}`);
  const h = body.sources.harness.data;
  assert.equal(h.approvals[0].id, "apr_0xyz789uvw");
  assert.equal(h.opencode.connected, true);
  assert.equal(h.queue.queued, 1);
  assert.equal(h.models[0].billing, "local");
  assert.ok(body.sources.calendar.data.events.some((e) => e.title === "Dentist"));
  const ha = body.sources.home.data;
  assert.deepEqual(ha.rooms.map((r) => r.name), ["Living room", "Kitchen", "Office", "Hallway"]);
  assert.equal(ha.flow.solar, 3200);
  assert.ok(!ha.consumers.some((c) => /solar|grid/i.test(c.id)), "producers are not consumers");
  assert.equal(body.sources.uptime.data.monitors.find((m) => m.name === "Backup target").state, "down");
  assert.equal(body.sources.adguard.data.blocked, 6904);
  assert.equal(body.local.automations.length, 3, "default automations are created");
});

test("approvals are decided in the Harness", async () => {
  const r = await call("/api/live/harness/decide", { method: "POST", body: { id: "apr_0xyz789uvw", decision: "approve" } });
  assert.equal(r.status, 200);
  assert.deepEqual(decisions, ["approve"]);
  assert.equal((await call("/api/live/harness/decide", { method: "POST", body: { id: "apr_0xyz789uvw", decision: "delete-everything" } })).status, 502);
  assert.equal((await call("/api/live/harness/decide", { method: "POST", body: { id: "../../etc", decision: "approve" } })).status, 502);
});

test("tasks are created in the Harness, tagged as coming from the dashboard", async () => {
  const r = await call("/api/live/harness/create", { method: "POST", body: { objective: "Check the backups", risk: "low", worker: "infrastructure" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, "task_0new000001");
  assert.equal(created[0].metadata.requested_by, "center-dashboard");
  assert.equal(created[0].risk, "low");
  assert.equal((await call("/api/live/harness/create", { method: "POST", body: { objective: "  " } })).status, 502);
});

test("Home Assistant actions are limited to safe services", async () => {
  assert.equal((await call("/api/live/home/toggle", { method: "POST", body: { action: "toggle", entity: "light.living_lamp" } })).status, 200);
  assert.equal(fx.ha.states.find((s) => s.entity_id === "light.living_lamp").state, "on");
  assert.equal((await call("/api/live/home/toggle", { method: "POST", body: { action: "toggle", entity: "lock.front_door" } })).status, 502, "locks are not toggled blindly");
  assert.equal((await call("/api/live/home/toggle", { method: "POST", body: { action: "temperature", entity: "climate.heat_pump", value: 80 } })).status, 502);
  assert.equal((await call("/api/live/home/toggle", { method: "POST", body: { action: "temperature", entity: "climate.heat_pump", value: 21.5 } })).status, 200);
  assert.equal(fx.ha.calls.at(-1).body.temperature, 21.5);
});

test("todos, ideas and automations are stored by the dashboard", async () => {
  let r = await call("/api/live/local/todos/add", { method: "POST", body: { text: "Renew domain", due: "2026-11-01" } });
  const t = r.body.todos.find((x) => x.text === "Renew domain");
  assert.equal(t.due, "2026-11-01");
  r = await call("/api/live/local/todos/toggle", { method: "POST", body: { id: t.id } });
  assert.equal(r.body.todos.find((x) => x.id === t.id).done, true);
  r = await call("/api/live/local/ideas/add", { method: "POST", body: { text: "Garden watering" } });
  assert.equal(r.body.ideas.length, 1);
  r = await call("/api/live/local/automations/save", { method: "POST", body: { name: "Nightly check", kind: "task", time: "02:30", days: [1, 2, 3], prompt: "Check backups" } });
  const a = r.body.automations.find((x) => x.name === "Nightly check");
  assert.ok(a.next > Date.now());
  assert.equal((await call("/api/live/local/automations/save", { method: "POST", body: { kind: "task", time: "25:99", days: [1], prompt: "x" } })).status, 400);
  assert.equal((await call("/api/live/local/nope/add", { method: "POST", body: {} })).status, 400);
});

test("live routes need a session", async () => {
  const mine = cookie; cookie = "";
  assert.equal((await call("/api/live")).status, 401);
  assert.equal((await call("/api/live/harness/decide", { method: "POST", body: {} })).status, 401);
  cookie = mine;
});

test("ICS: recurrence keeps local time across a DST change, and EXDATE is honoured", () => {
  const ics = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nSUMMARY:Standup\nDTSTART;TZID=Europe/Vienna:20261022T090000\nDTEND;TZID=Europe/Vienna:20261022T091500\nRRULE:FREQ=DAILY;COUNT=5\nEXDATE;TZID=Europe/Vienna:20261024T090000\nEND:VEVENT\nBEGIN:VEVENT\nUID:b\nSUMMARY:Trip\nDTSTART;VALUE=DATE:20261030\nDTEND;VALUE=DATE:20261101\nEND:VEVENT\nEND:VCALENDAR";
  const ev = parseIcs(ics, Date.UTC(2026, 9, 20), Date.UTC(2026, 10, 5));
  const local = ev.filter((e) => !e.allDay).map((e) => new Date(e.start).toLocaleTimeString("en-GB", { timeZone: "Europe/Vienna", hour: "2-digit", minute: "2-digit" }));
  assert.deepEqual(local, ["09:00", "09:00", "09:00", "09:00"]); // 22, 23, 25 (after DST), 26; 24 excluded
  assert.equal(ev.find((e) => e.allDay).title, "Trip");
});

test("feeds: RSS and Atom, entities and CDATA", () => {
  const rss = parseFeed('<rss><channel><title>Blog</title><item><title><![CDATA[NixOS &amp; you]]></title><link>https://x.test/a</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Hello&lt;/p&gt;</description></item></channel></rss>', "x");
  assert.equal(rss[0].title, "NixOS & you");
  assert.equal(rss[0].summary, "Hello");
  const atom = parseFeed('<feed><title>A</title><entry><title>Atom post</title><link href="https://x.test/b"/><updated>2026-10-19T10:00:00Z</updated></entry></feed>', "x");
  assert.equal(atom[0].link, "https://x.test/b");
  assert.deepEqual(parseHoldings("VWCE.DE 120 60% FTSE All-World\n# comment\nbad;sym 3"), [{ symbol: "VWCE.DE", qty: 120, target: 60, name: "FTSE All-World" }]);
});
