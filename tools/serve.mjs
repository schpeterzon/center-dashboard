// Minimal static server for previewing dist/ locally: node tools/serve.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const dist = path.join(import.meta.dirname, "../dist");
const port = Number(process.argv[2] || process.env.PORT || 8080);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

http
  .createServer((req, res) => {
    const rel = path.normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
    const file = path.join(dist, rel || "index.html");
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log(`Serving dist/ at http://127.0.0.1:${port}`));
