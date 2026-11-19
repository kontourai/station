import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

/**
 * #4692: the density tokens as Chromium applies them from the real index.css,
 * where the shared kit's own `:root { --k-text-sm }` loads after tokens.css.
 * Comfortable (13px) is the default with no attribute and with
 * `data-density="comfortable"`; Compact keeps the sizes Station used before
 * (a 12px `--text-base` and the kit's 12.5px `--k-text-sm`). Reduced motion
 * collapses the motion tokens. The real startup script stamps both choices
 * before first paint.
 */
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const KIT_TEXT_SM = (() => {
  const kit = readFileSync(
    resolve(REPO_ROOT, 'node_modules/@kontourai/ui/tokens/tokens.css'),
    'utf8',
  );
  const match = /--k-text-sm:\s*([\d.]+)px/.exec(kit);
  if (!match) throw new Error('@kontourai/ui tokens.css has no --k-text-sm');
  return Number(match[1]);
})();
const STARTUP_SCRIPT = readFileSync(
  resolve(REPO_ROOT, 'src-ui/public/startup-theme.js'),
  'utf8',
);

const fixture = `
const probe = (name, size) => {
  const element = document.createElement('span');
  element.dataset.probe = name;
  element.style.fontSize = size;
  element.textContent = name;
  document.getElementById('root').append(element);
};
probe('base', 'var(--text-base)');
probe('body', 'var(--k-text-sm)');
probe('label', 'var(--text-xs)');
`;

test('#4692: Comfortable is the 13px default; Compact keeps the 12px and 12.5px sizes; Reduced motion collapses motion', async () => {
  // The kit's own value is what Compact must keep matching.
  expect(KIT_TEXT_SM).toBe(12.5);
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    await page.locator('[data-probe="base"]').waitFor();
    const measure = (density: string | null, motion: string | null = null) =>
      page.evaluate(
        ([d, m]) => {
          const root = document.documentElement;
          if (d === null) root.removeAttribute('data-density');
          else root.setAttribute('data-density', d);
          if (m === null) root.removeAttribute('data-motion');
          else root.setAttribute('data-motion', m);
          const size = (name: string) =>
            Number.parseFloat(
              getComputedStyle(
                document.querySelector(`[data-probe="${name}"]`)!,
              ).fontSize,
            );
          return {
            base: size('base'),
            body: size('body'),
            label: size('label'),
            motion: getComputedStyle(root)
              .getPropertyValue('--motion-base')
              .trim(),
          };
        },
        [density, motion] as const,
      );

    const comfortable = { base: 13, body: 13, label: 12 };
    expect(await measure(null)).toMatchObject(comfortable);
    expect(await measure('comfortable')).toMatchObject(comfortable);
    // An unknown value (a newer client's density) reads as the default.
    expect(await measure('roomy')).toMatchObject(comfortable);
    expect(await measure('compact')).toMatchObject({
      base: 12,
      body: KIT_TEXT_SM,
      label: 12,
    });

    expect((await measure('compact')).motion).toBe('0.2s');
    expect((await measure('compact', 'reduce')).motion).toBe('0.01ms');

    // The startup script stamps the saved choices before first paint.
    const stamped = (values: Record<string, unknown> | null) =>
      page.evaluate(
        ([script, saved]) => {
          const root = document.documentElement;
          root.removeAttribute('data-density');
          root.removeAttribute('data-motion');
          localStorage.clear();
          if (saved)
            localStorage.setItem(
              'station-device-settings-v1',
              JSON.stringify({ version: 1, values: saved }),
            );
          new Function(script)();
          return {
            density: root.getAttribute('data-density'),
            motion: root.getAttribute('data-motion'),
          };
        },
        [STARTUP_SCRIPT, values] as const,
      );
    expect(await stamped(null)).toEqual({
      density: 'comfortable',
      motion: null,
    });
    expect(await stamped({ density: 'compact', motion: 'reduce' })).toEqual({
      density: 'compact',
      motion: 'reduce',
    });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
