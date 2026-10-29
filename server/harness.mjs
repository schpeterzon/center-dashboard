// hermes-opencode-harness over its documented REST contract (docs/jarvis-integration.md).
// The dashboard reads tasks, approvals, workers, models, usage, events and the inference queue,
// and can create, cancel and re-run tasks and decide approvals. Everything runs in the Harness.
import { request, baseUrl, cached, str, num, SourceError } from "./net.mjs";
import { open } from "./store.mjs";

const fast = cached(4000), slow = cached(5 * 60e3);

function target(c) {
  const url = baseUrl(c.values?.url, "Harness URL");
  let token = "";
  try { token = c.secrets?.token ? open(c.secrets.token) : ""; } catch { throw new SourceError("the saved token could not be opened"); }
  return { url, headers: token ? { authorization: `Bearer ${token}` } : {} };
}
const get = (t, path, opts) => request(`${t.url}/api/${path}`, { headers: t.headers, ...opts });

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const summary = (x) => ({
  id: str(x.id, 60), title: str(x.title || x.objective, 160), status: str(x.status, 30), ui: str(x.ui_state, 30),
  worker: str(x.worker_role || x.display?.worker, 40), model: str(x.model || x.display?.model, 120), effort: str(x.effort, 20),
  risk: str(x.risk, 12), review: str(x.review_state, 24), approvals: num(x.pending_approvals) ?? 0,
  phase: str(x.activity?.phase, 24), action: str(x.activity?.action || x.display?.current_action, 240), tool: str(x.activity?.tool, 40),
  tokens: num(x.usage?.total_tokens) ?? 0, cost: num(x.usage?.cost), elapsed: num(x.elapsed_ms),
  error: x.error ? str(x.error.message || x.error.code, 240) : "", created: x.created_at, started: x.started_at, completed: x.completed_at,
  verified: x.result?.verification?.status || null, parent: x.parent_id || null,
});
const approval = (a) => ({
  id: str(a.id, 60), task: str(a.task_id, 60), kind: str(a.kind, 20), permission: str(a.permission, 40), risk: str(a.risk, 12),
  categories: (a.categories || []).slice(0, 8).map((c) => str(c, 30)), patterns: (a.patterns || []).slice(0, 4).map((p) => str(p, 300)),
  description: str(a.description, 400), created: a.created_at,
});
const event = (e) => ({ seq: num(e.seq), at: e.timestamp, type: str(e.type, 60), task: e.task_id, worker: str(e.worker, 40), model: str(e.model, 120), text: eventText(e) });
function eventText(e) {
  const p = e.payload || {};
  switch (e.type) {
    case "task.created": return `created · ${str(p.title, 120)}`;
    case "task.status_changed": return `${p.from} → ${p.to}`;
    case "task.completed": return `completed${p.verification ? " · " + str(p.verification.status || p.verification, 20) : ""}`;
    case "task.failed": return `failed · ${str(p.error?.message || p.error?.code || p.code, 160)}`;
    case "tool.started": return `${str(p.tool || "tool", 30)} · ${str(p.input?.command || p.title || p.action, 160)}`;
    case "tool.completed": return `${str(p.tool || "tool", 30)} done`;
    case "permission.requested": return `asks: ${str(p.description || p.permission, 160)}`;
    case "permission.resolved": return `approval ${str(p.decision || p.status, 30)}`;
    case "review.started": return "review started";
    case "review.completed": return `review ${str(p.status || p.verdict, 30)}`;
    case "inference.queue_waited": return `waited ${num(p.wait_seconds ?? p.elapsed_seconds)?.toFixed(1) ?? "?"} s for the GPU`;
    default: return str(e.type.replace(/\./g, " "), 60);
  }
}

