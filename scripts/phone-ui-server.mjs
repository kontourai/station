// Dev-only static UI server for LAN phone testing.
//
// `./station start` serves the UI same-origin, but phone testing needs the UI
// (port 3000) and API (port 3141) on different ports of the LAN IP. The app
// reads `window.__API_BASE__` first (see ApiBaseContext), so this server serves
// the built `dist-ui-<instance>` bundle and injects that global at request time
// — decoupled from the build, so a rebuild of the bundle is picked up live.
//
// Env:
//   PHONE_UI_PORT   listen port (default 3000)
//   PHONE_API_BASE  injected window.__API_BASE__ (default http://<lan-ip>:3141)
//   PHONE_UI_DIR    bundle dir (default dist-ui-phone)
//   PHONE_LAN_IP    LAN IP used to derive the default API base (default 192.168.50.19)
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

const lanIp = process.env.PHONE_LAN_IP ?? '192.168.50.19';
const port = Number(process.env.PHONE_UI_PORT ?? 3000);
const apiBase = process.env.PHONE_API_BASE ?? `http://${lanIp}:3141`;
const dir = process.env.PHONE_UI_DIR
  ? process.env.PHONE_UI_DIR
  : join(process.cwd(), 'dist-ui-phone');
const inject = `<script>window.__API_BASE__="${apiBase}"</script>`;

const mime = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

createServer((req, res) => {
  const u = (req.url ?? '/').split('?')[0];
  let p = join(dir, u === '/' ? 'index.html' : u);
  const reqExt = extname(u);
  const exists = existsSync(p) && !statSync(p).isDirectory();
  if (!exists) {
    const wantsHtml =
      !reqExt || (req.headers.accept || '').includes('text/html');
    if (!wantsHtml) {
      res.writeHead(404, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache',
      });
      res.end('Not found');
      return;
    }
    p = join(dir, 'index.html'); // SPA fallback
  }
  const ext = extname(p);
  if (ext === '.html') {
    const html = readFileSync(p, 'utf-8').replace('<head>', `<head>${inject}`);
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache',
    });
    res.end(html);
  } else {
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    createReadStream(p).pipe(res);
  }
}).listen(port, '0.0.0.0', () => {
  console.log(
    `[phone-ui] serving ${dir} on http://${lanIp}:${port} → API ${apiBase}`,
  );
});
