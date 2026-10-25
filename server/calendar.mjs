// Private ICS links (Google, iCloud, Outlook, Nextcloud…) → events for the next weeks.
// Handles all-day and timed events, TZID time zones, and the common RRULE forms
// (DAILY / WEEKLY / MONTHLY / YEARLY with INTERVAL, COUNT, UNTIL, BYDAY), plus EXDATE.
import { request, cached, str } from "./net.mjs";
import { open } from "./store.mjs";

const cache = cached(5 * 60e3);

function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}
function prop(line) {
  const i = line.indexOf(":");
  if (i < 0) return null;
  const [name, ...params] = line.slice(0, i).split(";");
  return { name: name.toUpperCase(), params: Object.fromEntries(params.map((p) => p.split("=")).map(([k, v]) => [k.toUpperCase(), (v || "").replace(/^"|"$/g, "")])), value: line.slice(i + 1) };
}
const unescape = (s) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

// Wall-clock time in an IANA zone → UTC milliseconds, using the platform's zone data.
function zoned(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  if (!tz) return guess;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const offset = (t) => { const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t; };
    let t = guess - offset(guess);
    t = guess - offset(t);
    return t;
  } catch { return guess; }
}
function parseDate(p, fallbackTz) {
  const v = p.value.trim(), m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { t: Date.UTC(+y, +mo - 1, +d), allDay: true, y: +y, mo: +mo - 1, d: +d };
  const tz = z ? null : p.params.TZID || fallbackTz;
  return { t: z ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)) : zoned(+y, +mo - 1, +d, +h, +mi, +(s || 0), tz), allDay: false, tz };
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
// Wall-clock fields of an instant in a zone, as a UTC timestamp (so UTC getters read local time).
function zonedWall(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}
// Occurrences are stepped in wall-clock time and converted back per occurrence, so a weekly
// 09:00 meeting stays at 09:00 local across daylight-saving changes.
function expand(ev, from, to) {
  const dur = ev.end - ev.start, out = [], r = ev.rrule, ex = new Set(ev.exdates);
  const push = (t) => { if (t + dur >= from && t < to && !ex.has(t)) out.push({ ...ev, start: t, end: t + dur }); };
  if (!r) { push(ev.start); return out; }
  const tz = !ev.allDay && ev.tz ? ev.tz : null;
  const toWall = (t) => (tz ? zonedWall(t, tz) : t), fromWall = (w) => { const d = new Date(w); return tz ? zoned(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), tz) : w; };
  const freq = r.FREQ, interval = Math.max(1, +(r.INTERVAL || 1)), count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? parseDate({ value: r.UNTIL, params: {} })?.t ?? Infinity : Infinity;
  const byday = r.BYDAY ? r.BYDAY.split(",").map((d) => DAYS.indexOf(d.slice(-2))).filter((d) => d >= 0).sort() : null;
  const b = new Date(toWall(ev.start)), Y = b.getUTCFullYear(), M = b.getUTCMonth(), D = b.getUTCDate(), h = b.getUTCHours(), mi = b.getUTCMinutes();
  const at = (y, m, d) => Date.UTC(y, m, d, h, mi);
  let n = 0;
  for (let i = 0; i < 3000 && n < count; i++) {
    let walls;
    if (freq === "DAILY") walls = [at(Y, M, D + i * interval)];
    else if (freq === "WEEKLY") { const sunday = D - b.getUTCDay() + i * 7 * interval; walls = (byday || [b.getUTCDay()]).map((wd) => at(Y, M, sunday + wd)); }
    else if (freq === "MONTHLY") walls = [at(Y, M + i * interval, D)];
    else if (freq === "YEARLY") walls = [at(Y + i * interval, M, D)];
    else { push(ev.start); break; }
    let past = false;
    for (const w of walls) {
      const t = fromWall(w);
      if (t < ev.start) continue;
      if (t > until || n >= count) { past = true; break; }
      n++; push(t);
      if (t > to) past = true;
    }
    if (past) break;
  }
  return out;
}

export function parseIcs(text, from, to) {
  const lines = unfold(text);
  const calTz = lines.map(prop).find((p) => p?.name === "X-WR-TIMEZONE")?.value;
  const events = [], overrides = new Map();
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { exdates: [] }; continue; }
    if (line === "END:VEVENT") {
      if (cur?.start != null && cur.status !== "CANCELLED") {
        cur.end ??= cur.allDay ? cur.start + 864e5 : cur.start + 3600e3;
        if (cur.recurrenceId != null) overrides.set(`${cur.uid}|${cur.recurrenceId}`, cur); else events.push(cur);
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const p = prop(line);
    if (!p) continue;
    if (p.name === "SUMMARY") cur.title = unescape(p.value);
    else if (p.name === "LOCATION") cur.location = unescape(p.value);
    else if (p.name === "UID") cur.uid = p.value;
    else if (p.name === "STATUS") cur.status = p.value.toUpperCase();
    else if (p.name === "DTSTART") { const d = parseDate(p, calTz); if (d) { cur.start = d.t; cur.allDay = d.allDay; cur.tz = d.tz; } }
    else if (p.name === "DTEND") { const d = parseDate(p, calTz); if (d) cur.end = d.t; }
    else if (p.name === "DURATION") { const m = /P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/.exec(p.value); if (m && cur.start != null) cur.end = cur.start + (((+m[1] || 0) * 7 + (+m[2] || 0)) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000; }
    else if (p.name === "RRULE") cur.rrule = Object.fromEntries(p.value.split(";").map((kv) => kv.split("=")));
    else if (p.name === "EXDATE") for (const v of p.value.split(",")) { const d = parseDate({ value: v, params: p.params }, calTz); if (d) cur.exdates.push(d.t); }
    else if (p.name === "RECURRENCE-ID") cur.recurrenceId = parseDate(p, calTz)?.t;
  }
  const out = [];
  for (const ev of events) for (const o of expand(ev, from, to)) {
    const moved = overrides.get(`${ev.uid}|${o.start}`);
    if (moved) continue;
    out.push(o);
  }
  for (const o of overrides.values()) if (o.end >= from && o.start < to) out.push(o);
  return out.sort((a, b) => a.start - b.start).slice(0, 800)
    .map((e) => ({ title: str(e.title || "(no title)", 160), location: str(e.location, 160), start: e.start, end: e.end, allDay: !!e.allDay }));
}

export async function calendarEvents(c, fresh) {
  let url;
  try { url = open(c.secrets.url); } catch { throw new Error("the saved calendar link could not be opened"); }
  return cache(c.id, async () => {
    const text = await request(url.replace(/^webcal:/i, "https:"), { expect: "text", timeout: 12000 });
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error("that link did not return a calendar");
    const now = new Date(), from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7), to = from + 35 * 864e5;
    return { name: c.name, events: parseIcs(text, from, to) };
  }, fresh);
}
