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
