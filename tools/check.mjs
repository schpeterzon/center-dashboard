// Static checks on the built page; run after `node tools/build.mjs`. Exits non-zero on failure.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const file = path.join(import.meta.dirname, "../dist/index.html");
const html = fs.readFileSync(file, "utf8");
const problems = [];
const fail = (msg) => problems.push(msg);

// The page must stay a single self-contained file of reasonable size.
const kb = Buffer.byteLength(html) / 1024;
// The server sends it compressed (about 210 KB); the budget flags unexpected growth.
if (kb > 760) fail(`dist/index.html is ${kb.toFixed(0)} KB (budget 760 KB)`);
if (/\/\*@[A-Z]+@\*\/|<!--@[A-Z]+@-->/.test(html)) fail("build placeholders left in output");
if (!html.includes("window.JarvisOrbAtmospheres")) fail("orb palette table is not exposed to the board");
if (!/\[data-theme="dracula"\]/.test(html)) fail("built-in themes are missing");
if (!html.includes("const AI_PROVIDERS")) fail("connection catalog is missing");

// The login page must never carry personal content or the app itself.
const login = fs.readFileSync(path.join(import.meta.dirname, "../dist/login.html"), "utf8");
if (/@[A-Z]+@/.test(login)) fail("build placeholders left in login.html");
if (/data-id=|JarvisOrbModule|profile|settings/.test(login)) fail("login.html contains dashboard content");
if (!/data:font\/ttf;base64,[A-Za-z0-9+/]{1000}/.test(html)) fail("Space Grotesk is not inlined");
if (!html.includes("window.JarvisOrbModule")) fail("JARVIS orb bundle is missing");
if (/<(script|link)[^>]+(src|href)=["']https?:/i.test(html)) fail("page loads a remote script or stylesheet; it must stay self-contained");

// Every inline script must parse.
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (scripts.length < 2) fail(`expected the orb and app scripts, found ${scripts.length} inline scripts`);
scripts.forEach((code, i) => {
  try {
    new vm.Script(code, { filename: `inline-script-${i}.js` });
  } catch (error) {
    fail(`inline script ${i} does not parse: ${error.message}`);
  }
});

const app = scripts.at(-1) ?? "";
// `$` returns one element; a `$(…).forEach` almost always means a `$$` got lost.
for (const m of app.matchAll(/(?<![$\w])\$\(([^()]*)\)\.(forEach|map|filter|some|every)\(/g))
  fail(`single-element $(${m[1]}) used as a list (.${m[2]}) — should this be $$?`);

// Static ids must be unique.
const markup = html.replace(/<script>[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) fail(`duplicate id "${id}" in markup`);

// Every '#id' the script looks up must exist, either in the markup or in markup the script builds.
const known = new Set([...html.matchAll(/\sid=\\?["']([\w-]+)\\?["']/g)].map((m) => m[1]));
// A trailing "-" is a prefix completed at runtime ('#hc-' + name): some id must start with it.
const defined = (id) => (id.endsWith("-") ? [...known].some((k) => k.startsWith(id)) : known.has(id));
for (const m of app.matchAll(/\$\$?\(\s*['"`]#([\w-]+)/g)) if (!defined(m[1])) fail(`script looks up #${m[1]}, which no markup defines`);
for (const m of app.matchAll(/getElementById\(\s*['"`]([\w-]+)/g)) if (!known.has(m[1])) fail(`script looks up #${m[1]}, which no markup defines`);

// Every pane in the default layout must exist, and every pane needs a name and a description
// for the Settings page library.
const slots = app.match(/const DEFAULT_LAYOUT = \{[^}]*slots: \[([^\]]+)\]/)?.[1].match(/'([\w-]+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
const paneTags = [...markup.matchAll(/<section class="pane[^"]*"([^>]*)>/g)].map((m) => m[1]);
const panes = new Set(paneTags.map((t) => t.match(/data-id="([\w-]+)"/)?.[1]));
if (slots.length !== 9) fail(`default layout lists ${slots.length} panes, expected 9`);
for (const id of slots) if (!panes.has(id)) fail(`default layout names pane "${id}", which does not exist`);
for (const t of paneTags) if (!/data-name="[^"]+"/.test(t) || !/data-desc="[^"]+"/.test(t) || !/data-tint="\d+,\d+,\d+"/.test(t)) fail(`pane tag is missing data-name, data-desc or data-tint: ${t.trim()}`);

if (problems.length) {
  console.error(`✗ ${problems.length} problem${problems.length > 1 ? "s" : ""} in dist/index.html:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`✓ dist/index.html passed static checks (${kb.toFixed(0)} KB, ${scripts.length} scripts, ${panes.size} panes, ${known.size} ids)`);