export async function harnessSnapshot(c, fresh) {
  const t = target(c);
  return fast(c.id, async () => {
    const status = await get(t, "status");
    const last = num(status.events?.last_seq) ?? 0;
    const [tasks, approvals, usage, workers, events] = await Promise.all([
      get(t, "tasks?roots_only=1&limit=60"), get(t, "approvals?status=pending&limit=50"), get(t, "usage"), get(t, "workers"),
      get(t, `events?after=${Math.max(0, last - 60)}&limit=60`),
    ]);
    const [models, hourly] = await slow(c.id, async () => Promise.all([
      get(t, "models").then((m) => (m.models || []).slice(0, 400).map((x) => ({ id: str(x.id, 160), name: str(x.name, 120), provider: str(x.provider_name || x.provider, 60), billing: str(x.billing_hint, 20), context: num(x.context), preferred: !!x.preferred }))).catch(() => []),
      get(t, `usage/hourly?since=${new Date(Date.now() - 30 * 864e5).toISOString()}`).then((h) => (h.hours || []).slice(-5000).map((r) => ({ hour: r.hour, provider: str(r.provider, 60), model: str(r.model, 120), tokens: (num(r.input_tokens) ?? 0) + (num(r.output_tokens) ?? 0) + (num(r.reasoning_tokens) ?? 0), cost: num(r.cost) ?? 0, tasks: num(r.tasks) ?? 0 }))).catch(() => []),
    ]), fresh);
    const q = status.inference_queue || {};
    return {
      version: str(status.harness?.version, 20), uptime: num(status.harness?.uptime_s), executing: num(status.harness?.executing), slots: num(status.harness?.max_concurrent_tasks),
      opencode: { connected: !!status.opencode?.connected, version: str(status.opencode?.version, 30), error: str(status.opencode?.last_error, 200) },
      ui: str(status.ui_state, 30), counts: status.tasks?.counts || {}, total: num(status.tasks?.total) ?? 0,
      queue: { state: str(q.state, 20), age: num(q.age_seconds), active: q.snapshot ? !!q.snapshot.active : null, queued: num(q.snapshot?.queued), max: num(q.snapshot?.max_queue), oldest: num(q.snapshot?.oldest_wait_seconds), admitted: num(q.snapshot?.admitted) },
      lastFinished: status.last_finished ? { id: status.last_finished.task_id, title: str(status.last_finished.title, 160), status: str(status.last_finished.status, 20), at: status.last_finished.completed_at } : null,
      workspace: { dir: str(status.workspace?.default_directory, 300), allowed: (status.workspace?.allowed_directories || []).slice(0, 12).map((d) => str(d, 300)) },
      usage: { tokens: num(usage.totals?.total_tokens) ?? 0, cost: num(usage.totals?.cost), messages: num(usage.totals?.messages) ?? 0,
        byModel: (usage.by_model || []).slice(0, 40).map((m) => ({ provider: str(m.provider, 60), model: str(m.model, 120), tokens: num(m.total_tokens) ?? 0, cost: num(m.cost), messages: num(m.messages) ?? 0 })) },
      workers: (workers.workers || []).slice(0, 30).map((w) => ({ name: str(w.name, 40), description: str(w.description, 200), maxRisk: str(w.max_risk, 12), models: (w.preferred_models || []).slice(0, 6).map((m) => str(m, 120)) })),
      tasks: (tasks.tasks || []).map(summary),
      active: (status.tasks?.active || []).map(summary),
      approvals: (approvals.approvals || []).map(approval),
      events: (events.events || []).slice(-60).reverse().map(event),
      models, hourly,
    };
  }, fresh);
}

