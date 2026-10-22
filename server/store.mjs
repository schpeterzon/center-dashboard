// Persistent state in one JSON file, plus an encryption key for secrets.
//
//   data/state.json   owner (password hash, 2FA), settings, connections, sessions   (mode 600)
//   data/secret.key   32 random bytes for AES-256-GCM, unless JARVIS_SECRET_KEY is set  (mode 600)
//
// Secrets (API keys, tokens, the 2FA seed) are encrypted before they reach the disk and are
// never sent back to the browser.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const dataDir = path.resolve(process.env.JARVIS_DATA || path.join(import.meta.dirname, "../data"));
const stateFile = path.join(dataDir, "state.json");
const keyFile = path.join(dataDir, "secret.key");

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

function writePrivate(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export { writePrivate };

function loadKey() {
  const env = process.env.JARVIS_SECRET_KEY;
  if (env) {
    const key = /^[0-9a-f]{64}$/i.test(env) ? Buffer.from(env, "hex") : Buffer.from(env, "base64");
    if (key.length !== 32) throw new Error("JARVIS_SECRET_KEY must be 32 bytes, as 64 hex characters or base64");
    return key;
  }
  if (!fs.existsSync(keyFile)) writePrivate(keyFile, crypto.randomBytes(32).toString("base64"));
  return Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64");
}
const key = loadKey();

export function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}
export function open(sealed) {
  const [v, iv, tag, data] = String(sealed).split(".");
  if (v !== "v1") throw new Error("unknown secret format");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

const empty = () => ({ version: 1, owner: null, settings: {}, connections: [], sessions: [] });
export const state = (() => {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(stateFile, "utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Cannot read ${stateFile}: ${error.message}`);
    return empty();
  }
})();

let pending = null;
// Writes are coalesced; call flush() before exiting.
export function persist() {
  if (pending) return;
  pending = setTimeout(flush, 50);
}
export function flush() {
  clearTimeout(pending);
  pending = null;
  writePrivate(stateFile, JSON.stringify(state, null, 1));
}
