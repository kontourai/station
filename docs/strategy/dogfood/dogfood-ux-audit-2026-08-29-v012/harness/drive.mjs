// Generic Station UI driver: runs a step file (JSON array) against a persistent
// Chrome profile so the paired device-session cookie survives across runs.
// Usage: node drive.mjs <steps.json>
// Step kinds:
//  {goto: "/path"} {click: "css"} {clickText: "visible text"} {fill: ["css","value"]}
//  {press: "Enter"} {wait: ms} {shot: "name"} {eval: "js"} {viewport:[w,h]}
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const AUDIT = new URL('.', import.meta.url).pathname;
const SHOTS = AUDIT + 'shots/';
mkdirSync(SHOTS, { recursive: true });
const steps = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const base = process.env.DRIVE_BASE || 'http://localhost:18500';

const ctx = await chromium.launchPersistentContext(AUDIT + (process.env.DRIVE_PROFILE || 'chrome-profile'), {
  headless: true,
  viewport: { width: 1440, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const consoleLines = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning')
    consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 300)}`));

for (const step of steps) {
  try {
    if (step.goto) {
      await page.goto(step.goto.startsWith('http') ? step.goto : base + step.goto, {
        waitUntil: 'load',
        timeout: 20000,
      });
      await page.waitForTimeout(step.settle ?? 1200);
    } else if (step.click) {
      await page.locator(step.click).first().click({ timeout: 8000 });
      await page.waitForTimeout(step.settle ?? 800);
    } else if (step.clickText) {
      await page.getByText(step.clickText, { exact: step.exact ?? false }).first().click({ timeout: 8000 });
      await page.waitForTimeout(step.settle ?? 800);
    } else if (step.clickRole) {
      const [role, name, idx] = step.clickRole;
      await page.getByRole(role, { name, exact: step.exact ?? false }).nth(idx ?? 0).click({ timeout: 8000 });
      await page.waitForTimeout(step.settle ?? 800);
    } else if (step.clickNear) {
      const [containerText, buttonName] = step.clickNear;
      await page
        .locator(`div:has-text("${containerText}")`)
        .last()
        .getByRole('button', { name: buttonName })
        .first()
        .click({ timeout: 8000 });
      await page.waitForTimeout(step.settle ?? 800);
    } else if (step.fill) {
      await page.locator(step.fill[0]).first().fill(step.fill[1], { timeout: 8000 });
    } else if (step.press) {
      await page.keyboard.press(step.press);
      await page.waitForTimeout(step.settle ?? 500);
    } else if (step.wait) {
      await page.waitForTimeout(step.wait);
    } else if (step.viewport) {
      await page.setViewportSize({ width: step.viewport[0], height: step.viewport[1] });
    } else if (step.eval) {
      const r = await page.evaluate(step.eval);
      console.log('EVAL:', JSON.stringify(r)?.slice(0, 2000));
    } else if (step.shot) {
      await page.screenshot({ path: SHOTS + step.shot + '.png', fullPage: step.full ?? false });
      console.log('SHOT:', step.shot, '| url:', page.url());
    }
  } catch (e) {
    console.log('STEP-FAIL:', JSON.stringify(step).slice(0, 120), '->', String(e).split('\n')[0]);
    try {
      await page.screenshot({ path: SHOTS + 'fail-' + steps.indexOf(step) + '.png' });
    } catch {}
  }
}
if (consoleLines.length) {
  console.log('CONSOLE (errors/warnings, deduped):');
  for (const l of [...new Set(consoleLines)].slice(0, 40)) console.log(' ', l);
}
await ctx.close();
