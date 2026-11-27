/**
 * Real-browser evidence for script execution in the visual-reply viewer,
 * the surface html_render publishes into (station#4821 residual).
 *
 * Three facts, one engine (Chromium, 390px phone viewport):
 *
 * 1. Through the production proxy chain — outer sandboxed frame, the frame
 *    server's exact headers, the proxy bootstrap, and the nested sandboxed
 *    srcdoc — inline scripts run exactly like headless preview. Same-machine
 *    browser viewers and preview do not differ in script policy.
 *
 * 2. The #4821 srcdoc fallback, mounted inside a document carrying the Tauri
 *    shell's CSP, inherits that policy: static markup and styles render but
 *    script-driven DOM stays missing, with the refusal on the record. This is
 *    the phone viewer's blank dashboard — reproduced, not assumed.
 *
 * 3. Delivering the same page document as a real (non-local-scheme) response
 *    — what the shell's staged `station-html-reply:` scheme serves — runs the
 *    scripts under that same parent CSP. The delivery scheme, not a policy
 *    change, is what restores the dashboard.
 */

import { resolve } from 'node:path';
import { buildHtmlReplyProxyDocument } from '@kontourai/station-shared/html-reply-document';
import { chromium, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { expect, test } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Origin standing in for the shell's staged `station-html-reply:` scheme: a
 * real cross-origin document response. Routed rather than a loopback server,
 * because Chromium's local-network-access rules refuse to let a non-loopback
 * page frame 127.0.0.1 — an unrelated block that would mask the CSP behavior.
 */
const STAGED_ORIGIN = 'http://staged.test';

/** A page with static markup plus script-written values, like a dashboard. */
const DASHBOARD_HTML = `<!doctype html><html><head><style>.tile{border:1px solid #888;display:inline-block;padding:8px}</style></head><body>
<p id="probe">static</p>
<div id="dash"></div>
<script>
document.getElementById('probe').textContent = 'SCRIPT-RAN-42';
for (let i = 0; i < 4; i++) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.id = 'tile-' + i;
  tile.textContent = 'tile ' + i;
  document.getElementById('dash').appendChild(tile);
}
</script>
</body></html>`;

const MINIMAL_HTML =
  "<p id=\"known\">static</p><script>document.getElementById('known').textContent='KNOWN-STRING-OK';</script>";

/** The Tauri shell's own policy (tauri.conf.json app.security.csp), as a meta. */
const TAURI_SHELL_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' station-plugin:",
  "style-src 'self' 'unsafe-inline' station-plugin:",
  "img-src 'self' asset: http://asset.localhost data: blob: http: https:",
  "font-src 'self' data:",
  "connect-src 'self' ipc: http://ipc.localhost http: https: ws: wss:",
  "frame-src 'self' data: blob: http: https: station-html-reply:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

async function bundle(componentSource: string): Promise<string> {
  const result = await build({
    stdin: {
      contents: componentSource,
      loader: 'tsx',
      resolveDir: ROOT,
    },
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    write: false,
    outdir: '/virtual',
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  return result.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
}

type ViewerFixture = {
  page: Page;
  /** Console texts recording the parent CSP's refusals. */
  refusals: string[];
  close: () => Promise<void>;
};

/**
 * Serve the app document at http://station.test/ — optionally under the
 * shell CSP — plus the frame-listener origins the viewer may frame. CSP
 * refusal console messages are collected for positive evidence.
 */
async function viewerFixture(options: {
  javascript: string;
  shellCsp: boolean;
  frameOriginProxy: boolean;
  /** A page document served as a real response from its own origin. */
  stagedDocument?: string;
}): Promise<ViewerFixture> {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  const refusals: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    // Chromium's console text spells the policy name with spaces.
    if (/Content[- ]Security[- ]Policy/i.test(text)) refusals.push(text);
  });
  await page.route('http://station.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') {
      const csp = options.shellCsp
        ? `<meta http-equiv="Content-Security-Policy" content="${TAURI_SHELL_CSP.replaceAll('"', '&quot;')}">`
        : '';
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta charset="utf-8">${csp}</head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
      });
    }
    if (path === '/fixture.js')
      return route.fulfill({
        contentType: 'text/javascript',
        body: options.javascript,
      });
    return route.abort();
  });
  if (options.frameOriginProxy) {
    await page.route('http://frame.test/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/html-reply/frame')
        return route.fulfill({
          contentType: 'text/html',
          headers: {
            'content-security-policy':
              "frame-ancestors http://station.test; frame-src 'none'",
            'x-frame-options': 'SAMEORIGIN',
            'referrer-policy': 'no-referrer',
          },
          body: buildHtmlReplyProxyDocument(['http://station.test']),
        });
      return route.abort();
    });
  }
  if (options.stagedDocument !== undefined) {
    const body = options.stagedDocument;
    await page.route(`${STAGED_ORIGIN}/**`, (route) =>
      new URL(route.request().url()).pathname === '/staged-document'
        ? route.fulfill({
            contentType: 'text/html',
            headers: { 'cache-control': 'no-store' },
            body,
          })
        : route.abort(),
    );
  }
  await page.goto('http://station.test/');
  return {
    page,
    refusals,
    close: async () => {
      await browser.close();
    },
  };
}

