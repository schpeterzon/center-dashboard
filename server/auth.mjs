// Sign-in: an owner password (scrypt), optional TOTP codes, server-side sessions, rate limits,
// and optional Cloudflare Access verification in front of everything.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { state, persist, seal, open, dataDir, writePrivate } from "./store.mjs";

const SESSION_DAYS = Number(process.env.JARVIS_SESSION_DAYS || 30);
export const MODE = process.env.JARVIS_AUTH === "access" ? "access" : "password";
const TRUST_PROXY = /^(1|true|yes|cloudflare)$/i.test(process.env.JARVIS_TRUST_PROXY || "");
const ACCESS_TEAM = (process.env.CF_ACCESS_TEAM_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const ACCESS_AUD = process.env.CF_ACCESS_AUD || "";
export const ACCESS = !!(ACCESS_TEAM && ACCESS_AUD);
if (MODE === "access" && !ACCESS) throw new Error("JARVIS_AUTH=access needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD");

// ---- request facts
export function clientIp(req) {
  if (TRUST_PROXY) {
    const h = req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (h) return h;
  }
  return req.socket.remoteAddress || "?";
}
export const isHttps = (req) => req.socket.encrypted || (TRUST_PROXY && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
export const isLocal = (req) => /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || "") && !req.headers["cf-connecting-ip"] && !req.headers["x-forwarded-for"];
export const proxyName = (req) => (req.headers["cf-ray"] ? "Cloudflare" : req.headers["x-forwarded-for"] ? "a reverse proxy" : "");

// ---- passwords
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw.normalize("NFKC"), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${h.toString("base64")}`;
}
export function checkPassword(pw, stored) {
  const [, N, r, p, salt, hash] = String(stored || "").split("$");
  if (!hash) {
    crypto.scryptSync("x", "timing-equaliser", 64, SCRYPT);
    return false;
  }
  const want = Buffer.from(hash, "base64");
  const got = crypto.scryptSync(String(pw).normalize("NFKC"), Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(got, want);
}
export const passwordProblem = (pw) =>
  typeof pw !== "string" || pw.length < 10 ? "Use at least 10 characters." : pw.length > 512 ? "That password is too long." : null;

// ---- first run: whoever can read the server log (or data/setup-code) may set the password.
const setupFile = path.join(dataDir, "setup-code");
export let setupCode = null;
export function initOwner() {
  if (MODE === "access" || state.owner) return;
  if (process.env.JARVIS_PASSWORD) {
    const problem = passwordProblem(process.env.JARVIS_PASSWORD);
    if (problem) throw new Error(`JARVIS_PASSWORD: ${problem}`);
    state.owner = { hash: hashPassword(process.env.JARVIS_PASSWORD), created: Date.now() };
    persist();
    console.log("Owner password set from JARVIS_PASSWORD. You can remove the variable now.");
    return;
  }
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  setupCode = Array.from(crypto.randomBytes(12), (b, i) => (i && i % 4 === 0 ? "-" : "") + alphabet[b % alphabet.length]).join("");
  writePrivate(setupFile, setupCode + "\n");
  console.log(`\n  First run: open the dashboard and enter this setup code to choose a password\n\n      ${setupCode}\n\n  (also saved in ${setupFile})\n`);
}
export function finishSetup(code, pw) {
  if (!setupCode || state.owner) throw httpError(409, "This dashboard is already set up.");
  const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const a = Buffer.from(norm(code)), b = Buffer.from(norm(setupCode));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpError(403, "That setup code is not right.");
  const problem = passwordProblem(pw);
  if (problem) throw httpError(400, problem);
  state.owner = { hash: hashPassword(pw), created: Date.now() };
  setupCode = null;
  fs.rmSync(setupFile, { force: true });
  persist();
}
export function resetOwner() {
  state.owner = null;
  state.sessions = [];
  persist();
}

// ---- sessions: random tokens in an HttpOnly cookie; only their SHA-256 is stored.
const sha = (t) => crypto.createHash("sha256").update(t).digest("base64url");
export const cookieName = (req) => (isHttps(req) ? "__Host-jarvis" : "jarvis");
function readCookie(req) {
  const jar = Object.fromEntries(String(req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((c) => c[0]).map(([k, ...v]) => [k, v.join("=")]));
  return jar["__Host-jarvis"] || jar.jarvis || null;
}
export function startSession(req, res) {
  const token = crypto.randomBytes(32).toString("base64url"), now = Date.now();
  state.sessions = state.sessions.filter((s) => s.exp > now).slice(-49);
  state.sessions.push({ h: sha(token), created: now, seen: now, exp: now + SESSION_DAYS * 864e5, ip: clientIp(req), agent: agentName(req.headers["user-agent"]) });
  persist();
  setCookie(req, res, token, SESSION_DAYS * 86400);
}
function setCookie(req, res, value, maxAge) {
  const secure = isHttps(req);
  res.setHeader("set-cookie", `${cookieName(req)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
}
export function currentSession(req) {
  const token = readCookie(req);
  if (!token) return null;
  const h = sha(token), now = Date.now(), s = state.sessions.find((x) => x.h === h && x.exp > now);
  if (!s) return null;
  if (now - s.seen > 5 * 60e3) {
    s.seen = now;
    s.exp = now + SESSION_DAYS * 864e5;
    persist();
  }
  return s;
}
export function endSession(req, res) {
  const s = currentSession(req);
  if (s) state.sessions = state.sessions.filter((x) => x !== s);
  persist();
  setCookie(req, res, "", 0);
}
export function revokeOthers(keep) {
  const before = state.sessions.length;
  state.sessions = state.sessions.filter((s) => s === keep);
  persist();
  return before - state.sessions.length;
}
function agentName(ua = "") {
  const b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} on ${os}` : b;
}

// ---- rate limiting: per address, growing lockouts after 5 misses, plus a global brake.
const misses = new Map();
let globalMisses = [];
export function lockedFor(ip) {
  const now = Date.now();
  globalMisses = globalMisses.filter((t) => now - t < 10 * 60e3);
  if (globalMisses.length >= 100) return 300;
  const m = misses.get(ip);
  return m && m.until > now ? Math.ceil((m.until - now) / 1000) : 0;
}
export function recordMiss(ip) {
  const m = misses.get(ip) || { n: 0, until: 0 };
  m.n++;
  if (m.n >= 5) m.until = Date.now() + Math.min(3600e3, 60e3 * 2 ** (m.n - 5));
  misses.set(ip, m);
  globalMisses.push(Date.now());
  if (misses.size > 5000) misses.delete(misses.keys().next().value);
}
export const clearMisses = (ip) => misses.delete(ip);

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s), the format every authenticator app reads.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const b32encode = (buf) => { let bits = "", out = ""; for (const b of buf) bits += b.toString(2).padStart(8, "0"); for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out; };
const b32decode = (s) => { let bits = ""; for (const c of s.replace(/=+$/, "").toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, "0"); return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2))); };
function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", b32decode(secret)).update(msg).digest(), o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}
export const newTotpSecret = () => b32encode(crypto.randomBytes(20));
export const totpUri = (secret) => `otpauth://totp/JARVIS:dashboard?secret=${secret}&issuer=JARVIS&algorithm=SHA1&digits=6&period=30`;
export function checkTotp(secret, code, lastStep = 0) {
  if (!/^\d{6}$/.test(String(code || ""))) return 0;
  const now = Math.floor(Date.now() / 30000);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    const a = Buffer.from(totpAt(secret, step)), b = Buffer.from(String(code));
    if (crypto.timingSafeEqual(a, b)) return step;
  }
  return 0;
}
export const ownerTotp = () => (state.owner?.totp ? open(state.owner.totp) : null);
export const setOwnerTotp = (secret) => { state.owner.totp = secret ? seal(secret) : null; state.owner.totpStep = 0; persist(); };

