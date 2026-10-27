// Read-only adapters for the data connections in src/catalog.mjs. Each returns a small,
// display-ready object; anything a service does not report is left out rather than invented.
import { request, pinnedRequest, baseUrl, cached, str, num, SourceError } from "./net.mjs";
import { open, state, persist } from "./store.mjs";

const secret = (c, k) => { try { return c.secrets?.[k] ? open(c.secrets[k]) : ""; } catch { throw new SourceError("a saved secret could not be opened"); } };
const caches = { feeds: cached(15 * 60e3), weather: cached(15 * 60e3), geo: cached(24 * 3600e3), ha: cached(8000), haHistory: cached(5 * 60e3), github: cached(2 * 60e3), markets: cached(60e3), adguard: cached(60e3), tailscale: cached(2 * 60e3), prom: cached(30e3), cloudflare: cached(10 * 60e3), kuma: cached(30e3), ollama: cached(10e3), proxmox: cached(20e3), jellyfin: cached(20e3), jarvis: cached(20e3), http: cached(60e3) };

// ---------------------------------------------------------------- news feeds (RSS / Atom)
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m);
const plain = (s) => decode(decode(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const tag = (block, name) => { const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block); return m ? m[1] : ""; };
export function parseFeed(xml, source) {
  const items = [], blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) || [];
  const feedTitle = plain(tag(xml.replace(/<item\b[\s\S]*|<entry\b[\s\S]*/i, ""), "title")) || source;
  for (const b of blocks.slice(0, 60)) {
    const link = /<link\b[^>]*href="([^"]+)"/i.exec(b)?.[1] || plain(tag(b, "link"));
    const when = Date.parse(plain(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date")));
    items.push({ title: str(plain(tag(b, "title")), 200), link: /^https?:\/\//.test(link) ? str(link, 600) : "", summary: str(plain(tag(b, "description") || tag(b, "summary") || tag(b, "content")), 400), at: Number.isFinite(when) ? when : null, source: str(feedTitle, 60) });
  }
  return items.filter((i) => i.title);
}
export async function feeds(c, fresh) {
  const urls = String(c.values?.feeds || "").split(/\s+/).filter((u) => /^https?:\/\//.test(u)).slice(0, 20);
  if (!urls.length) throw new SourceError("add at least one feed URL");
  const topics = String(c.values?.topics || "").split(/[,\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 30);
  return caches.feeds(c.id, async () => {
    const results = await Promise.allSettled(urls.map((u) => request(u, { expect: "text", timeout: 10000, limit: 3 * 1024 * 1024 }).then((x) => parseFeed(x, new URL(u).hostname))));
    const failed = results.filter((r) => r.status === "rejected").length;
    const seen = new Set(), items = [];
    for (const r of results) if (r.status === "fulfilled") for (const i of r.value) { const k = i.title.toLowerCase(); if (!seen.has(k)) { seen.add(k); items.push(i); } }
    // Rank: a topic match counts for a lot while a story is fresh and fades over two weeks;
    // stories older than 30 days drop out unless there is nothing newer.
    const now = Date.now();
    for (const i of items) {
      const text = (i.title + " " + i.summary).toLowerCase(), age = i.at ? (now - i.at) / 864e5 : 3;
      i.topics = topics.filter((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
      i.score = (i.topics.length ? 2 + i.topics.length : 0) * Math.max(0, 1 - age / 14) + 2 * Math.max(0, 1 - age / 3);
      if (/^Article URL:|Comments URL:/.test(i.summary)) i.summary = "";
    }
    const recent = items.filter((i) => !i.at || now - i.at < 30 * 864e5);
    const pool = recent.length >= 5 ? recent : items;
    pool.sort((a, b) => b.score - a.score || (b.at || 0) - (a.at || 0));
    return { feeds: urls.length, failed, topics, items: pool.slice(0, 60) };
  }, fresh);
}

// ---------------------------------------------------------------- weather (Open-Meteo, no key)
const WMO = { 0: ["Clear", "☀"], 1: ["Mostly clear", "☀"], 2: ["Partly cloudy", "⛅"], 3: ["Overcast", "☁"], 45: ["Fog", "≋"], 48: ["Fog", "≋"], 51: ["Drizzle", "☂"], 53: ["Drizzle", "☂"], 55: ["Drizzle", "☂"], 61: ["Rain", "☂"], 63: ["Rain", "☂"], 65: ["Heavy rain", "☂"], 66: ["Freezing rain", "☂"], 67: ["Freezing rain", "☂"], 71: ["Snow", "❄"], 73: ["Snow", "❄"], 75: ["Heavy snow", "❄"], 77: ["Snow", "❄"], 80: ["Showers", "☂"], 81: ["Showers", "☂"], 82: ["Heavy showers", "☂"], 85: ["Snow showers", "❄"], 86: ["Snow showers", "❄"], 95: ["Thunderstorm", "ϟ"], 96: ["Thunderstorm", "ϟ"], 99: ["Thunderstorm", "ϟ"] };
export async function weather(c, fresh) {
  const place = str(c.values?.location, 100).trim();
  if (!place) throw new SourceError("set a place");
  const imperial = state.settings?.profile?.units === "imperial";
  const geo = await caches.geo(place, async () => {
    const g = await request(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(place)}`);
    const r = g?.results?.[0];
    if (!r) throw new SourceError(`no place called "${place}"`);
    return { lat: r.latitude, lon: r.longitude, name: str(r.name, 80), country: str(r.country_code, 4), tz: str(r.timezone, 60) };
  });
  return caches.weather(`${c.id}|${imperial}`, async () => {
    const q = new URLSearchParams({ latitude: geo.lat, longitude: geo.lon, timezone: geo.tz || "auto", forecast_days: "3", current: "temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m",
      hourly: "temperature_2m,precipitation_probability,weather_code", daily: "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset", ...(imperial ? { temperature_unit: "fahrenheit", wind_speed_unit: "mph" } : {}) });
    const w = await request(`https://api.open-meteo.com/v1/forecast?${q}`);
    const code = (n) => WMO[n] || ["", "☁"];
    const now = Date.now(), hours = (w.hourly?.time || []).map((t, i) => ({ t, temp: num(w.hourly.temperature_2m[i]), rain: num(w.hourly.precipitation_probability[i]), code: w.hourly.weather_code[i] }));
    // The next hour with a real chance of rain, for the glance chip.
    const nextRain = hours.find((h) => Date.parse(h.t + ":00Z") - (w.utc_offset_seconds || 0) * 1000 > now && h.rain >= 50);
    return {
      place: `${geo.name}${geo.country ? ", " + geo.country : ""}`, unit: imperial ? "°F" : "°C", tz: geo.tz,
      now: { temp: num(w.current?.temperature_2m), wind: num(w.current?.wind_speed_10m), humidity: num(w.current?.relative_humidity_2m), text: code(w.current?.weather_code)[0], icon: code(w.current?.weather_code)[1] },
      nextRain: nextRain ? nextRain.t.slice(11, 16) : null,
      days: (w.daily?.time || []).map((d, i) => ({ date: d, max: num(w.daily.temperature_2m_max[i]), min: num(w.daily.temperature_2m_min[i]), rain: num(w.daily.precipitation_probability_max[i]), text: code(w.daily.weather_code[i])[0], icon: code(w.daily.weather_code[i])[1] })),
    };
  }, fresh);
}

// ---------------------------------------------------------------- Home Assistant
const haTarget = (c) => ({ url: baseUrl(c.values?.url, "Home Assistant URL"), headers: { authorization: `Bearer ${secret(c, "token")}` } });
const AREAS_TEMPLATE = "{% set ns = namespace(out=[]) %}{% for a in areas() %}{% set ns.out = ns.out + [{'name': area_name(a), 'entities': area_entities(a)}] %}{% endfor %}{{ ns.out | tojson }}";
const SHOW = new Set(["light", "switch", "fan", "climate", "lock", "cover", "media_player", "sensor", "binary_sensor", "alarm_control_panel", "vacuum"]);
const ent = (s) => ({ id: s.entity_id, domain: s.entity_id.split(".")[0], name: str(s.attributes?.friendly_name || s.entity_id, 80), state: str(s.state, 40), unit: str(s.attributes?.unit_of_measurement, 12), cls: str(s.attributes?.device_class, 30), brightness: num(s.attributes?.brightness), target: num(s.attributes?.temperature), current: num(s.attributes?.current_temperature), updated: Date.parse(s.last_updated || s.last_changed) || null });
export async function homeAssistant(c, fresh) {
  const t = haTarget(c);
  return caches.ha(c.id, async () => {
    const [states, areas] = await Promise.all([
      request(`${t.url}/api/states`, { headers: t.headers, limit: 8 * 1024 * 1024 }),
      request(`${t.url}/api/template`, { method: "POST", headers: t.headers, body: { template: AREAS_TEMPLATE }, expect: "text" }).then((x) => JSON.parse(x)).catch(() => []),
    ]);
    const all = (states || []).filter((s) => SHOW.has(s.entity_id.split(".")[0]) || s.entity_id.startsWith("scene.")).map(ent);
    const byId = new Map(all.map((e) => [e.id, e]));
    const inArea = new Set();
    const rooms = (Array.isArray(areas) ? areas : []).slice(0, 40).map((a) => {
      const list = (a.entities || []).map((id) => byId.get(id)).filter(Boolean);
      list.forEach((e) => inArea.add(e.id));
      const temp = list.find((e) => e.domain === "sensor" && e.cls === "temperature"), hum = list.find((e) => e.domain === "sensor" && e.cls === "humidity");
      const devices = list.filter((e) => ["light", "switch", "fan", "climate", "lock", "cover", "media_player", "vacuum"].includes(e.domain)).slice(0, 12);
      return { name: str(a.name, 60), temp: temp ? num(temp.state) : null, unit: temp?.unit || "", humidity: hum ? num(hum.state) : null, devices };
    }).filter((r) => r.devices.length || r.temp != null);
    const loose = all.filter((e) => !inArea.has(e.id) && ["light", "switch", "climate", "lock", "cover"].includes(e.domain)).slice(0, 12);
    if (loose.length) rooms.push({ name: "Other", temp: null, humidity: null, devices: loose });
    const power = all.filter((e) => e.domain === "sensor" && e.cls === "power" && num(e.state) != null).map((e) => ({ ...e, watts: num(e.state) * (e.unit === "kW" ? 1000 : 1) })).sort((a, b) => b.watts - a.watts);
    const energy = all.filter((e) => e.domain === "sensor" && e.cls === "energy" && num(e.state) != null);
    const pick = (re) => power.find((e) => re.test(e.id + " " + e.name));
    const flowIds = new Set([/solar|pv|photovolt/i, /grid|netz|import/i, /battery|akku/i, /house|home|consumption|load|verbrauch/i].map((re) => pick(re)?.id).filter(Boolean));
    return {
      rooms, scenes: all.filter((e) => e.id.startsWith("scene.")).slice(0, 12).map((e) => ({ id: e.id, name: e.name })),
      climate: all.filter((e) => e.domain === "climate").slice(0, 4),
      security: all.filter((e) => e.domain === "lock" || e.domain === "alarm_control_panel" || (e.domain === "binary_sensor" && ["door", "window", "garage_door", "moisture", "smoke", "motion"].includes(e.cls))).slice(0, 14),
      lightsOn: all.filter((e) => e.domain === "light" && e.state === "on").length,
      power: power.slice(0, 12).map((e) => ({ id: e.id, name: e.name, watts: Math.round(e.watts) })),
      consumers: power.filter((e) => !flowIds.has(e.id) && e.watts > 0).slice(0, 10).map((e) => ({ id: e.id, name: e.name, watts: Math.round(e.watts) })),
      energy: energy.slice(0, 20).map((e) => ({ id: e.id, name: e.name, value: num(e.state), unit: e.unit })),
      flow: { solar: pick(/solar|pv|photovolt/i)?.watts ?? null, grid: pick(/grid|netz|import/i)?.watts ?? null, battery: pick(/battery|akku/i)?.watts ?? null, home: pick(/house|home|consumption|load|verbrauch/i)?.watts ?? null },
      batteryLevel: num(all.find((e) => e.domain === "sensor" && e.cls === "battery" && /home|house|storage|speicher|powerwall/i.test(e.id + e.name))?.state),
      notifications: all.filter((e) => e.domain === "binary_sensor" && e.cls === "problem" && e.state === "on").slice(0, 8).map((e) => e.name),
      health: healthSensors(all),
    };
  }, fresh);
}
// Health numbers phones and wearables report to Home Assistant (companion app with Health Connect,
// Fitbit, Withings, Garmin, Oura integrations), recognised by unit, device class and name.
const HEALTH = [
  ["steps", "Steps", (e) => /^steps?$/i.test(e.unit) || /(^|_)steps?($|_)|schritte/i.test(e.id)],
  ["restingHeartRate", "Resting heart rate", (e) => /bpm/i.test(e.unit) && /resting|ruhe/i.test(e.id + e.name)],
  ["heartRate", "Heart rate", (e) => /bpm/i.test(e.unit) || /heart_rate$|herzfrequenz|pulse/i.test(e.id)],
  ["hrv", "Heart rate variability", (e) => /hrv|heart_rate_variability/i.test(e.id)],
  ["sleep", "Sleep", (e) => /sleep|schlaf/i.test(e.id) && /^(h|min|s)$/i.test(e.unit)],
  ["weight", "Weight", (e) => e.cls === "weight" || (/weight|gewicht/i.test(e.id) && /^(kg|lb|lbs)$/i.test(e.unit))],
  ["calories", "Calories", (e) => /kcal/i.test(e.unit) || /calories|kalorien/i.test(e.id)],
  ["distance", "Distance", (e) => /distance|strecke/i.test(e.id) && /^(m|km|mi)$/i.test(e.unit)],
  ["oxygen", "Blood oxygen", (e) => /oxygen|spo2|sauerstoff/i.test(e.id)],
  ["floors", "Floors", (e) => /floors/i.test(e.id)],
];
function healthSensors(all) {
  const out = [], used = new Set();
  for (const [kind, label, test] of HEALTH) for (const e of all) {
    if (e.domain !== "sensor" || used.has(e.id) || num(e.state) == null || !test(e)) continue;
    used.add(e.id); out.push({ kind, label, id: e.id, name: e.name, value: num(e.state), unit: e.unit, updated: e.updated });
  }
  return out.slice(0, 24);
}

// History for up to three sensors: today for the Energy chart, up to 14 days for Health.
export async function homeAssistantHistory(c, ids, days = 1) {
  const t = haTarget(c), list = ids.filter((id) => /^sensor\.[\w]+$/.test(id)).slice(0, 3), span = Math.min(14, Math.max(1, Math.floor(num(days) || 1)));
  if (!list.length) return [];
  return caches.haHistory(`${c.id}|${list.join(",")}|${span}`, async () => {
    const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - span + 1);
    const h = await request(`${t.url}/api/history/period/${since.toISOString()}?filter_entity_id=${list.join(",")}&minimal_response&no_attributes`, { headers: t.headers, limit: 8 * 1024 * 1024 });
    return (h || []).map((rows) => ({ id: rows[0]?.entity_id, points: rows.map((r) => [Date.parse(r.last_changed || r.lu * 1000), num(r.state ?? r.s)]).filter((p) => p[1] != null).slice(-3000) }));
  });
}
const HA_ACTIONS = { toggle: ["light", "switch", "fan", "cover", "media_player"], scene: ["scene"], lock: ["lock"], unlock: ["lock"], temperature: ["climate"] };
export async function homeAssistantAction(c, body) {
  const t = haTarget(c), id = String(body.entity || "");
  if (!/^[a-z_]+\.[\w]+$/.test(id)) throw new SourceError("invalid entity");
  const domain = id.split(".")[0], allowed = HA_ACTIONS[body.action];
  if (!allowed?.includes(domain)) throw new SourceError("that action is not allowed for this entity");
  const call = (svcDomain, service, data) => request(`${t.url}/api/services/${svcDomain}/${service}`, { method: "POST", headers: t.headers, body: { entity_id: id, ...data } });
  if (body.action === "toggle") await call(domain === "cover" ? "cover" : "homeassistant", domain === "cover" ? "toggle" : "toggle", {});
  else if (body.action === "scene") await call("scene", "turn_on", {});
  else if (body.action === "lock" || body.action === "unlock") await call("lock", body.action, {});
  else if (body.action === "temperature") { const v = num(body.value); if (v == null || v < 5 || v > 35) throw new SourceError("temperature out of range"); await call("climate", "set_temperature", { temperature: v }); }
  return { ok: true };
}

// ---------------------------------------------------------------- GitHub
export async function github(c, fresh) {
  const h = { authorization: `Bearer ${secret(c, "token")}`, "x-github-api-version": "2022-11-28", "user-agent": "center-dashboard" };
  const gh = (p) => request(`https://api.github.com/${p}`, { headers: h });
  return caches.github(c.id, async () => {
    const me = await gh("user");
    const [repos, prs, notes] = await Promise.all([
      gh("user/repos?sort=pushed&per_page=10&affiliation=owner,collaborator"),
      gh(`search/issues?q=${encodeURIComponent(`is:open is:pr involves:${me.login} archived:false`)}&sort=updated&per_page=20`).catch(() => ({ items: [] })),
      gh("notifications?per_page=30").catch(() => null),
    ]);
    return {
      login: str(me.login, 60),
      repos: (repos || []).map((r) => ({ name: str(r.full_name, 120), description: str(r.description, 200), language: str(r.language, 30), pushed: r.pushed_at, url: str(r.html_url, 300), stars: num(r.stargazers_count), issues: num(r.open_issues_count), private: !!r.private })),
      pulls: (prs.items || []).map((p) => ({ title: str(p.title, 200), repo: str(p.repository_url?.split("/").slice(-2).join("/"), 120), number: num(p.number), url: str(p.html_url, 300), draft: !!p.draft, updated: p.updated_at, mine: p.user?.login === me.login })),
      notifications: notes ? notes.map((n) => ({ title: str(n.subject?.title, 200), type: str(n.subject?.type, 30), repo: str(n.repository?.full_name, 120), reason: str(n.reason, 30), updated: n.updated_at, unread: !!n.unread })) : null,
    };
  }, fresh);
}

// ---------------------------------------------------------------- markets (Finnhub quotes + your holdings)
export function parseHoldings(text) {
  return String(text || "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).slice(0, 40).map((l) => {
    const [sym, qty, target, ...rest] = l.split(/\s+/);
    return { symbol: str(sym, 20).toUpperCase(), qty: num(qty) ?? 0, target: num(String(target || "").replace("%", "")), name: str(rest.join(" "), 60) };
  }).filter((h) => /^[A-Z0-9.:-]+$/.test(h.symbol));
}
export async function markets(c, fresh) {
  const key = secret(c, "apiKey"), holdings = parseHoldings(c.values?.holdings);
  if (!holdings.length) throw new SourceError("add your holdings (one per line: SYMBOL quantity target%)");
  return caches.markets(c.id, async () => {
    const quotes = await Promise.all(holdings.map((h) => request(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(h.symbol)}&token=${encodeURIComponent(key)}`).then((q) => ({ ...h, price: num(q?.c), prev: num(q?.pc), change: num(q?.dp) })).catch((e) => ({ ...h, price: null, error: /HTTP 403/.test(e.message) ? "not on your Finnhub plan" : "no quote" }))));
    const priced = quotes.filter((q) => q.price);
    const total = priced.reduce((s, q) => s + q.price * q.qty, 0), prevTotal = priced.reduce((s, q) => s + (q.prev || q.price) * q.qty, 0);
    // Keep one value per day, so the chart grows from the day you connect.
    if (total > 0) {
      const day = new Date().toISOString().slice(0, 10), hist = (state.marketHistory ||= []);
      if (hist.at(-1)?.d === day) hist.at(-1).v = total; else hist.push({ d: day, v: total });
      if (hist.length > 800) hist.splice(0, hist.length - 800);
      persist();
    }
    return { total, day: total - prevTotal, dayPct: prevTotal ? (total / prevTotal - 1) * 100 : null, holdings: quotes.map((q) => ({ ...q, value: q.price ? q.price * q.qty : null, weight: q.price && total ? q.price * q.qty / total * 100 : null })), history: (state.marketHistory || []).slice(-365), missing: quotes.length - priced.length };
  }, fresh);
}

// ---------------------------------------------------------------- AdGuard Home
export async function adguard(c, fresh) {
  const url = baseUrl(c.values?.url, "AdGuard URL"), auth = { authorization: "Basic " + Buffer.from(`${c.values?.user || ""}:${secret(c, "password")}`).toString("base64") };
  return caches.adguard(c.id, async () => {
    const s = await request(`${url}/control/stats`, { headers: auth });
    const top = (s.top_blocked_domains || []).slice(0, 8).map((o) => { const [d, n] = Object.entries(o)[0] || []; return { domain: str(d, 120), count: num(n) ?? 0 }; });
    return { queries: num(s.num_dns_queries) ?? 0, blocked: num(s.num_blocked_filtering) ?? 0, avgMs: s.avg_processing_time != null ? Math.round(s.avg_processing_time * 1000) : null, top, perHour: (s.dns_queries || []).slice(-24).map(num) };
  }, fresh);
}

// ---------------------------------------------------------------- Tailscale
export async function tailscale(c, fresh) {
  const tailnet = encodeURIComponent(c.values?.tailnet || "-");
  return caches.tailscale(c.id, async () => {
    const r = await request(`https://api.tailscale.com/api/v2/tailnet/${tailnet}/devices`, { headers: { authorization: `Bearer ${secret(c, "apiKey")}` } });
    const now = Date.now();
    return { devices: (r.devices || []).slice(0, 100).map((d) => ({ name: str(d.name?.split(".")[0] || d.hostname, 60), address: str(d.addresses?.[0], 45), os: str(d.os, 20), seen: d.lastSeen, online: d.connectedToControl ?? (d.lastSeen ? now - Date.parse(d.lastSeen) < 5 * 60e3 : false), update: !!d.updateAvailable, expires: d.keyExpiryDisabled ? null : d.expires })) };
  }, fresh);
}

// ---------------------------------------------------------------- Cloudflare: tunnels, their hostnames, and which ones Access protects
export async function cloudflare(c, fresh) {
  const h = { authorization: `Bearer ${secret(c, "token")}` }, cf = (p) => request(`https://api.cloudflare.com/client/v4/${p}`, { headers: h }).then((r) => r.result);
  return caches.cloudflare(c.id, async () => {
    const acct = (await cf("accounts?per_page=5"))?.[0];
    if (!acct) throw new SourceError("the token cannot see any account");
    const [tunnels, apps] = await Promise.all([cf(`accounts/${acct.id}/cfd_tunnel?is_deleted=false&per_page=20`).catch(() => []), cf(`accounts/${acct.id}/access/apps?per_page=100`).catch(() => null)]);
    const protectedHosts = new Set((apps || []).flatMap((a) => [a.domain, ...(a.self_hosted_domains || [])]).filter(Boolean).map((d) => String(d).split("/")[0].toLowerCase()));
    const routes = [];
    for (const t of (tunnels || []).slice(0, 10)) {
      const cfg = await cf(`accounts/${acct.id}/cfd_tunnel/${t.id}/configurations`).catch(() => null);
      for (const i of cfg?.config?.ingress || []) if (i.hostname) routes.push({ host: str(i.hostname, 200), service: str(i.service, 200), tunnel: str(t.name, 60), up: t.status === "healthy", access: apps ? protectedHosts.has(i.hostname.toLowerCase()) || [...protectedHosts].some((p) => p.startsWith("*.") && i.hostname.endsWith(p.slice(1))) : null });
    }
    return { tunnels: (tunnels || []).map((t) => ({ name: str(t.name, 60), status: str(t.status, 20), connections: (t.connections || []).length })), routes, accessKnown: apps != null };
  }, fresh);
}

// ---------------------------------------------------------------- Uptime Kuma (its Prometheus metrics)
export async function uptimeKuma(c, fresh) {
  const url = baseUrl(c.values?.url, "Uptime Kuma URL");
  return caches.kuma(c.id, async () => {
    const text = await request(`${url}/metrics`, { expect: "text", headers: { authorization: "Basic " + Buffer.from(`:${secret(c, "apiKey")}`).toString("base64") } });
    const monitors = new Map();
    for (const m of text.matchAll(/^monitor_(status|response_time)\{([^}]*)\}\s+([-\d.e+]+)/gm)) {
      const labels = Object.fromEntries([...m[2].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1], x[2]]));
      const name = str(labels.monitor_name, 80), row = monitors.get(name) || { name, type: str(labels.monitor_type, 20), host: str(labels.monitor_hostname && labels.monitor_hostname !== "null" ? labels.monitor_hostname : labels.monitor_url, 120) };
      row[m[1] === "status" ? "status" : "ms"] = num(m[3]);
      monitors.set(name, row);
    }
    return { monitors: [...monitors.values()].slice(0, 80).map((m) => ({ ...m, state: m.status === 1 ? "up" : m.status === 0 ? "down" : m.status === 2 ? "pending" : m.status === 3 ? "maintenance" : "unknown" })) };
  }, fresh);
}

// ---------------------------------------------------------------- Prometheus: scrape targets and network throughput
export async function prometheusExtras(c, fresh) {
  const url = baseUrl(c.values?.url, "Prometheus URL"), token = secret(c, "token"), h = token ? { authorization: `Bearer ${token}` } : {};
  const q = (path) => request(`${url}/api/v1/${path}`, { headers: h }).then((r) => { if (r?.status !== "success") throw new SourceError("query failed"); return r.data.result; });
  return caches.prom(c.id, async () => {
    const end = Math.floor(Date.now() / 1000), dev = 'device!~"lo|veth.*|docker.*|br-.*|virbr.*|tailscale.*|cni.*|flannel.*"';
    const [up, rx, tx, gpuTemp, gpuPower, gpu] = await Promise.all([
      q("query?query=up"),
      q(`query_range?query=${encodeURIComponent(`sum(rate(node_network_receive_bytes_total{${dev}}[5m]))*8`)}&start=${end - 86400}&end=${end}&step=900`).catch(() => []),
      q(`query_range?query=${encodeURIComponent(`sum(rate(node_network_transmit_bytes_total{${dev}}[5m]))*8`)}&start=${end - 86400}&end=${end}&step=900`).catch(() => []),
      q(`query?query=${encodeURIComponent("max(DCGM_FI_DEV_GPU_TEMP) or max(nvidia_smi_temperature_gpu)")}`).catch(() => []),
      q(`query?query=${encodeURIComponent("sum(DCGM_FI_DEV_POWER_USAGE) or sum(nvidia_smi_power_draw_watts)")}`).catch(() => []),
      q(`query_range?query=${encodeURIComponent("max(DCGM_FI_DEV_GPU_UTIL) or max(100 * nvidia_smi_utilization_gpu_ratio)")}&start=${end - 86400}&end=${end}&step=900`).catch(() => []),
    ]);
    const series = (r) => (r[0]?.values || []).map(([t, v]) => [t * 1000, num(v) / 1e6]);
    return {
      targets: up.slice(0, 120).map((r) => ({ job: str(r.metric.job, 60), instance: str(r.metric.instance, 120), up: r.value?.[1] === "1" })),
      rx: series(rx), tx: series(tx), gpu: (gpu[0]?.values || []).map(([t, v]) => [t * 1000, num(v)]),
      gpuTemp: num(gpuTemp[0]?.value?.[1]), gpuPower: num(gpuPower[0]?.value?.[1]),
    };
  }, fresh);
}

// ---------------------------------------------------------------- Ollama: installed and loaded models
export async function ollama(c, fresh) {
  const url = baseUrl(c.values?.url, "Ollama URL");
  return caches.ollama(c.id, async () => {
    const [tags, ps, version] = await Promise.all([request(`${url}/api/tags`), request(`${url}/api/ps`), request(`${url}/api/version`).catch(() => ({}))]);
    const loaded = new Map((ps.models || []).map((m) => [m.name, m]));
    return {
      version: str(version.version, 20),
      models: (tags.models || []).slice(0, 80).map((m) => ({ name: str(m.name, 140), size: num(m.size), family: str(m.details?.family, 30), params: str(m.details?.parameter_size, 20), quant: str(m.details?.quantization_level, 20), loaded: loaded.has(m.name), vram: num(loaded.get(m.name)?.size_vram), until: loaded.get(m.name)?.expires_at || null })),
      loaded: (ps.models || []).slice(0, 10).map((m) => ({ name: str(m.name, 140), size: num(m.size), vram: num(m.size_vram), until: m.expires_at, context: num(m.context_length) })),
    };
  }, fresh);
}

// ---------------------------------------------------------------- Proxmox VE: nodes, VMs and containers
export async function proxmox(c, fresh) {
  const url = baseUrl(c.values?.url, "Proxmox URL"), pin = str(c.values?.fingerprint, 120).trim();
  const auth = { authorization: `PVEAPIToken=${str(c.values?.tokenId, 120).trim()}=${secret(c, "secret")}` };
  return caches.proxmox(c.id, async () => {
    const path = `${url}/api2/json/cluster/resources`, r = pin ? await pinnedRequest(path, pin, { headers: auth }) : await request(path, { headers: auth });
    const all = r?.data || [], pct = (a, b) => (a != null && b ? Math.round(a / b * 100) : null);
    return {
      nodes: all.filter((x) => x.type === "node").map((n) => ({ name: str(n.node, 60), online: n.status === "online", cpu: n.cpu != null ? Math.round(n.cpu * 100) : null, ram: pct(n.mem, n.maxmem), disk: pct(n.disk, n.maxdisk), uptime: num(n.uptime) })),
      guests: all.filter((x) => (x.type === "qemu" || x.type === "lxc") && !x.template).slice(0, 120).map((g) => ({ id: num(g.vmid), name: str(g.name || g.vmid, 80), kind: g.type === "lxc" ? "container" : "vm", node: str(g.node, 60), status: str(g.status, 20), cpu: g.status === "running" && g.cpu != null ? Math.round(g.cpu * 100) : null, ram: g.status === "running" ? pct(g.mem, g.maxmem) : null, uptime: num(g.uptime) })),
      storage: all.filter((x) => x.type === "storage" && x.maxdisk).slice(0, 20).map((s) => ({ name: str(s.storage, 60), node: str(s.node, 60), used: pct(s.disk, s.maxdisk) })),
    };
  }, fresh);
}

// ---------------------------------------------------------------- Jellyfin: what is playing, what is new
export async function jellyfin(c, fresh) {
  const url = baseUrl(c.values?.url, "Jellyfin URL"), h = { "x-emby-token": secret(c, "apiKey") };
  return caches.jellyfin(c.id, async () => {
    const [sessions, latest] = await Promise.all([
      request(`${url}/Sessions?activeWithinSeconds=900`, { headers: h }),
      request(`${url}/Items?Recursive=true&SortBy=DateCreated&SortOrder=Descending&IncludeItemTypes=Movie,Episode,MusicAlbum&Limit=10&Fields=DateCreated`, { headers: h }).catch(() => ({ Items: [] })),
    ]);
    const title = (i) => str(i.SeriesName ? `${i.SeriesName} · ${i.ParentIndexNumber != null ? `S${i.ParentIndexNumber}E${i.IndexNumber} ` : ""}${i.Name}` : i.AlbumArtist ? `${i.AlbumArtist} · ${i.Name}` : i.Name, 160);
    return {
      playing: (sessions || []).filter((s) => s.NowPlayingItem).slice(0, 8).map((s) => ({ user: str(s.UserName, 40), device: str(s.DeviceName, 60), title: title(s.NowPlayingItem), type: str(s.NowPlayingItem.Type, 20), paused: !!s.PlayState?.IsPaused, progress: s.NowPlayingItem.RunTimeTicks ? Math.round((s.PlayState?.PositionTicks || 0) / s.NowPlayingItem.RunTimeTicks * 100) : null })),
      latest: (latest?.Items || []).map((i) => ({ title: title(i), type: str(i.Type, 20), added: i.DateCreated || null })),
    };
  }, fresh);
}

// ---------------------------------------------------------------- jarvis-hermes: its host and the services it watches
export async function jarvisHermes(c, fresh) {
  const url = baseUrl(c.values?.url, "JARVIS URL"), h = { authorization: `Bearer ${secret(c, "token")}` };
  return caches.jarvis(c.id, async () => {
    const sys = await request(`${url}/api/system`, { headers: h });
    const pct = (a, b) => (a != null && b ? Math.round(a / b * 100) : null), disk = (sys?.disk || []).find((d) => d.total_bytes), gpu = sys?.gpu?.[0];
    return {
      host: { name: str(sys?.host?.hostname || "jarvis", 60), uptime: num(sys?.host?.uptime_s), cpu: sys?.cpu?.percent != null ? Math.round(sys.cpu.percent) : null, ram: pct(sys?.memory?.used_bytes, sys?.memory?.total_bytes), disk: disk ? pct(disk.used_bytes, disk.total_bytes) : null,
        gpu: gpu?.util_percent != null ? Math.round(gpu.util_percent) : null, gpuMemory: gpu ? pct(gpu.vram_used_bytes, gpu.vram_total_bytes) : null },
      services: (sys?.services || []).slice(0, 40).map((s) => ({ name: str(s.name, 80), state: str(s.state, 20), detail: str(s.detail, 160), ms: num(s.latency_ms) })),
    };
  }, fresh);
}

// ---------------------------------------------------------------- Custom HTTP: up or down, how fast, and a few top-level values
export async function customHttp(c, fresh) {
  const url = baseUrl(c.values?.url), hn = str(c.values?.header, 60).trim().toLowerCase(), val = secret(c, "value");
  if (hn && !/^[a-z0-9-]+$/.test(hn)) throw new SourceError("the header name is not valid");
  return caches.http(c.id, async () => {
    const t0 = Date.now(), body = await request(url, { headers: hn && val ? { [hn]: val } : {}, expect: "text", limit: 512 * 1024, redirect: hn && val ? "error" : "follow" });
    let values = [];
    try { const j = JSON.parse(body); if (j && typeof j === "object" && !Array.isArray(j)) values = Object.entries(j).filter(([, v]) => v == null || ["string", "number", "boolean"].includes(typeof v)).slice(0, 8).map(([k, v]) => [str(k, 40), str(v, 80)]); } catch {}
    return { id: c.id, name: str(c.values?.label, 60) || new URL(url).host, ms: Date.now() - t0, values };
  }, fresh);
}
