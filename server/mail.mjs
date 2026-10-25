// A small, read-only IMAP client for the Inbox: it opens the folder with EXAMINE (so nothing is
// marked as read), fetches the headers of the newest messages and logs out. No bodies, no writes.
import net from "node:net";
import tls from "node:tls";
import { cached, str, SourceError } from "./net.mjs";
import { open } from "./store.mjs";

const cache = cached(2 * 60e3);
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i;

// IMAP quoted string. Line breaks cannot be quoted, and nothing we send needs them.
const q = (s) => { s = String(s ?? ""); if (/[\r\n\0]/.test(s)) throw new SourceError("credentials must not contain line breaks"); return '"' + s.replace(/["\\]/g, "\\$&") + '"'; };

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
          const text = buf.subarray(0, i).toString("utf8"), w = waiting;
          buf = buf.subarray(i); i = 0; waiting = null;
          if (/^\S+ OK/i.test(line)) w.resolve(text); else w.reject(new SourceError(/AUTHENTICATIONFAILED|LOGIN|credentials|password/i.test(line) ? "login failed · check the username and password" : "the mail server refused: " + str(line.replace(/^\S+ /, ""), 120)));
        }
      }
    };
    const api = {
      cmd: (c) => new Promise((res, rej) => { const tag = "a" + ++n; waiting = { tag, resolve: res, reject: rej }; sock.write(`${tag} ${c}\r\n`); }),
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
  return { host, port, secure, user: str(c.values?.user, 200), password, folder: str(c.values?.folder || "INBOX", 100), webmail: /^https:\/\//.test(c.values?.webmail || "") ? str(c.values.webmail, 300) : "" };
}

export async function readMailbox(t, count = 25) {
  const s = await session(t);
  try {
    await s.cmd(`LOGIN ${q(t.user)} ${q(t.password)}`);
    const ex = await s.cmd(`EXAMINE ${q(t.folder)}`), total = Number(/^\* (\d+) EXISTS/im.exec(ex)?.[1] || 0);
    const unseen = total ? (/^\* SEARCH([\d ]*)/im.exec(await s.cmd("SEARCH UNSEEN"))?.[1] || "").trim().split(/\s+/).filter(Boolean).length : 0;
    const messages = total ? parseFetch(await s.cmd(`FETCH ${Math.max(1, total - count + 1)}:${total} (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`)).sort((a, b) => b.seq - a.seq) : [];
    await s.cmd("LOGOUT").catch(() => {});
    return { folder: t.folder, total, unseen, messages };
  } finally { s.close(); }
}

export async function mail(c, fresh) {
  const t = mailTarget(c);
  return cache(c.id, async () => ({ account: t.user, webmail: t.webmail, ...(await readMailbox(t)) }), fresh);
}
