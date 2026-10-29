// A small, read-only IMAP client: it opens the folder with EXAMINE (so nothing is marked as read)
// and never writes. The Inbox reads headers only; JARVIS can search and read a message's text.
import net from "node:net";
import tls from "node:tls";
import { cached, str, SourceError } from "./net.mjs";
import { open } from "./store.mjs";

const cache = cached(2 * 60e3);
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i;

// IMAP quoted string. Line breaks cannot be quoted, and nothing we send needs them.
const q = (s) => { s = String(s ?? ""); if (/[\r\n\0]/.test(s)) throw new SourceError("credentials must not contain line breaks"); return '"' + s.replace(/["\\]/g, "\\$&") + '"'; };

// Most providers refuse your normal password over IMAP; say which password they want, and
// show the server's own words, which often name the exact problem.
function loginHelp(host, line) {
  const said = str(line.replace(/^\S+ (NO|BAD) /i, "").replace(/\s*\(Failure\)\s*$/, ""), 140);
  const hint = /gmail|googlemail/i.test(host) ? "Gmail needs an app password (Google account → Security → 2-Step Verification → App passwords), not your normal password, and the username is your full address"
    : /icloud|me\.com|mac\.com/i.test(host) ? "iCloud needs an app-specific password from account.apple.com, and the username is your full address"
    : /outlook|hotmail|live\.com|office365/i.test(host) ? "Outlook.com and Microsoft 365 no longer accept passwords over IMAP for most accounts"
    : /yahoo|aol/i.test(host) ? "Yahoo and AOL need an app password from the account security page"
    : "check the username (usually the full address) and the password";
  return `login failed · ${hint}. The server said: ${said}`;
}
function session({ host, port, secure, timeout = 12000 }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, servername: net.isIP(host) ? undefined : host };
    const sock = secure ? tls.connect(opts) : net.connect(opts);
    let buf = Buffer.alloc(0), waiting = null, n = 0, greeted = false;
    const fail = (e) => { sock.destroy(); const err = e instanceof SourceError ? e : new SourceError(e?.code === "ENOTFOUND" ? "mail server not found" : /certificate|self.signed/i.test(e?.message) ? "the mail server's certificate is not trusted" : "mail server not reachable"); if (waiting) waiting.reject(err); else reject(err); };
    const timer = setTimeout(() => fail(new SourceError(`no answer within ${timeout / 1000} s`)), timeout);
    // A response ends with the tagged status line; literals ({n}\r\n + n bytes) can contain anything.
    const scan = () => {
      let i = 0;
      for (;;) {
        const eol = buf.indexOf("\r\n", i);
        if (eol < 0) return;
        const line = buf.subarray(i, eol).toString("latin1"), lit = /\{(\d+)\}$/.exec(line);
        if (lit) { const end = eol + 2 + Number(lit[1]); if (buf.length < end) return; i = end; continue; }
        i = eol + 2;
        if (!greeted) { greeted = true; buf = buf.subarray(i); if (/^\* (OK|PREAUTH)/i.test(line)) resolve(api); else fail(new SourceError("unexpected mail server greeting")); i = 0; continue; }
        if (waiting && line.startsWith(waiting.tag + " ")) {
          const raw = Buffer.from(buf.subarray(0, i)), w = waiting;
          buf = buf.subarray(i); i = 0; waiting = null;
          if (/^\S+ OK/i.test(line)) w.resolve(w.raw ? raw : raw.toString("utf8")); else w.reject(new SourceError(/AUTHENTICATIONFAILED|LOGIN|credentials|password/i.test(line) ? loginHelp(host, line) : "the mail server refused: " + str(line.replace(/^\S+ /, ""), 120)));
        }
      }
    };
    const api = {
      cmd: (c, raw = false) => new Promise((res, rej) => { const tag = "a" + ++n; waiting = { tag, raw, resolve: res, reject: rej }; sock.write(`${tag} ${c}\r\n`); }),
      close: () => { clearTimeout(timer); sock.end(); },
    };
    sock.on("data", (d) => { buf = Buffer.concat([buf, d]); if (buf.length > 4 * 1024 * 1024) return fail(new SourceError("response too large")); scan(); });
    sock.on("error", fail);
  });
}

