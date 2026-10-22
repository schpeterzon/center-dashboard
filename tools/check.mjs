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
if (kb > 600) fail(`dist/index.html is ${kb.toFixed(0)} KB (budget 600 KB)`);
if (html.includes("/*@FONT@*/") || html.includes("<!--@ORB@-->")) fail("build placeholders left in output");
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

// Every pane named in the navigation order must exist.
const order = app.match(/const order = \[([^\]]+)\]/)?.[1].match(/'([\w-]+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
const panes = new Set([...markup.matchAll(/class="pane[^"]*" data-id="([\w-]+)"/g)].map((m) => m[1]));
if (order.length !== 9) fail(`navigation order lists ${order.length} panes, expected 9`);
for (const id of order) if (!panes.has(id)) fail(`navigation order names pane "${id}", which does not exist`);

if (problems.length) {
  console.error(`✗ ${problems.length} problem${problems.length > 1 ? "s" : ""} in dist/index.html:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`✓ dist/index.html passed static checks (${kb.toFixed(0)} KB, ${scripts.length} scripts, ${panes.size} panes, ${known.size} ids)`);
