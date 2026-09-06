import { describe, expect, test } from 'vitest';
import {
  evaluateFixturePolicy,
  fixturePolicyCommands,
  inspectBrowserFixture,
} from '../test-fixture-policy.mjs';

const file = 'tests/legacy.spec.ts';
const inspect = (source: string) => inspectBrowserFixture(source, file);

describe('browser fixture syntax policy', () => {
  test.each([
    ['await button.click({ force: true });', 'forced-user-action'],
    ["await button.fill('x', { force: true });", 'forced-user-action'],
    ["await button.dispatchEvent('click');", 'synthetic-click'],
    [
      "await button.evaluate(el => el.removeAttribute('disabled'));",
      'removes-interaction-guard',
    ],
    [
      "await page.evaluate(() => document.querySelector('button').click());",
      'dom-click-bypasses-actionability',
    ],
    [
      "await button.evaluate(el => el.dispatchEvent(new MouseEvent('click', {bubbles:true})));",
      'synthetic-click',
    ],
    [
      'if (!(await toggle.isVisible().catch(() => false))) return;',
      'visibility-short-circuit',
    ],
    [
      "page.route('**/api/**', route => { if (known) return; return route.fulfill(json({success:true,data:[]})); });",
      'unmodeled-success-fallback',
    ],
  ])('catches the known-bad pattern: %s', (source, rule) => {
    expect(inspect(source).map((entry) => entry.rule)).toEqual([rule]);
  });

  test('does not confuse filesystem cleanup, polling success, provider events, or explicit endpoint reads with UI bypasses', () => {
    expect(
      inspect(`
      rmSync(path, {force:true});
      if (await shell.isVisible()) return;
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message')));
      page.route('**/api/projects', route => { return route.fulfill(json({success:true,data:[]})); });
      await button.click();
      // await button.click({force:true});
      const documentation = "button.dispatchEvent('click')";
    `),
    ).toEqual([]);
  });

  test('legacy baselines cannot admit a strict-file bypass or grow after introduction', () => {
    const [finding] = inspect('button.click({force:true})');
    const baseline = {
      entries: [{ ...finding, reason: 'legacy-unqualified' }],
    };
    expect(evaluateFixturePolicy([finding], baseline).errors).toEqual([]);
    expect(
      evaluateFixturePolicy([finding], baseline, { entries: [] }).errors,
    ).toContain(`New bypass cannot be baselined: ${file} forced-user-action`);
    expect(evaluateFixturePolicy([], baseline).errors).toHaveLength(1);
    const strict = { ...finding, file: 'tests/settings.spec.ts' };
    expect(
      evaluateFixturePolicy([strict], {
        entries: [{ ...strict, reason: 'legacy-unqualified' }],
      }).errors,
    ).toHaveLength(1);
  });

  test('routes relevant agent changes to the executable check and its guide', () => {
    expect(fixturePolicyCommands(['tests/helpers/example.ts'])).toContain(
      'npm run test:fixtures:guard',
    );
    expect(fixturePolicyCommands(['src-server/main.ts'])).toEqual([]);
  });
});

test('removing a disabled guard in browser evaluation is an interaction bypass', () => {
  expect(
    inspectBrowserFixture(
      "await textarea.evaluate(el => el.removeAttribute('disabled'));",
      'tests/settings.spec.ts',
    ).map((entry) => entry.rule),
  ).toEqual(['removes-interaction-guard']);
});

test('catches assertions skipped when a browser storage observation is absent', () => {
  expect(
    inspect(`const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('settings')));
    if (stored) { expect(stored).toHaveProperty('enabled'); }`).map(
      (entry) => entry.rule,
    ),
  ).toEqual(['optional-storage-assertions']);
});

test('allows unconditional storage assertions and explicit absent-state expectations', () => {
  expect(
    inspect(`const stored = await page.evaluate(() => localStorage.getItem('settings'));
    expect(stored).not.toBeNull();
    if (stored) { await use(stored); }
    if (stored) { expect(stored).toBe('value'); } else { expect(emptyState).toBeVisible(); }
    const prose = "if (stored) expect(stored)";`),
  ).toEqual([]);
});

test('does not confuse a shadowed local name with a storage observation', () => {
  expect(
    inspect(`const stored = localStorage.getItem('x');
    function verify(stored) { if (stored) { expect(stored).toBe(true); } }
    function another() { const stored = options.enabled; if (stored) { expect(stored).toBe(true); } }`),
  ).toEqual([]);
});

test('rejects deleting the setup reminder to bypass an obstructed user action', () => {
  expect(
    inspect(
      `await page.evaluate(() => document.querySelector('[data-testid="setup-launcher"]')?.remove());`,
    ).map((entry) => entry.rule),
  ).toEqual(['removes-setup-launcher']);
  expect(
    inspect(
      `await page.evaluate(() => document.querySelector('#temporary-measurement')?.remove());`,
    ),
  ).toEqual([]);
});