// RFC 2047 encoded words: =?utf-8?B?…?= and =?iso-8859-1?Q?…?=
export function decodeWords(s) {
  return String(s || "").replace(/\?=\s+=\?/g, "?==?").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (m, cs, enc, txt) => {
    try {
      const bytes = enc.toUpperCase() === "B" ? Buffer.from(txt, "base64") : Buffer.from(txt.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
      return new TextDecoder(cs.toLowerCase().replace(/\*.*$/, "")).decode(bytes);
    } catch { return m; }
  });
}
const header = (block, name) => { const m = new RegExp(`^${name}:([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, "im").exec(block); return m ? decodeWords(m[1].replace(/\r?\n[ \t]+/g, " ").trim()) : ""; };
function sender(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(from);
  return m ? { name: str(m[1].trim() || m[2], 80), address: str(m[2], 120) } : { name: str(from, 80), address: str(from, 120) };
}
export function parseFetch(text) {
  const out = [];
  for (const m of text.matchAll(/^\* (\d+) FETCH \(([\s\S]*?)(?=^\* \d+ FETCH|^a\d+ )/gm)) {
    const body = m[2], flags = /FLAGS \(([^)]*)\)/i.exec(body)?.[1] || "", uid = /UID (\d+)/i.exec(body)?.[1];
    const date = Date.parse(header(body, "Date")) || Date.parse(/INTERNALDATE "([^"]+)"/i.exec(body)?.[1]?.replace(/^(\d+)-(\w+)-(\d+)/, "$2 $1 $3"));
    out.push({ seq: Number(m[1]), uid: uid ? Number(uid) : null, from: sender(header(body, "From")), subject: str(header(body, "Subject") || "(no subject)", 200), at: Number.isFinite(date) ? date : null, unread: !/\\Seen/i.test(flags), flagged: /\\Flagged/i.test(flags), answered: /\\Answered/i.test(flags) });
  }
  return out;
}

export function mailTarget(c) {
  const host = str(c.values?.host, 200).trim(), port = Number(c.values?.port || 993);
  if (!/^[a-z0-9.-]+$|^[0-9a-f:]+$/i.test(host)) throw new SourceError("set the mail server, for example imap.gmail.com");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SourceError("the port must be a number");
  // Plain IMAP only to this machine (a local bridge such as Proton Bridge); everything else uses TLS.
  const secure = !(LOOPBACK.test(host) && port !== 993);
  let password = "";
  try { password = c.secrets?.password ? open(c.secrets.password) : ""; } catch { throw new SourceError("a saved secret could not be opened"); }
  // Gmail's INBOX over IMAP holds every tab (Updates, Promotions, Social); by default show Primary, as the Gmail app does.
  const tabs = String(c.values?.gmailTabs || "primary").trim().toLowerCase(), gmailTab = /gmail|googlemail/i.test(host) && /^(primary|updates|promotions|social|forums)$/.test(tabs) ? tabs : null;
  return { host, port, secure, gmailTab, user: str(c.values?.user, 200), password, folder: str(c.values?.folder || "INBOX", 100), webmail: /^https:\/\//.test(c.values?.webmail || "") ? str(c.values.webmail, 300) : "" };
}

export async function readMailbox(t, count = 25) {
  const s = await session(t);
  try {
    await s.cmd(`LOGIN ${q(t.user)} ${q(t.password)}`);
    const ex = await s.cmd(`EXAMINE ${q(t.folder)}`), total = Number(/^\* (\d+) EXISTS/im.exec(ex)?.[1] || 0);
    const search = async (q) => (/^\* SEARCH([\d ]*)/im.exec(await s.cmd("SEARCH " + q))?.[1] || "").trim().split(/\s+/).filter(Boolean).map(Number);
    const fields = "(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])";
    let unseen = 0, messages = [], shown = total;
    if (total && t.gmailTab) {
      const all = await search(`X-GM-RAW ${q("category:" + t.gmailTab)}`), unread = await search(`X-GM-RAW ${q("category:" + t.gmailTab + " is:unread")}`);
      shown = all.length; unseen = unread.length;
      // The newest unread first, then the newest read ones to fill the list.
      const pick = [...new Set([...unread.slice(-count), ...all.slice(-count)])].sort((a, b) => b - a).slice(0, count);
      if (pick.length) messages = parseFetch(await s.cmd(`FETCH ${pick.join(",")} ${fields}`)).sort((a, b) => b.seq - a.seq);
    } else if (total) {
      unseen = (await search("UNSEEN")).length;
      messages = parseFetch(await s.cmd(`FETCH ${Math.max(1, total - count + 1)}:${total} ${fields}`)).sort((a, b) => b.seq - a.seq);
    }
    await s.cmd("LOGOUT").catch(() => {});
    return { folder: t.gmailTab ? t.gmailTab[0].toUpperCase() + t.gmailTab.slice(1) : t.folder, total: shown, unseen, messages };
  } finally { s.close(); }
}

export async function mail(c, fresh) {
  const t = mailTarget(c);
  return cache(c.id, async () => ({ account: t.user, webmail: t.webmail, ...(await readMailbox(t)), checked: Date.now() }), fresh);
}

// ---------------------------------------------------------------- reading a message (for JARVIS)
// MIME is walked as latin1 text so byte offsets survive; each text part is decoded on its own.
function mimeParts(raw, depth = 0) {
  const sep = /\r?\n\r?\n/.exec(raw), head = sep ? raw.slice(0, sep.index) : raw, body = sep ? raw.slice(sep.index + sep[0].length) : "";
  const ct = header(head, "Content-Type") || "text/plain", type = ct.split(";")[0].trim().toLowerCase();
  const param = (k) => new RegExp(`${k}\\s*=\\s*"?([^";]+)"?`, "i").exec(ct)?.[1];
  if (type.startsWith("multipart/") && depth < 8) {
    const b = param("boundary"); if (!b) return { plain: "", html: "" };
    const out = { plain: "", html: "" };
    for (const part of body.split("--" + b).slice(1)) {
      if (part.startsWith("--")) break;
      const r = mimeParts(part.replace(/^\r?\n/, ""), depth + 1);
      // An alternative holds the same text twice; the first readable version is enough.
      if (type === "multipart/alternative") { out.plain ||= r.plain; out.html ||= r.html; } else { out.plain += r.plain; out.html += r.html; }
    }
    return out;
  }
  if (type === "message/rfc822" && depth < 8) return mimeParts(body, depth + 1);
  if (!/^text\/(plain|html)$/.test(type) || /^\s*attachment/i.test(header(head, "Content-Disposition"))) return { plain: "", html: "" };
  const enc = header(head, "Content-Transfer-Encoding").toLowerCase();
  const bytes = enc === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64")
    : enc === "quoted-printable" ? Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1")
    : Buffer.from(body, "latin1");
  let text;
  try { text = new TextDecoder((param("charset") || "utf-8").toLowerCase()).decode(bytes); } catch { text = bytes.toString("utf8"); }
  return type === "text/html" ? { plain: "", html: text + "\n" } : { plain: text + "\n", html: "" };
}
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function htmlText(h) {
  return h.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="(https?:[^"]{1,300})"[^>]*>([\s\S]*?)<\/a>/gi, (m, url, t) => { const label = t.replace(/<[^>]+>/g, "").trim(); return label && !url.includes(label) ? `${label} (${url})` : url; })
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, "\n").replace(/<li[^>]*>/gi, "• ").replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m)
    .replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
