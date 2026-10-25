// Stand-ins for services you may not run, used by the tests and for trying the live board:
// an ICS calendar, Home Assistant, Uptime Kuma and AdGuard Home on one local port.
//   node tools/fixtures.mjs [port]      then add connections pointing at http://127.0.0.1:<port>
import http from "node:http";

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
const S = (id, state, attrs = {}) => ({ entity_id: id, state, attributes: attrs, last_changed: new Date().toISOString() });
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
    S("sensor.energy_today", "14.2", { device_class: "energy", unit_of_measurement: "kWh", friendly_name: "Consumption today" }), S("sensor.solar_today", "21.7", { device_class: "energy", unit_of_measurement: "kWh", friendly_name: "Solar today" }),
  ],
  areas: [{ name: "Living room", entities: ["light.living_ceiling", "light.living_lamp", "media_player.tv", "sensor.living_temp", "sensor.living_hum"] }, { name: "Kitchen", entities: ["light.kitchen_spots", "switch.coffee", "sensor.kitchen_temp"] }, { name: "Office", entities: ["light.office_desk", "fan.office_purifier", "sensor.office_temp"] }, { name: "Hallway", entities: ["lock.front_door", "climate.heat_pump"] }],
  calls: [],
};
function history() {
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const rows = (id, f) => Array.from({ length: Math.floor((Date.now() - t0) / 900e3) }, (_, i) => ({ entity_id: id, state: String(Math.round(f(i / 4))), last_changed: new Date(+t0 + i * 900e3).toISOString() }));
  return [rows("sensor.solar_power", (h) => Math.max(0, Math.sin((h - 6.5) / 13 * Math.PI) * 4600)), rows("sensor.house_consumption", (h) => 400 + (h > 7 && h < 9 ? 1400 : 0) + (h > 18 && h < 22 ? 1800 : 0))];
}

export function startFixtures(port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/cal.ics") { res.writeHead(200, { "content-type": "text/calendar" }); return res.end(calendar()); }
    if (u.pathname.startsWith("/api/")) {
      if (req.headers.authorization !== "Bearer ha-token") { res.writeHead(401); return res.end("401: Unauthorized"); }
      if (u.pathname === "/api/states") return json(ha.states);
      if (u.pathname === "/api/") return json({ message: "API running." });
      if (u.pathname === "/api/template") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(JSON.stringify(ha.areas)); }
      if (u.pathname.startsWith("/api/history/period/")) return json(history());
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
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, port: server.address().port, ha })));
}

if (import.meta.url === `file://${process.argv[1]}`) startFixtures(Number(process.argv[2] || 18800)).then((f) => console.log(`fixtures on http://127.0.0.1:${f.port} (calendar /cal.ics, Home Assistant token "ha-token", Uptime Kuma, AdGuard)`));