// ---- Cloudflare Access: verify the signed JWT Cloudflare adds to every request it lets through.
let jwks = { keys: [], at: 0 };
async function accessKeys(force) {
  if (!force && jwks.keys.length && Date.now() - jwks.at < 3600e3) return jwks.keys;
  if (force && Date.now() - jwks.at < 30e3) return jwks.keys;
  const r = await fetch(`https://${ACCESS_TEAM}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(8000) });
  jwks = { keys: (await r.json()).keys || [], at: Date.now() };
  return jwks.keys;
}
export async function verifyAccess(req) {
  if (!ACCESS) return null;
  const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.cookie || "")?.[1];
  const token = req.headers["cf-access-jwt-assertion"] || cookie;
  if (!token) return null;
  try {
    const [h, p, sig] = String(token).split(".");
    const header = JSON.parse(Buffer.from(h, "base64url")), payload = JSON.parse(Buffer.from(p, "base64url"));
    if (header.alg !== "RS256") return null;
    let jwk = (await accessKeys()).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await accessKeys(true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(sig, "base64url"));
    const aud = [].concat(payload.aud || []);
    const now = Date.now() / 1000;
    if (!ok || !aud.includes(ACCESS_AUD) || payload.iss !== `https://${ACCESS_TEAM}` || !(payload.exp > now) || (payload.nbf && payload.nbf > now + 60)) return null;
    return { email: payload.email || payload.common_name || "access" };
  } catch {
    return null;
  }
}

export function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, extra });
}
