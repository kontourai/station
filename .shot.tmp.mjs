import { chromium } from 'playwright';
const [,, path, out, width = '1280', theme = 'dark', action = ''] = process.argv;
const U = 'http://localhost:5620';
const mobile = Number(width) < 500;
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: Number(width), height: mobile ? 844 : 860 },
  storageState: '/tmp/pane-content-run/state.json',
  ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
});
const page = await ctx.newPage();
await page.goto(`${U}${path}`);
await page.waitForTimeout(9000);
await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
const cont = page.getByRole('button', { name: 'Continue Without Setup' });
if (await cont.count()) await cont.first().click().catch(() => {});
for (const step of action.split(',').filter(Boolean)) {
  if (step === 'changes') { await page.getByRole('button', { name: /^Changes vs HEAD/ }).first().click(); await page.waitForTimeout(3000); }
  if (step === 'menu') { await page.getByRole('button', { name: 'More file actions' }).first().click(); await page.waitForTimeout(500); }
  if (step.startsWith('goto:')) { await page.getByRole('button', { name: 'More file actions' }).first().click(); await page.getByRole('menuitem', { name: 'Go to line…' }).click(); await page.getByLabel('Line').fill(step.slice(5)); await page.waitForTimeout(300); }
  if (step === 'gosubmit') { await page.getByRole('button', { name: 'Go', exact: true }).click(); await page.waitForTimeout(800); }
  if (step.startsWith('pr:')) {
    await page.getByRole('tab', { name: /^Diff/ }).first().click().catch(async () => { await page.getByText('Diff', { exact: true }).first().click().catch(() => {}); });
    await page.waitForTimeout(4000);
    await page.getByText(step.slice(3), { exact: false }).first().click();
    await page.waitForTimeout(12000);
  }
  if (step === 'status') { await page.evaluate(() => { const h = [...document.querySelectorAll('h3')].find((x) => x.textContent === 'Status'); let host = h?.parentElement; while (host && host.scrollHeight <= host.clientHeight + 2) host = host.parentElement; if (h && host) host.scrollTop += h.getBoundingClientRect().top - host.getBoundingClientRect().top - 60; }); await page.waitForTimeout(500); }
}
await page.waitForTimeout(1000);
await page.screenshot({ path: out });
console.log(page.url());
await browser.close();
