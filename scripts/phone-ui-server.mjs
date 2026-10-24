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
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { tsImport } from 'tsx/esm/api';

const { uiRequestHandler, UI_MIME_TYPES } = await tsImport(
  new URL('../packages/cli/src/commands/lifecycle.ts', import.meta.url).href,
  import.meta.url,
);
const lanIp = process.env.PHONE_LAN_IP ?? '192.168.50.19';
const port = Number(process.env.PHONE_UI_PORT ?? 3000);
const apiBase = process.env.PHONE_API_BASE ?? `http://${lanIp}:3141`;
const dir =
  process.env.PHONE_UI_DIR ?? path.join(process.cwd(), 'dist-ui-phone');
http
  .createServer(
    uiRequestHandler({
      http,
      crypto,
      fs,
      path,
      dir,
      mime: UI_MIME_TYPES,
      inject: `<script>window.__API_BASE__=${JSON.stringify(apiBase)}</script>`,
      upstreamPort: Number(new URL(apiBase).port || 80),
      backendPrefixes: [],
    }),
  )
  .listen(port, '0.0.0.0', () => {
    console.log(
      `[phone-ui] serving ${dir} on http://${lanIp}:${port} → API ${apiBase}`,
    );
  });
