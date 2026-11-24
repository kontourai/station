/**
 * @vitest-environment jsdom
 *
 * The Customize landing's way to Apps. Apps is not a Customize item, and
 * until the sidebar preview is on by default this note is its standing
 * door, so it must be there with the preview on or off, stay out of the
 * item list, open Apps in place, and be a 44px target on a phone.
 */

import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  chromiumRequired,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';

const flags = vi.hoisted(() => ({ current: new Set<string>() }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk', () => ({
  useAgentsQuery: () => ({ data: [] }),
  useSkillsQuery: () => ({ data: [] }),
}));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flags.current,
}));
vi.mock('../views/connections-hub/connection-section-signals', () => ({
  useConnectionSectionSignals: () => ({
    count: () => null,
    needsAttention: () => false,
  }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));

import { CustomizeLanding } from '../views/customize/CustomizeLanding';

afterEach(() => {
  cleanup();
  navigate.mockReset();
  flags.current = new Set();
});

describe('the Customize landing links to Apps', () => {
  test.each([
    ['off', new Set<string>()],
    ['on', new Set(['quiet-sidebar'])],
  ])('with the sidebar preview %s', (_state, enabled) => {
    flags.current = enabled;
    render(<CustomizeLanding />);

    const apps = screen.getByRole('link', { name: 'Apps' });
    expect(apps.getAttribute('href')).toBe('/apps');
    // A note beside the list, not a seventh item in it.
    expect(apps.closest('ul')).toBeNull();
    expect(apps.closest('p')?.textContent).toBe(
      'Apps finds screens built for one job and manages the ones you added.',
    );
    const items = screen
      .getAllByRole('list')
      .flatMap((list) => within(list).getAllByRole('link'));
    expect(items).toHaveLength(6);

    // A plain link, so Tab reaches it and Enter follows it.
    apps.focus();
    expect(document.activeElement).toBe(apps);
    fireEvent.click(apps);
    expect(navigate).toHaveBeenCalledWith('/apps');
  });

  test('a modified click is left to the browser', () => {
    render(<CustomizeLanding />);
    fireEvent.click(screen.getByRole('link', { name: 'Apps' }), {
      metaKey: true,
    });
    expect(navigate).not.toHaveBeenCalled();
  });
});

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);
if (chromiumRequired() && !chromiumAvailable)
  throw new Error('Chromium is required for this run and is not installed');

// jsdom evaluates no media query and computes no layout: put the rendered
// landing into Chromium with the cascade-resolved stylesheets and measure.
describe.skipIf(!chromiumAvailable)(
  'the Apps link on a phone, in a real engine',
  () => {
    test('is at least 44px tall and 44px wide', async () => {
      const css = ['../index.css', '../views/customize/customize.css']
        .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
        .join('\n');
      assertNoImportsSurvive(css);
      const { container } = render(<CustomizeLanding />);
      const markup = container.innerHTML;
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          hasTouch: true,
        });
        const page = await context.newPage();
        await page.setContent(`<style>${css}</style>${markup}`);
        const target = await page.evaluate(() => {
          const link = document.querySelector('a[href="/apps"]');
          if (!link) throw new Error('the Apps link did not render');
          const box = link.getBoundingClientRect();
          return { height: box.height, width: box.width };
        });
        expect(target.height).toBeGreaterThanOrEqual(44);
        // A one-word link is narrower than the floor unless it is given one.
        expect(target.width).toBeGreaterThanOrEqual(44);
      } finally {
        await browser.close();
      }
    }, 120_000);
  },
);
