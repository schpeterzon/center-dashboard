// Stand-ins for services you may not run, used by the tests and for trying the live board:
// an ICS calendar, Home Assistant (with health sensors), Uptime Kuma, AdGuard Home, Jellyfin,
// a jarvis-hermes server and a JSON status endpoint on one local port; an IMAP mailbox on port+1
// and Proxmox VE with a self-signed certificate on port+2.
//   node tools/fixtures.mjs [port]      then add connections pointing at http://127.0.0.1:<port>
import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";

// A throwaway self-signed certificate for 127.0.0.1, only for the Proxmox stand-in.
const CERT = `-----BEGIN CERTIFICATE-----
MIIBmjCCAUGgAwIBAgIUEQNOTOAXrsRTLQ43cn6Qy9fNvSMwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyNTEzMTY0MVoYDzIxMjYxMDAx
MTMxNjQxWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQqcw4Zy2/Gf4qwqAcx4hPxfjKRAPX2MRV2L8NMAzhp/vBN44LaCvP9
taGhixFl1/Wkcr9gXvD5YqXWukNDW2Kio28wbTAdBgNVHQ4EFgQUApHE9uDnJboe
lJn+06Ry/pULyHwwHwYDVR0jBBgwFoAUApHE9uDnJboelJn+06Ry/pULyHwwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDRwAwRAIgQmSdassnfnnODuFy3hzXiO/I+F15i9sFchwMXLrLWCMCIAmb
NLCISDIm3mgry+GkscBTkN9xNAEPVXfvc8mRn8xd
-----END CERTIFICATE-----`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgwriXdx+GgfkZTXTa
zLahRFz82DffNFMU+nV3I1mJKm+hRANCAAQqcw4Zy2/Gf4qwqAcx4hPxfjKRAPX2
MRV2L8NMAzhp/vBN44LaCvP9taGhixFl1/Wkcr9gXvD5YqXWukNDW2Ki
-----END PRIVATE KEY-----`;
export const FIXTURE_FINGERPRINT = new crypto.X509Certificate(CERT).fingerprint256;

const pad = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
const day = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
function calendar() {
  const now = new Date(), at = (dd, h, m = 0) => { const d = new Date(now); d.setDate(d.getDate() + dd); d.setHours(h, m, 0, 0); return d; };
  const ev = (uid, title, s, e, extra = "") => `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${title}\r\nDTSTART:${stamp(s)}\r\nDTEND:${stamp(e)}\r\n${extra}END:VEVENT\r\n`;
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7)); monday.setHours(9, 0, 0, 0);
  return "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Fixture\r\n" +
    ev("standup", "Standup", monday, new Date(+monday + 15 * 60e3), "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR\r\n") +
    ev("focus", "Deep work", at(0, 10), at(0, 12)) + ev("dentist", "Dentist", at(0, 15, 30), at(0, 16, 30)) + ev("gym", "Gym", at(0, 19, 30), at(0, 20, 30)) +
    ev("call", "Call with Mia", at(1, 16), at(1, 17)) + ev("dinner", "Dinner with Sam", at(2, 19), at(2, 21)) +
    `BEGIN:VEVENT\r\nUID:trip\r\nSUMMARY:Trip to the mountains\r\nDTSTART;VALUE=DATE:${day(at(3, 0))}\r\nDTEND;VALUE=DATE:${day(at(5, 0))}\r\nEND:VEVENT\r\n` +
    "END:VCALENDAR\r\n";
}
const S = (id, state, attrs = {}) => ({ entity_id: id, state, attributes: attrs, last_changed: new Date().toISOString(), last_updated: new Date(Date.now() - 12 * 60e3).toISOString() });
const ha = {
  states: [
    S("light.living_ceiling", "on", { friendly_name: "Ceiling", brightness: 180 }), S("light.living_lamp", "off", { friendly_name: "Floor lamp" }),
    S("media_player.tv", "off", { friendly_name: "TV" }), S("sensor.living_temp", "21.6", { device_class: "temperature", unit_of_measurement: "°C", friendly_name: "Living temperature" }),
    S("sensor.living_hum", "44", { device_class: "humidity", unit_of_measurement: "%" }),
    S("light.kitchen_spots", "on", { friendly_name: "Spots", brightness: 255 }), S("switch.coffee", "off", { friendly_name: "Coffee machine" }), S("sensor.kitchen_temp", "22.1", { device_class: "temperature", unit_of_measurement: "°C" }),
    S("light.office_desk", "on", { friendly_name: "Desk light", brightness: 120 }), S("fan.office_purifier", "on", { friendly_name: "Air purifier" }), S("sensor.office_temp", "21.2", { device_class: "temperature", unit_of_measurement: "°C" }),
    S("climate.heat_pump", "heat", { friendly_name: "Heat pump", temperature: 21, current_temperature: 21.4 }),
    S("lock.front_door", "locked", { friendly_name: "Front door" }), S("binary_sensor.garage", "off", { friendly_name: "Garage door", device_class: "garage_door" }), S("binary_sensor.bath_leak", "off", { friendly_name: "Bathroom leak", device_class: "moisture" }),
    S("scene.evening", "scening", { friendly_name: "Evening" }), S("scene.movie", "scening", { friendly_name: "Movie" }), S("scene.away", "scening", { friendly_name: "Away" }),
    S("sensor.solar_power", "3200", { device_class: "power", unit_of_measurement: "W", friendly_name: "Solar power" }), S("sensor.house_consumption", "1100", { device_class: "power", unit_of_measurement: "W", friendly_name: "House consumption" }),
    S("sensor.grid_power", "-700", { device_class: "power", unit_of_measurement: "W", friendly_name: "Grid power" }), S("sensor.heat_pump_power", "640", { device_class: "power", unit_of_measurement: "W", friendly_name: "Heat pump" }),
    S("sensor.home_battery", "78", { device_class: "battery", unit_of_measurement: "%", friendly_name: "Home battery" }),
    S("sensor.pixel_steps", "6412", { unit_of_measurement: "steps", friendly_name: "Pixel steps" }), S("sensor.pixel_heart_rate", "64", { unit_of_measurement: "bpm", friendly_name: "Pixel heart rate" }),
    S("sensor.pixel_sleep_duration", "442", { unit_of_measurement: "min", device_class: "duration", friendly_name: "Pixel sleep duration" }), S("sensor.scale_weight", "72.4", { unit_of_measurement: "kg", device_class: "weight", friendly_name: "Scale weight" }),
    S("sensor.energy_today", "14.2", { device_class: "energy", unit_of_measurement: "kWh", friendly_name: "Consumption today" }), S("sensor.solar_today", "21.7", { device_class: "energy", unit_of_measurement: "kWh", friendly_name: "Solar today" }),
  ],
  areas: [{ name: "Living room", entities: ["light.living_ceiling", "light.living_lamp", "media_player.tv", "sensor.living_temp", "sensor.living_hum"] }, { name: "Kitchen", entities: ["light.kitchen_spots", "switch.coffee", "sensor.kitchen_temp"] }, { name: "Office", entities: ["light.office_desk", "fan.office_purifier", "sensor.office_temp"] }, { name: "Hallway", entities: ["lock.front_door", "climate.heat_pump"] }],
  calls: [],
};
function history(ids = "") {
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const rows = (id, f) => Array.from({ length: Math.floor((Date.now() - t0) / 900e3) }, (_, i) => ({ entity_id: id, state: String(Math.round(f(i / 4))), last_changed: new Date(+t0 + i * 900e3).toISOString() }));
  const days = (id, f) => Array.from({ length: 14 * 24 }, (_, i) => ({ entity_id: id, state: String(Math.round(f(i))), last_changed: new Date(+t0 - 13 * 864e5 + i * 3600e3).toISOString() })).filter((r) => Date.parse(r.last_changed) <= Date.now());
  if (/pixel/.test(ids)) return [days("sensor.pixel_steps", (i) => (i % 24) * (300 + (Math.floor(i / 24) * 97) % 500)), days("sensor.pixel_heart_rate", (i) => 58 + (i % 24 > 7 && i % 24 < 22 ? 14 : 0) + (i % 5))];
  return [rows("sensor.solar_power", (h) => Math.max(0, Math.sin((h - 6.5) / 13 * Math.PI) * 4600)), rows("sensor.house_consumption", (h) => 400 + (h > 7 && h < 9 ? 1400 : 0) + (h > 18 && h < 22 ? 1800 : 0))];
}

export function startFixtures(port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/cal.ics") { res.writeHead(200, { "content-type": "text/calendar" }); return res.end(calendar()); }
    if (u.pathname === "/api/system") {
      if (req.headers.authorization !== "Bearer jarvis-token") { res.writeHead(401); return res.end(); }
      return json({ collected_at: new Date().toISOString(), host: { hostname: "hermes-vm", platform: "linux", kernel: "6.12", uptime_s: 302400, in_container: false }, cpu: { percent: 23.4, cores: 8, load: [0.4, 0.5, 0.6], model: "x" }, memory: { used_bytes: 6e9, total_bytes: 16e9 }, disk: [{ path: "/", used_bytes: 40e9, total_bytes: 100e9 }], gpu: null,
        services: [{ id: "jarvis", name: "JARVIS 1.4.0", state: "up", detail: null, latency_ms: 0 }, { id: "harness", name: "Harness", state: "up", detail: "connected", latency_ms: 12 }, { id: "openrouter", name: "OpenRouter", state: "not_configured", detail: null, latency_ms: null }, { id: "hermes", name: "Hermes gateway", state: "degraded", detail: "slow answers", latency_ms: 840 }] });
    }
    if (u.pathname === "/Sessions" || u.pathname === "/Items") {
      if (req.headers["x-emby-token"] !== "jf-key") { res.writeHead(401); return res.end(); }
      if (u.pathname === "/Sessions") return json([{ UserName: "sam", DeviceName: "Living room TV", NowPlayingItem: { Name: "The Long Night", SeriesName: "Andor", ParentIndexNumber: 2, IndexNumber: 3, Type: "Episode", RunTimeTicks: 3e10 }, PlayState: { PositionTicks: 1.2e10, IsPaused: false } }, { UserName: "sam", DeviceName: "Phone" }]);
      return json({ Items: [{ Name: "Dune: Part Two", Type: "Movie", DateCreated: new Date(Date.now() - 864e5).toISOString() }] });
    }
    if (u.pathname === "/status.json") return json({ status: "ok", version: "2.1.0", queue: 3, nested: { skip: true } });
    if (u.pathname.startsWith("/api/")) {
      if (req.headers.authorization !== "Bearer ha-token") { res.writeHead(401); return res.end("401: Unauthorized"); }
      if (u.pathname === "/api/states") return json(ha.states);
      if (u.pathname === "/api/") return json({ message: "API running." });
      if (u.pathname === "/api/template") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(JSON.stringify(ha.areas)); }
      if (u.pathname.startsWith("/api/history/period/")) return json(history(u.searchParams.get("filter_entity_id") || ""));
      if (u.pathname.startsWith("/api/services/")) {
        let b = ""; req.on("data", (d) => (b += d)).on("end", () => {
          const body = JSON.parse(b || "{}"), svc = u.pathname.split("/").slice(3).join(".");
          ha.calls.push({ svc, body });
          const s = ha.states.find((x) => x.entity_id === body.entity_id);
          if (s && svc.endsWith("toggle")) s.state = s.state === "on" ? "off" : "on";
          if (s && svc === "lock.unlock") s.state = "unlocked";
          if (s && svc === "lock.lock") s.state = "locked";
          if (s && svc === "climate.set_temperature") s.attributes.temperature = body.temperature;
          json([]);
        });
        return;
      }
    }
    if (u.pathname === "/metrics") { res.writeHead(200, { "content-type": "text/plain" }); return res.end('monitor_status{monitor_name="Nextcloud",monitor_type="http",monitor_url="https://cloud.example.com",monitor_hostname="null",monitor_port="null"} 1\nmonitor_response_time{monitor_name="Nextcloud",monitor_type="http",monitor_url="https://cloud.example.com",monitor_hostname="null",monitor_port="null"} 182\nmonitor_status{monitor_name="Backup target",monitor_type="ping",monitor_url="",monitor_hostname="nas.lan",monitor_port="null"} 0\n'); }
    if (u.pathname === "/control/stats") return json({ num_dns_queries: 48211, num_blocked_filtering: 6904, avg_processing_time: 0.012, top_blocked_domains: [{ "telemetry.tv-vendor.example": 1840 }, { "ads.example.net": 912 }, { "metrics.app.example": 640 }], dns_queries: Array(24).fill(2000) });
    if (u.pathname === "/control/status") return json({ running: true });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", async () => {
    const p = server.address().port, mail = await imap(port ? p + 1 : 0), pve = await proxmox(port ? p + 2 : 0);
    const close = server.close.bind(server);
    server.close = (cb) => { mail.close(); pve.close(); return close(cb); };
    r({ server, port: p, ha, imapPort: mail.address().port, pvePort: pve.address().port, fingerprint: FIXTURE_FINGERPRINT });
  }));
}

// A mailbox with three messages, two unread, served over plain IMAP on 127.0.0.1 (user "me", password "mail-pass").
function imap(port) {
  const msgs = [
    { flags: "\\Seen", head: "From: Landlord <rent@example.com>\r\nSubject: Heating check on Friday\r\nDate: Mon, 20 Oct 2026 09:12:00 +0200\r\n\r\n",
      body: "Content-Type: multipart/alternative; boundary=\"zz\"\r\n\r\n--zz\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nThe engineer comes at 10:00 on Friday. Please leave the boiler cupboard op=\r\nen. =E2=80=94 Landlord\r\n--zz\r\nContent-Type: text/html\r\n\r\n<p>The engineer comes at 10:00</p>\r\n--zz--\r\n" },
    { flags: "", head: "From: =?utf-8?B?TcOkcnRh?= <marta@example.com>\r\nSubject: =?utf-8?Q?Dinner_on_S=C3=BCnday=3F?=\r\nDate: Sat, 24 Oct 2026 18:40:00 +0200\r\n\r\n" },
    { flags: "\\Flagged", head: "From: \"GitHub\" <noreply@github.com>\r\nSubject: [center-dashboard] CI passed\r\nDate: Sun, 25 Oct 2026 08:01:00 +0100\r\n\r\n" },
  ];
  const srv = net.createServer((s) => {
    let buf = "", authed = false;
    s.write("* OK fixture IMAP ready\r\n");
    s.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, cmd] = line.split(" "), w = (x) => s.write(x);
        if (/^LOGIN$/i.test(cmd)) { authed = line === `${tag} LOGIN "me" "mail-pass"`; w(authed ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`); }
        else if (!authed) w(`${tag} BAD log in first\r\n`);
        else if (/^EXAMINE$/i.test(cmd)) w(`* ${msgs.length} EXISTS\r\n* OK [READ-ONLY]\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
        else if (/^SEARCH$/i.test(cmd) && / TEXT "/i.test(line)) { const word = /TEXT "([^"]*)"/i.exec(line)[1].toLowerCase(); w(`* SEARCH ${msgs.map((m, k) => ((m.head + (m.body || "")).toLowerCase().includes(word) ? k + 1 : "")).filter(Boolean).join(" ")}\r\n${tag} OK SEARCH completed\r\n`); }
        else if (/^SEARCH$/i.test(cmd)) w(`* SEARCH ${msgs.map((m, k) => (/Seen/.test(m.flags) ? "" : k + 1)).filter(Boolean).join(" ")}\r\n${tag} OK SEARCH completed\r\n`);
        else if (/^FETCH$/i.test(cmd) && /BODY\.PEEK\[\]/i.test(line)) { const k = Number(line.split(" ")[2]) - 1, m = msgs[k], full = m.head.replace(/\r\n\r\n$/, "\r\n") + (m.body || "\r\n(empty)"); w(`* ${k + 1} FETCH (BODY[]<0> {${Buffer.byteLength(full)}}\r\n${full})\r\n${tag} OK FETCH completed\r\n`); }
        else if (/^FETCH$/i.test(cmd)) { const set = new Set(line.split(" ")[2].split(",").flatMap((r) => { const [a, b] = r.split(":").map(Number); return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]; })); msgs.forEach((m, k) => set.has(k + 1) && w(`* ${k + 1} FETCH (UID ${100 + k} FLAGS (${m.flags}) INTERNALDATE "25-Oct-2026 08:01:00 +0100" BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${Buffer.byteLength(m.head)}}\r\n${m.head})\r\n`)); w(`${tag} OK FETCH completed\r\n`); }
        else if (/^LOGOUT$/i.test(cmd)) { w(`* BYE\r\n${tag} OK LOGOUT completed\r\n`); s.end(); }
        else w(`${tag} BAD unknown\r\n`);
      }
    });
    s.on("error", () => {});
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

// Proxmox VE's cluster resources, behind a self-signed certificate (token "root@pam!jarvis" / "pve-secret").
function proxmox(port) {
  const srv = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
    if (req.headers.authorization !== "PVEAPIToken=root@pam!jarvis=pve-secret") { res.writeHead(401); return res.end(); }
    if (!req.url.startsWith("/api2/json/cluster/resources")) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [
      { type: "node", node: "rackintosh", status: "online", cpu: 0.18, mem: 41e9, maxmem: 64e9, disk: 300e9, maxdisk: 1e12, uptime: 1209600 },
      { type: "qemu", vmid: 200, name: "hermes", node: "rackintosh", status: "running", cpu: 0.07, mem: 6e9, maxmem: 16e9, uptime: 600000 },
      { type: "lxc", vmid: 105, name: "adguard", node: "rackintosh", status: "running", cpu: 0.01, mem: 2e8, maxmem: 1e9, uptime: 600000 },
      { type: "qemu", vmid: 9000, name: "debian-template", node: "rackintosh", status: "stopped", template: 1 },
      { type: "qemu", vmid: 210, name: "windows", node: "rackintosh", status: "stopped" },
      { type: "storage", storage: "local-zfs", node: "rackintosh", disk: 400e9, maxdisk: 900e9 },
    ] }));
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

if (import.meta.url === `file://${process.argv[1]}`) startFixtures(Number(process.argv[2] || 18800)).then((f) => console.log(`fixtures on http://127.0.0.1:${f.port}
  calendar /cal.ics · Home Assistant token "ha-token" · Uptime Kuma · AdGuard · Jellyfin key "jf-key"
  JARVIS (hermes) token "jarvis-token" · Custom HTTP /status.json
  IMAP 127.0.0.1:${f.imapPort} user "me" password "mail-pass"
  Proxmox https://127.0.0.1:${f.pvePort} token "root@pam!jarvis" secret "pve-secret" fingerprint ${f.fingerprint}`));