test('the proxy viewer runs inline scripts like preview does, at phone width', async () => {
  const javascript = await bundle(`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {HtmlReply} from './src-ui/src/components/chat/HtmlReply';
    createRoot(document.getElementById('root')).render(
      <>
        <HtmlReply page={{version:1, html: ${JSON.stringify(DASHBOARD_HTML)}, height: 300}} frameOrigin="http://frame.test" theme="dark" />
        <HtmlReply page={{version:1, html: ${JSON.stringify(MINIMAL_HTML)}, height: 120}} frameOrigin="http://frame.test" theme="dark" />
      </>
    );
  `);
  const fixture = await viewerFixture({
    javascript,
    shellCsp: false,
    frameOriginProxy: true,
  });
  try {
    // The proxy handshake plus the nested frame need a real load cycle. Each
    // probe is bounded: absent elements must not hold the poll open for
    // Playwright's default element timeout. The two mounts carry independent
    // markers — the dashboard's script-built tiles and the minimal page's
    // known string — so each frame is checked for its own.
    let dashboard: { tiles: number; first: string | null } | null = null;
    await expect
      .poll(
        async () => {
          let minimal: string | null = null;
          let built: { tiles: number; first: string | null } | null = null;
          for (const frame of fixture.page.frames()) {
            const known = await frame
              .locator('#known')
              .textContent({ timeout: 500 })
              .catch(() => null);
            if (known === 'KNOWN-STRING-OK') minimal = known;
            const probe = await frame
              .locator('#probe')
              .textContent({ timeout: 500 })
              .catch(() => null);
            if (probe !== 'SCRIPT-RAN-42') continue;
            built = {
              tiles: await frame.locator('.tile').count(),
              first: await frame
                .locator('#tile-0')
                .textContent({ timeout: 500 })
                .catch(() => null),
            };
          }
          dashboard = minimal !== null ? built : null;
          return dashboard;
        },
        { timeout: 15_000, interval: 1_000 },
      )
      .not.toBeNull();
    // The minimal page shows its known string and the dashboard's tiles were
    // all built by script — the preview-parity claims of the task.
    expect(dashboard).toEqual({ tiles: 4, first: 'tile 0' });
  } finally {
    await fixture.close();
  }
});

test('the srcdoc fallback under the shell CSP keeps static markup but refuses scripts', async () => {
  const javascript = await bundle(`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {HtmlReply} from './src-ui/src/components/chat/HtmlReply';
    createRoot(document.getElementById('root')).render(
      <HtmlReply page={{version:1, html: ${JSON.stringify(DASHBOARD_HTML)}, height: 300}} frameOrigin="" theme="dark" />
    );
  `);
  const fixture = await viewerFixture({
    javascript,
    shellCsp: true,
    frameOriginProxy: false,
  });
  try {
    // The refusal is on the record before any assertion about content.
    // Chromium 158 words it "Executing inline script violates ..."; older
    // builds said "Refused to execute inline script".
    await expect
      .poll(
        () =>
          fixture.refusals.some(
            (text) =>
              /inline script violates/i.test(text) ||
              /Refused to execute inline script/i.test(text),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    const frame = fixture.page
      .frames()
      .find((candidate) => candidate.url() === 'about:srcdoc');
    expect(frame).toBeDefined();
    // Static markup survives the inherited policy...
    expect(await frame!.locator('#probe').textContent()).toBe('static');
    // ...and the script never built the dashboard.
    expect(await frame!.locator('.tile').count()).toBe(0);
  } finally {
    await fixture.close();
  }
});

test('a scheme-delivered document runs scripts under the same shell CSP', async () => {
  // No component here: this pins the mechanism the staged scheme delivers —
  // a real cross-origin document response inside the sandboxed frame.
  const javascript = await bundle(`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    createRoot(document.getElementById('root')).render(
      <iframe
        title="Staged visual reply"
        sandbox="allow-scripts"
        src="${STAGED_ORIGIN}/staged-document"
        style={{width: '100%', height: 300, border: 0}}
      />
    );
  `);
  const fixture = await viewerFixture({
    javascript,
    shellCsp: true,
    frameOriginProxy: false,
    stagedDocument: DASHBOARD_HTML,
  });
  try {
    // The sandboxed frame's document needs its load cycle.
    await expect
      .poll(
        () =>
          fixture.page
            .frames()
            .some((candidate) =>
              candidate.url().startsWith(`${STAGED_ORIGIN}/staged-document`),
            ),
        { timeout: 15_000, interval: 500 },
      )
      .toBe(true);
    const frame = fixture.page
      .frames()
      .find((candidate) =>
        candidate.url().startsWith(`${STAGED_ORIGIN}/staged-document`),
      );
    // The inline script finishes during parse, so after the frame commits
    // its result is either present or never coming; poll only the load.
    await expect
      .poll(
        () =>
          frame!
            .locator('#probe')
            .textContent({ timeout: 500 })
            .catch(() => null),
        {
          timeout: 15_000,
          interval: 500,
        },
      )
      .toBe('SCRIPT-RAN-42');
    expect(await frame!.locator('.tile').count()).toBe(4);
    expect(await frame!.locator('#tile-3').textContent()).toBe('tile 3');
  } finally {
    await fixture.close();
  }
});
