// Tiny zero-dependency static server for browser testing.
// Run: node .dev-server.js   (port 5173). Not used by Wallpaper Engine.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = 5173;
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon"
};

http.createServer((req, res) => {
    let p = req.url.split("?")[0];
    if (p === "/" || p === "") p = "/index.html";
    const file = path.join(ROOT, decodeURIComponent(p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); res.end("not found"); return; }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
        fs.createReadStream(file).pipe(res);
    });
}).listen(PORT, "127.0.0.1", () => {
    console.log("marimo dev server: http://127.0.0.1:" + PORT);
});