export function messageText(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString("latin1") : String(raw), p = mimeParts(s);
  const plain = p.plain.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return plain.length > 40 || !p.html ? plain : htmlText(p.html);
}

// Gmail understands its own search language (from:, newer_than:, words in the body); other
// servers get a plain TEXT search. Queries are folded to ASCII so they fit an IMAP quoted string.
export async function searchMail(c, query, { read = 2, list = 10 } = {}) {
  const t = mailTarget(c), s = await session({ ...t, timeout: 30000 });
  const words = String(query || "").normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  try {
    await s.cmd(`LOGIN ${q(t.user)} ${q(t.password)}`);
    const ex = await s.cmd(`EXAMINE ${q(t.folder)}`), total = Number(/^\* (\d+) EXISTS/im.exec(ex)?.[1] || 0);
    const gmail = /gmail|googlemail/i.test(t.host);
    let seqs = [];
    if (total && words) seqs = (/^\* SEARCH([\d ]*)/im.exec(await s.cmd("SEARCH " + (gmail ? `X-GM-RAW ${q(words)}` : `TEXT ${q(words)}`)))?.[1] || "").trim().split(/\s+/).filter(Boolean).map(Number);
    else if (total) seqs = Array.from({ length: Math.min(list, total) }, (_, i) => total - i);
    seqs = seqs.sort((a, b) => b - a);
    const found = seqs.length, top = seqs.slice(0, list);
    const heads = top.length ? parseFetch(await s.cmd(`FETCH ${top.join(",")} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`)).sort((a, b) => b.seq - a.seq) : [];
    for (const m of heads.slice(0, read)) {
      const raw = await s.cmd(`FETCH ${m.seq} (BODY.PEEK[]<0.600000>)`, true), lit = /\{(\d+)\}\r\n/.exec(raw.toString("latin1"));
      m.text = lit ? str(messageText(raw.subarray(lit.index + lit[0].length, lit.index + lit[0].length + Number(lit[1]))), 12000) : "";
    }
    await s.cmd("LOGOUT").catch(() => {});
    return { query: words, found, messages: heads };
  } finally { s.close(); }
}
