// Read-only hardware telemetry from the configured Prometheus connection.
import { state, open } from "./store.mjs";

const CACHE_MS = 15_000;
const MAX_BODY = 1024 * 1024;
let cache = { at: 0, value: null };
let pending = null;
let generation = 0;

export function invalidateHardwareCache() {
  generation++;
  cache = { at: 0, value: null };
  pending = null;
}

function empty(configured = false, error = null, connection = null) {
  return { configured, ok: false, error, connection, checked: Date.now(), machines: [] };
}

async function boundedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function query(base, token, expression) {
  const endpoint = new URL("api/v1/query", `${base.replace(/\/+$/, "")}/`);
  endpoint.searchParams.set("query", expression);
  const response = await fetch(endpoint, {
    headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Prometheus returned HTTP ${response.status}`);
  const text = await boundedText(response);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("Prometheus returned invalid JSON"); }
  if (payload.status !== "success" || !Array.isArray(payload.data?.result)) throw new Error("Prometheus query failed");
  return payload.data.result.slice(0, 256);
}

const valueOf = (row) => {
  const n = Number(row?.value?.[1]);
  return Number.isFinite(n) ? n : null;
};
const instanceOf = (row) => String(row?.metric?.instance || row?.metric?.nodename || row?.metric?.hostname || "unknown").slice(0, 180);
const round = (n) => n == null ? null : Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;

function byInstance(rows, transform = (n) => n) {
  const map = new Map();
  for (const row of rows) {
    const n = valueOf(row);
    if (n == null) continue;
    const key = instanceOf(row);
    const value = transform(n);
    map.set(key, map.has(key) ? Math.max(map.get(key), value) : value);
  }
  return map;
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  return days ? `${days} d ${hours} h` : `${hours} h ${Math.floor(seconds % 3600 / 60)} m`;
}

async function readHardware(connection) {
  const base = String(connection.values?.url || "").trim();
  let parsed;
  try { parsed = new URL(base); } catch { return empty(true, "Prometheus URL is invalid.", connection.name); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return empty(true, "Prometheus URL must be an HTTP(S) base URL without credentials or query parameters.", connection.name);
  }

  let token = "";
  try { token = connection.secrets?.token ? open(connection.secrets.token) : ""; }
  catch { return empty(true, "Saved Prometheus credentials could not be opened.", connection.name); }

  const expressions = {
    cpu: '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))',
    ram: '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
    disk: 'max by (instance) (100 * (1 - node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay|squashfs"} / node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay|squashfs"}))',
    uptime: 'max by (instance) (time() - node_boot_time_seconds)',
    name: 'node_uname_info',
    gpu: 'max by (instance) (DCGM_FI_DEV_GPU_UTIL)',
    gpuUsed: 'sum by (instance) (DCGM_FI_DEV_FB_USED)',
    gpuTotal: 'sum by (instance) (DCGM_FI_DEV_FB_TOTAL)',
  };

  try {
    const rows = Object.fromEntries(await Promise.all(Object.entries(expressions).map(async ([key, expression]) => [key, await query(base, token, expression)])));
    const metrics = {
      cpu: byInstance(rows.cpu, round),
      ram: byInstance(rows.ram, round),
      disk: byInstance(rows.disk, round),
      uptime: byInstance(rows.uptime),
      gpu: byInstance(rows.gpu, round),
      gpuUsed: byInstance(rows.gpuUsed),
      gpuTotal: byInstance(rows.gpuTotal),
    };
    const labels = new Map(rows.name.map((row) => [instanceOf(row), String(row.metric?.nodename || row.metric?.hostname || "").slice(0, 100)]));
    const keys = new Set(Object.values(metrics).flatMap((map) => [...map.keys()]));
    const machines = [...keys].slice(0, 64).map((instance) => {
      const gpuUsed = metrics.gpuUsed.get(instance), gpuTotal = metrics.gpuTotal.get(instance);
      return {
        instance,
        name: labels.get(instance) || instance,
        cpu: metrics.cpu.get(instance) ?? null,
        ram: metrics.ram.get(instance) ?? null,
        disk: metrics.disk.get(instance) ?? null,
        uptime: duration(metrics.uptime.get(instance)),
        gpu: metrics.gpu.get(instance) ?? null,
        gpuMemory: gpuUsed != null && gpuTotal > 0 ? round(gpuUsed / gpuTotal * 100) : null,
      };
    });
    if (!machines.some((machine) => machine.cpu != null || machine.ram != null || machine.disk != null || machine.uptime != null)) {
      return empty(true, "Prometheus is connected, but no node_exporter hardware metrics were found.", connection.name);
    }
    return { configured: true, ok: true, error: null, connection: connection.name, checked: Date.now(), machines };
  } catch (error) {
    const message = error.name === "TimeoutError" || error.name === "AbortError"
      ? "Prometheus did not respond within 5 seconds."
      : error.message.includes("HTTP 401") || error.message.includes("HTTP 403")
        ? "Prometheus rejected the saved credentials."
        : "Could not read hardware metrics from Prometheus.";
    return empty(true, message, connection.name);
  }
}

export async function hardwareMetrics() {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (pending) return pending;
  const connection = state.connections.find((item) => item.kind === "data" && item.type === "prometheus");
  if (!connection) {
    cache = { at: Date.now(), value: empty() };
    return cache.value;
  }
  const startedAt = generation;
  const task = readHardware(connection).then((value) => {
    if (startedAt === generation) cache = { at: Date.now(), value };
    return value;
  }).finally(() => { if (pending === task) pending = null; });
  pending = task;
  return task;
}