const RISKS = new Set(["low", "medium", "high", "critical"]);
export async function harnessAction(c, action, body = {}) {
  const t = target(c), post = (path, b) => request(`${t.url}/api/${path}`, { method: "POST", headers: t.headers, body: b, timeout: 15000 });
  const id = (v) => { if (!/^[a-z]+_[0-9a-z]{6,40}$/i.test(String(v || ""))) throw new SourceError("invalid id"); return v; };
  if (action === "create") {
    const objective = str(body.objective, 8000).trim();
    if (!objective) throw new SourceError("Describe the task first.");
    const task = { objective, title: str(body.title || objective.split("\n")[0], 120), run: body.run !== false, metadata: { requested_by: "center-dashboard" } };
    if (body.worker) task.worker_role = str(body.worker, 40);
    if (RISKS.has(body.risk)) task.risk = body.risk;
    if (body.directory) task.working_directory = str(body.directory, 500);
    if (body.model) task.model = str(body.model, 160);
    const r = await post("tasks", task);
    return { id: r.task_id, status: r.status };
  }
  if (action === "decide") {
    const decision = ["approve", "approve_always", "reject"].includes(body.decision) ? body.decision : null;
    if (!decision) throw new SourceError("Unknown decision.");
    const r = await post(`approvals/${id(body.id)}`, { decision, ...(body.message ? { message: str(body.message, 2000) } : {}) });
    return { status: r.status, task: r.task_id };
  }
  if (action === "cancel") return post(`tasks/${id(body.id)}/cancel`, { reason: "cancelled from the dashboard" }).then((r) => ({ status: r.status }));
  if (action === "run") return post(`tasks/${id(body.id)}/run`, {}).then((r) => ({ status: r.status }));
  if (action === "detail") {
    const r = await request(`${t.url}/api/tasks/${id(body.id)}?include_events=1&events_limit=40`, { headers: t.headers });
    const x = r.task || {};
    return { ...summary(x), objective: str(x.objective, 4000), summaryText: str(x.result?.summary, 1200), reasons: (x.result?.verification?.reasons || []).slice(0, 10).map((s) => str(s, 300)),
      files: (x.result?.files_changed || []).slice(0, 40).map((f) => ({ path: str(f.path, 300), status: str(f.status, 20) })), events: (r.events || []).map(event).reverse() };
  }
  throw new SourceError("Unknown action.");
}
export const harnessDone = (s) => TERMINAL.has(s);

// ---------------------------------------------------------------- questions from JARVIS
// The terminal chat hands questions about the machines to a Harness agent: a read-only
// investigation, waited on in slices, answered with the agent's last message. A task that stops
// for an approval is reported as such; the owner decides it like any other.
export async function harnessAsk(c, question, { worker, signal, onStatus = () => {} } = {}) {
  const t = target(c), call = (path, b, timeout = 15000) => request(`${t.url}/api/${path}`, { method: b ? "POST" : "GET", headers: t.headers, body: b, timeout });
  const objective = [
    "Answer the owner's question about their own machines and services.",
    "Investigate read-only: look, list, inspect and read. Do not install, change, restart, delete or write anything; if answering would need a change, say so instead.",
    "Reply in plain text, short and concrete: which machine or VM, what runs there, and exactly how to use it (host, port, command, where credentials live, without printing secrets).",
    "", "Question: " + str(question, 4000),
  ].join("\n");
  const r = await call("tasks", { objective, title: str("Ask: " + question.replace(/\s+/g, " "), 120), worker_role: worker || "researcher", risk: "low", run: true, metadata: { requested_by: "center-dashboard-chat" } });
  const id = r.task_id;
  onStatus(`${id} started · ${worker || "researcher"}`);
  const until = Date.now() + 8 * 60e3;
  let task = r.task || {};
  while (!TERMINAL.has(task.status) && Date.now() < until) {
    if (signal?.aborted) return { id, status: "left running", text: "The user stopped waiting; the task keeps running in the Harness." };
    if (task.status === "waiting_approval") {
      const ap = await call(`approvals?status=pending&limit=50`).catch(() => ({}));
      const mine = (ap.approvals || []).filter((x) => x.task_id === id).map((x) => `${x.id}: ${str(x.description, 300)}`);
      return { id, status: "waiting for approval", text: `The task is paused until the owner approves: ${mine.join("; ") || "see the Agents page"}. They can approve it there or type "approve <id>" in the terminal; the answer then appears on the task.` };
    }
    const w = await call(`tasks/${id}/wait`, { timeout_seconds: 45, until: "settled" }, 60000).catch((e) => ({ error: e }));
    if (w.error) { if (Date.now() >= until) break; await new Promise((res) => setTimeout(res, 3000)); continue; }
    task = w.task || task;
    if (task.activity?.action) onStatus(`${id} · ${str(task.activity.action, 120)}`);
  }
  if (!TERMINAL.has(task.status)) return { id, status: str(task.status, 30) || "running", text: "Still working after 8 minutes; the answer will be on the task (Agents page)." };
  const ev = await call(`tasks/${id}/events?types=assistant.message&limit=500`).catch(() => ({}));
  const last = (ev.events || []).map((e) => e.payload?.text).filter(Boolean).pop();
  return { id, status: task.status, text: str(last || task.result?.summary || (task.error ? "failed: " + (task.error.message || task.error.code) : "no answer"), 8000) };
}

