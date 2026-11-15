import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const HOME = '/private/var/folders/zz/8n7yx67d751dfk33tz367rxm0000gn/T/station/dev-home-3xXPaJ';
const UI = 'http://127.0.0.1:5494';
const OUT = '/tmp/custom-appearance-shots';
const secret = readFileSync(`${HOME}/runtime/local-grant.secret`, 'utf8').trim();
async function pair(context) {
  const mint = await fetch('http://127.0.0.1:3462/.well-known/station/v1/pairing/mint-ui-bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret }) });
  const { token } = await mint.json();
  const page = await context.newPage();
  const exchange = page.waitForResponse((r) => r.url().endsWith('/pairing/ui-bootstrap') && r.request().method() === 'POST', { timeout: 30000 });
  await page.goto(`${UI}/#station-ui-bootstrap=${token}`, { waitUntil: 'load' });
  if ((await exchange).status() !== 200) throw new Error('pair failed');
  await page.waitForTimeout(2500);
  return page;
}
const api = (page, method, path, body, agent = false) => page.evaluate(async ({ method, path, body, agent }) => {
  const res = await fetch(path, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(agent ? { 'x-station-control-origin': 'agent-tool' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}, { method, path, body, agent });

const browser = await chromium.launch();
const log = (...a) => console.log(...a);
for (const scheme of ['dark', 'light']) {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 }, colorScheme: scheme, deviceScaleFactor: 1 });
    const page = await pair(context);
    // Reset, then: the person saves a palette; an agent proposes CSS.
    let doc = (await api(page, 'GET', '/api/me/appearance')).json.data;
    doc = (await api(page, 'PUT', '/api/me/appearance', { revision: doc.revision, appearance: null })).json.data;
    if (doc.proposal) doc = (await api(page, 'DELETE', '/api/me/appearance/proposal', { revision: doc.revision })).json.data;
    const saved = await api(page, 'PUT', '/api/me/appearance', { revision: doc.revision, appearance: { version: 1, name: 'Harbor', palette: { dark: { accent: '#7cc4ff' }, light: { accent: '#1d5f99' } }, css: '' } });
    log(scheme, width, 'save', saved.status);
    doc = saved.json.data;
    const proposed = await api(page, 'POST', '/api/me/appearance/proposal', { revision: doc.revision, appearance: { version: 1, name: 'Rounded harbor', palette: { dark: { accent: '#ffb86b', roles: { '--k-bg': '#0d1117' } }, light: { accent: '#9a4b00' } }, css: '[data-surface="sidebar"] { border-right: 3px solid var(--k-action); }\n[data-slot="button"] { border-radius: 999px; }\n[data-surface="composer"] { box-shadow: 0 0 0 2px var(--k-action); }' } }, true);
    log(scheme, width, 'agent propose', proposed.status);
    const refusedKeep = await api(page, 'POST', '/api/me/appearance/proposal/keep', { revision: proposed.json.data.revision, proposalId: proposed.json.data.proposal.id }, true);
    log(scheme, width, 'agent keep (expect 403)', refusedKeep.status, refusedKeep.json?.code);
    await page.goto(`${UI}/appearance`, { waitUntil: 'load' });
    const section = page.locator('section.appearance-custom');
    await section.waitFor({ timeout: 20000 });
    await page.waitForTimeout(1500);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/appearance-${scheme}-${width}.png`, fullPage: false });
    await section.screenshot({ path: `${OUT}/custom-section-${scheme}-${width}.png` });
    // Preview the agent's proposal: the keep bar appears.
    await section.getByRole('button', { name: 'Preview' }).click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/preview-bar-${scheme}-${width}.png`, fullPage: false });
    const report = await api(page, 'GET', '/api/me/appearance');
    log(scheme, width, 'report hooks', JSON.stringify(report.json.data.renderReport?.hooks?.map((h) => `${h.id}:${h.matched}`)), 'contrast fails', report.json.data.renderReport?.contrast?.filter((c) => !c.pass).length);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await context.close();
  }
}
// Hostile preview: the page made invisible; the bar stays and Keep is off.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await pair(context);
  let doc = (await api(page, 'GET', '/api/me/appearance')).json.data;
  const p = await api(page, 'POST', '/api/me/appearance/proposal', { revision: doc.revision, appearance: { version: 1, name: 'Hostile', palette: {}, css: 'html { opacity: 0 !important; }\nbody::after { content: ""; position: fixed; inset: 0; z-index: 2147483647; }\nstation-appearance-preview { display: none !important; }' } }, true);
  log('hostile propose', p.status);
  await page.goto(`${UI}/appearance`, { waitUntil: 'load' });
  const section = page.locator('section.appearance-custom');
  await section.waitFor({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await section.getByRole('button', { name: 'Preview' }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/preview-bar-hostile-dark-1440.png` });
  await page.keyboard.press('Escape');
  await context.close();
}
await browser.close();
