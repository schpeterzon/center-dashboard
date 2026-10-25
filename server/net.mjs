// Small, defensive HTTP helpers for live sources: a timeout on every call, a cap on every body,
// no credentials in URLs, and errors that are safe to show in the dashboard.
const MAX_BODY = 4 * 1024 * 1024;

export class SourceError extends Error {}

export function baseUrl(value, label = "URL") {
  let u;
  try { u = new URL(String(value || "").trim()); } catch { throw new SourceError(`${label} is not a valid URL.`); }
  if (!/^https?:$/.test(u.protocol)) throw new SourceError(`${label} must start with http:// or https://.`);
  if (u.username || u.password) throw new SourceError(`${label} must not contain credentials.`);
  return u.href.replace(/\/+$/, "");
}

async function bounded(res, limit) {
  if (!res.body) return "";
  const reader = res.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new SourceError("response too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString("utf8");
}

export async function request(url, { method = "GET", headers = {}, body, timeout = 8000, limit = MAX_BODY, expect = "json" } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method, redirect: "follow", signal: AbortSignal.timeout(timeout),
      headers: { accept: expect === "json" ? "application/json" : "*/*", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new SourceError(e.name === "TimeoutError" || e.name === "AbortError" ? `no answer within ${Math.round(timeout / 1000)} s` : "not reachable");
  }
  const text = await bounded(res, limit);
  if (res.status === 401 || res.status === 403) throw new SourceError(`HTTP ${res.status} · check the credentials`);
  if (!res.ok) {
    let msg = "";
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || (typeof j.error === "string" ? j.error : ""); } catch {}
    throw new SourceError(`HTTP ${res.status}${msg ? " · " + String(msg).slice(0, 160) : ""}`);
  }
  if (expect !== "json") return text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new SourceError("answered with something that is not JSON"); }
}

// One cached value per key, with in-flight de-duplication, so many open dashboards cost one fetch.
export function cached(ttl) {
  const entries = new Map();
  return (key, load, fresh = false) => {
    const e = entries.get(key), now = Date.now();
    if (!fresh && e?.value && now - e.at < ttl) return Promise.resolve(e.value);
    if (e?.pending) return e.pending;
    const pending = Promise.resolve().then(load).then(
      (value) => { entries.set(key, { at: Date.now(), value }); return value; },
      (error) => { entries.delete(key); throw error; },
    );
    entries.set(key, { ...e, pending });
    return pending;
  };
}

export const str = (v, n = 200) => (v == null ? "" : String(v)).slice(0, n);
export const num = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
