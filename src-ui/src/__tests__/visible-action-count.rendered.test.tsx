/**
 * @vitest-environment jsdom
 *
 * #3045 — the rendered half of the two-action cap, proved in a real engine.
 *
 * `tests/helpers/visible-action-count.ts` counts the labelled buttons a page
 * actually shows per row. A counter is only worth having if it REJECTS, and
 * if what it counts follows the cascade rather than the markup — so this
 * loads fixtures into Chromium and asserts both: a row of three is reported
 * with its labels, and the SAME markup conforms at a width where CSS hides
 * one of them (which the static scan in scripts/button-cap-ratchet.mjs can
 * never see).
 *
 * The last case is the real `ActionRow`, rendered here and laid out by the
 * real stylesheet.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import {
  actionRowsOverCap,
  visibleLabelledActions,
} from '../../../tests/helpers/visible-action-count';
import { ActionRow } from '../components/ActionRow';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

const FIXTURE_CSS = `
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  @media (max-width: 500px) { .wide-only { display: none; } }
`;

const page = (body: string, css = FIXTURE_CSS) =>
  `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`;

describe.skipIf(!chromiumAvailable)(
  'visible labelled actions per row (#3045)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    async function open(html: string, width: number) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
      });
      const tab = await context.newPage();
      await tab.setContent(html);
      return { tab, close: () => context.close() };
    }

    test('reports a row of three labelled buttons, with its labels', async () => {
      const { tab, close } = await open(
        page(`<div role="toolbar" class="skill-header">
          <button>Duplicate</button><button>Export</button><button>Save</button>
        </div>`),
        1280,
      );
      try {
        expect(await actionRowsOverCap(tab)).toEqual([
          {
            container: 'div.skill-header',
            labels: ['Duplicate', 'Export', 'Save'],
          },
        ]);
      } finally {
        await close();
      }
    });

    test('icon buttons, menu triggers, choices and menu rows are not counted', async () => {
      const { tab, close } = await open(
        page(`<div role="toolbar">
          <button>Test</button><button>Save</button>
          <button aria-label="Refresh"><svg width="16" height="16"></svg></button>
          <button aria-label="Zoom in">+</button>
          <button><span class="sr-only">Hidden name</span><svg width="16" height="16"></svg></button>
          <button aria-haspopup="menu" aria-label="More actions">More</button>
          <button aria-pressed="true">Board</button>
          <div role="menu"><button role="menuitem">Export</button><button role="menuitem">Remove</button></div>
        </div>`),
        1280,
      );
      try {
        expect(await visibleLabelledActions(tab)).toEqual([
          { container: 'div', labels: ['Test', 'Save'] },
        ]);
        expect(await actionRowsOverCap(tab)).toEqual([]);
      } finally {
        await close();
      }
    });

    test('only a menu-opening aria-haspopup exempts a labelled button', async () => {
      const { tab, close } = await open(
        page(`<div role="toolbar">
          <button aria-haspopup="menu">More</button>
          <button aria-haspopup="true">Options</button>
          <button aria-haspopup="listbox">Choose</button>
          <button aria-haspopup="dialog">Settings</button>
          <button aria-haspopup="false">Plain</button>
          <button>Save</button>
        </div>`),
        1280,
      );
      try {
        expect(await actionRowsOverCap(tab)).toEqual([
          { container: 'div', labels: ['Settings', 'Plain', 'Save'] },
        ]);
      } finally {
        await close();
      }
    });

    test('counts what the cascade shows: the same markup fails wide and conforms narrow', async () => {
      const html = page(`<header class="pane-header">
        <button>Open</button><button>Share</button><button class="wide-only">Export</button>
      </header>`);
      const wide = await open(html, 1280);
      const narrow = await open(html, 390);
      try {
        expect((await actionRowsOverCap(wide.tab)).length).toBe(1);
        expect(await actionRowsOverCap(narrow.tab)).toEqual([]);
      } finally {
        await wide.close();
        await narrow.close();
      }
    });

    test('a toolbar inside a header is counted once, as itself', async () => {
      const { tab, close } = await open(
        page(`<header><button>Back</button>
          <div role="toolbar"><button>One</button><button>Two</button></div>
        </header>`),
        1280,
      );
      try {
        expect(await visibleLabelledActions(tab)).toEqual([
          { container: 'header', labels: ['Back'] },
          { container: 'div', labels: ['One', 'Two'] },
        ]);
      } finally {
        await close();
      }
    });

    test('the real ActionRow shows two labelled actions with its menu closed and open', async () => {
      render(
        <ActionRow
          overflowLabel="More skill actions"
          secondary={<button type="button">Test</button>}
          primary={<button type="button">Save</button>}
          overflow={[
            { key: 'a', label: 'Duplicate', onSelect: () => {} },
            { key: 'b', label: 'Export', onSelect: () => {} },
            { key: 'c', label: 'Remove', tone: 'danger', onSelect: () => {} },
          ]}
        />,
      );
      const css = `${resolveCssImports(resolve(HERE, '../index.css'))}\n${resolveCssImports(resolve(HERE, '../components/ActionRow.css'))}\n${resolveCssImports(resolve(HERE, '../components/ActionOverflowMenu.css'))}`;
      const closed = page(document.body.innerHTML, css);
      fireEvent.click(
        screen.getByRole('button', { name: 'More skill actions' }),
      );
      const opened = page(document.body.innerHTML, css);
      cleanup();

      for (const html of [closed, opened]) {
        const { tab, close } = await open(html, 390);
        try {
          expect(await visibleLabelledActions(tab, '.action-row')).toEqual([
            { container: 'div.action-row', labels: ['Test', 'Save'] },
          ]);
        } finally {
          await close();
        }
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'visible action count — Chromium not installed, cannot verify (#3045)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the rendered ' +
        'action count could not be exercised — this is a missing precondition, ' +
        'not a passing check. Install it with `npm run install:playwright` and ' +
        're-run.',
    );
  },
);