// ---------------------------------------------------------------- live events
// One WebSocket per Harness (GET /events, harness.events.v1) with the bearer token in the handshake,
// so the token never goes into a URL. Each relevant event drops the cached snapshot and tells the
// board to read it again; the 15 s poll stays as the fallback. Reconnects resume after the last seq.
const QUIET = /^(assistant\.(delta|thinking)|session\.)/;
export function harnessStream(getConn, onEvent) {
  let ws = null, key = "", lastSeq = 0, delay = 1000, retry = 0, stopped = false, connected = false;
  const close = () => { clearTimeout(retry); if (ws) { ws.onclose = ws.onerror = ws.onmessage = null; try { ws.close(); } catch {} } ws = null; connected = false; };
  function connect() {
    if (stopped || typeof WebSocket !== "function") return;
    const c = getConn();
    let t;
    try { t = c && target(c); } catch { t = null; }
    const k = t ? c.id + t.url + (t.headers.authorization || "") : "";
    if (k !== key) { key = k; lastSeq = 0; }
    if (!t) return;
    const url = `${t.url.replace(/^http/, "ws")}/events${lastSeq ? `?after=${lastSeq}` : ""}`;
    try { ws = new WebSocket(url, { headers: t.headers }); } catch { return later(); }
    ws.onopen = () => { connected = true; delay = 1000; };
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      // A fresh database (or a different Harness) starts counting again.
      if (msg.kind === "hello") {
        if (!lastSeq || (num(msg.last_seq) ?? 0) < lastSeq) lastSeq = num(msg.last_seq) ?? 0;
        // Whatever happened while we were away, the board reads the Harness again.
        fast.drop(c.id);
        return onEvent({ type: "harness.connected", task: null });
      }
      if (msg.kind !== "event" || !msg.event?.type) return;
      const e = msg.event, seq = num(e.seq) ?? 0;
      if (seq > 0) { if (seq <= lastSeq) return; lastSeq = seq; }
      if (QUIET.test(e.type)) return;
      fast.drop(c.id);
      onEvent({ type: str(e.type, 60), task: e.task_id ? str(e.task_id, 60) : null });
    };
    ws.onerror = () => {};
    ws.onclose = () => { ws = null; connected = false; later(); };
  }
  function later() { clearTimeout(retry); retry = setTimeout(connect, delay); retry.unref?.(); delay = Math.min(delay * 2, 15e3); }
  connect();
  return {
    // Called when connections change: reconnect only if the Harness, its URL or token changed.
    refresh() { const c = getConn(); let k = ""; try { const t = c && target(c); k = t ? c.id + t.url + (t.headers.authorization || "") : ""; } catch {} if (k !== key || (!ws && k)) { close(); delay = 1000; connect(); } },
    get connected() { return connected; },
    stop() { stopped = true; close(); },
  };
}
