// Builds dist/index.html: src/index.html with the JARVIS orb and Space Grotesk inlined, so the
// result is one self-contained file that works from disk (file:// cannot load ES modules or,
// in most browsers, local fonts) and on any static host.
//
//   node tools/build.mjs                      build from vendor/
//   node tools/build.mjs --sync ../jarvis-hermes   refresh vendor/ from a jarvis-hermes checkout, then build
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.join(import.meta.dirname, "..");
const vendor = path.join(root, "vendor");
const orbDir = path.join(vendor, "jarvis-orb");

const syncAt = process.argv.indexOf("--sync");
if (syncAt !== -1) {
  const repo = path.resolve(process.argv[syncAt + 1] || path.join(root, "../jarvis-hermes"));
  const web = path.join(repo, "apps/web/public");
  fs.rmSync(orbDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(orbDir, "orb"), { recursive: true });
  for (const f of ["orb.js", "atmosphere.js"]) fs.copyFileSync(path.join(web, f), path.join(orbDir, f));
  for (const f of fs.readdirSync(path.join(web, "orb")).filter((f) => f.endsWith(".js")))
    fs.copyFileSync(path.join(web, "orb", f), path.join(orbDir, "orb", f));
  for (const f of ["SpaceGrotesk.ttf", "OFL.txt"]) fs.copyFileSync(path.join(web, "fonts", f), path.join(vendor, "fonts", f));
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", repo, "log", "-1", "--format=%h"], { encoding: "utf8" }).trim();
  } catch {}
  fs.writeFileSync(path.join(orbDir, "SOURCE"), `jarvis-hermes@${commit} apps/web/public/{orb.js,atmosphere.js,orb/}\n`);
  console.log(`vendor/ synced from jarvis-hermes@${commit}`);
}

// --- orb: a tiny module registry in place of ES imports
const modules = new Map();
function load(file) {
  const id = path.relative(orbDir, file);
  if (modules.has(id)) return id;
  modules.set(id, null);
  let src = fs.readFileSync(file, "utf8");
  // The board feeds the theme's colours to the orb, so its palette table must stay writable.
  if (id === "atmosphere.js") src = src.replace("export const ATMOSPHERES = Object.freeze(", "export const ATMOSPHERES = (");
  const exported = [];
  const dep = (spec) => JSON.stringify(load(path.resolve(path.dirname(file), spec)));
  src = src.replace(/export\s*\{([^}]*)\}\s*from\s*"([^"]+)";/g, (_, names, spec) =>
    `{ const r = __req(${dep(spec)}); ${names.split(",").map((n) => n.trim()).filter(Boolean).map((n) => `__e.${n} = r.${n};`).join(" ")} }`);
  src = src.replace(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)";/g, (_, names, spec) =>
    `const {${names.replace(/\s+as\s+/g, ": ")}} = __req(${dep(spec)});`);
  src = src.replace(/^export\s+(const|let|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => {
    exported.push(name);
    return `${kind} ${name}`;
  });
  if (/^\s*(import|export)\b/m.test(src)) throw new Error(`Unhandled import/export in ${id}`);
  modules.set(id, `${src}\nObject.assign(__e, { ${exported.join(", ")} });`);
  return id;
}
load(path.join(orbDir, "orb.js"));
const source = fs.readFileSync(path.join(orbDir, "SOURCE"), "utf8").trim().split(" ")[0];
const orb = `// JARVIS orb, bundled from ${source} by tools/build.mjs.
(() => {
const __defs = {}, __cache = {};
const __req = (id) => {
  if (!__cache[id]) { __cache[id] = {}; __defs[id](__cache[id]); }
  return __cache[id];
};
${[...modules].map(([id, code]) => `__defs[${JSON.stringify(id)}] = (__e) => {\n${code}\n};`).join("\n")}
window.JarvisOrbModule = __req("orb.js");
window.JarvisOrbAtmospheres = __req("atmosphere.js").ATMOSPHERES;
})();`.replace(/<\/script/gi, "<\\/script");

const font = fs.readFileSync(path.join(vendor, "fonts/SpaceGrotesk.ttf")).toString("base64");

const themes = fs.readFileSync(path.join(root, "src/themes.css"), "utf8");
// The catalog is an ES module for the server; in the page it becomes plain constants.
const catalog = fs.readFileSync(path.join(root, "src/catalog.mjs"), "utf8").replace(/^export /gm, "");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

// Function replacements, so "$$" or "$'" in the inlined code is never read as a replace pattern.
const html = fs
  .readFileSync(path.join(root, "src/index.html"), "utf8")
  .replace("/*@FONT@*/", () => font)
  .replace("/*@THEMES@*/", () => themes)
  .replace("/*@CATALOG@*/", () => catalog)
  .replace("<!--@ORB@-->", () => `<script>\n${orb}\n</script>`);
const login = fs.readFileSync(path.join(root, "src/login.html"), "utf8").replace("/*@FONT@*/", () => font);
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist/index.html"), html);
fs.writeFileSync(path.join(root, "dist/login.html"), login);
fs.writeFileSync(path.join(root, "dist/version.txt"), version + "\n");
console.log(`dist/index.html: ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB · orb ${modules.size} modules from ${source} · Space Grotesk inlined · login ${(Buffer.byteLength(login) / 1024).toFixed(0)} KB`);
