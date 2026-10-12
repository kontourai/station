/**
 * @vitest-environment jsdom
 *
 * A glyph icon (an emoji or symbol) scales with the icon box for EVERY
 * BrandIcon caller, agents included. Before, `.brand-icon__glyph` was a
 * percentage of the inherited text size, so an agent's emoji drew at the
 * same ~9px in a 16px tile and a 48px tile; #3366 fixed it for projects only.
 *
 * jsdom resolves neither `var()` nor `calc()`, so the markup is measured in
 * Chromium with the real stylesheets.
 */

import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';
import { ConnectionIcon } from '../../acp-connections/ConnectionIcon';
import { AgentIcon } from '../AgentIcon';
import { ProjectIcon } from '../ProjectIcon';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../../');
const css = ['../../../index.css', '../BrandIcon.css', '../ProjectIcon.css']
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');
assertNoImportsSurvive(css);

/** The glyph's share of its box: the same 72% the bundled SVG marks use. */
const GLYPH_SHARE = 0.72;
const SIZES = [16, 48] as const;

/** Every case sits in 13px ambient text, the size a row's meta line uses. */
function markup(): string {
  const { container, unmount } = render(
    <div style={{ fontSize: '13px' }}>
      {SIZES.map((size) => (
        <span key={size}>
          <span data-case={`agent-${size}`}>
            <AgentIcon
              agent={{ name: 'Helper', slug: 'helper', icon: '🤖' }}
              size={size}
            />
          </span>
          <span data-case={`project-${size}`}>
            <ProjectIcon
              project={{ name: 'Station', icon: '🧭' }}
              size={size}
            />
          </span>
        </span>
      ))}
    </div>,
  );
  const html = container.innerHTML;
  unmount();
  cleanup();
  return html;
}

/**
 * Engine registry defaults (`src-server/providers/llm/defaults.ts`) are text
 * glyphs, some of two letters, drawn through `ConnectionIcon` at 32px on the
 * ACP connection card and 22px elsewhere. Two letters at the single-glyph
 * share overflow the tile ("MV" measured 34px wide in a 32px box).
 */
const TEXT_CASES = [
  { icon: 'GH', size: 32 },
  { icon: 'MV', size: 32 },
  { icon: 'GH', size: 22 },
  { icon: 'MV', size: 22 },
  // One letter and one ZWJ emoji are each a single grapheme: full share.
  { icon: 'C', size: 32 },
  { icon: '👩‍💻', size: 32 },
] as const;

function textMarkup(): string {
  const { container, unmount } = render(
    <div style={{ fontSize: '13px' }}>
      {TEXT_CASES.map(({ icon, size }) => (
        <span key={`${icon}-${size}`} data-case={`${icon}-${size}`}>
          <ConnectionIcon icon={icon} name="Engine" size={size} />
        </span>
      ))}
    </div>,
  );
  const html = container.innerHTML;
  unmount();
  cleanup();
  return html;
}

describe.skipIf(!chromiumIsInstalled(REPO_ROOT))(
  'BrandIcon glyph sizing',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    test('an agent glyph and a project glyph both scale with the icon box, not the text around it', async () => {
      const html = markup();
      // The fixture contains what it claims to measure.
      expect(html.match(/class="brand-icon__glyph/g)?.length).toBe(
        SIZES.length * 2,
      );
      const pg = await browser.newPage();
      try {
        await pg.setContent(
          `<!doctype html><html data-theme="dark"><head><style>${css}</style></head><body>${html}</body></html>`,
        );
        const measured = await pg.evaluate(() =>
          Object.fromEntries(
            [...document.querySelectorAll<HTMLElement>('[data-case]')].map(
              (el) => {
                const glyph = el.querySelector('.brand-icon__glyph');
                const box = el.querySelector('.brand-icon');
                return [
                  el.dataset.case,
                  {
                    fontSize: glyph
                      ? Number.parseFloat(getComputedStyle(glyph).fontSize)
                      : null,
                    glyphHeight: glyph?.getBoundingClientRect().height ?? null,
                    boxHeight: box?.getBoundingClientRect().height ?? null,
                  },
                ];
              },
            ),
          ),
        );
        for (const size of SIZES) {
          for (const kind of ['agent', 'project']) {
            const entry = measured[`${kind}-${size}`];
            expect(entry?.fontSize, `${kind} glyph at ${size}px`).toBeCloseTo(
              size * GLYPH_SHARE,
              2,
            );
            // Drawn inside its box, not spilling over the row.
            expect(entry?.glyphHeight ?? Infinity).toBeLessThanOrEqual(
              entry?.boxHeight ?? 0,
            );
          }
        }
        // The invariant, independent of the share: a box three times as big
        // draws a glyph three times as big.
        expect(
          (measured['agent-48']?.fontSize ?? 0) /
            (measured['agent-16']?.fontSize ?? 1),
        ).toBeCloseTo(3, 5);
      } finally {
        await pg.close();
      }
    });

    test('a multi-letter text glyph fits inside its tile; a single grapheme keeps the full share', async () => {
      const html = textMarkup();
      expect(html.match(/class="brand-icon__glyph/g)?.length).toBe(
        TEXT_CASES.length,
      );
      const pg = await browser.newPage();
      try {
        await pg.setContent(
          `<!doctype html><html data-theme="dark"><head><style>${css}</style></head><body>${html}</body></html>`,
        );
        const measured = await pg.evaluate(() =>
          Object.fromEntries(
            [...document.querySelectorAll<HTMLElement>('[data-case]')].map(
              (el) => {
                const glyph = el.querySelector('.brand-icon__glyph');
                const box = el.querySelector<HTMLElement>('.brand-icon');
                const rect = glyph?.getBoundingClientRect();
                return [
                  el.dataset.case,
                  {
                    fontSize: glyph
                      ? Number.parseFloat(getComputedStyle(glyph).fontSize)
                      : null,
                    glyphWidth: rect?.width ?? null,
                    glyphHeight: rect?.height ?? null,
                    // Inside the border: what the tile can show unclipped.
                    innerWidth: box?.clientWidth ?? 0,
                    innerHeight: box?.clientHeight ?? 0,
                  },
                ];
              },
            ),
          ),
        );
        for (const { icon, size } of TEXT_CASES) {
          const entry = measured[`${icon}-${size}`];
          const label = `"${icon}" at ${size}px`;
          expect(entry?.glyphWidth ?? Infinity, label).toBeLessThanOrEqual(
            entry?.innerWidth ?? 0,
          );
          expect(entry?.glyphHeight ?? Infinity, label).toBeLessThanOrEqual(
            entry?.innerHeight ?? 0,
          );
        }
        for (const icon of ['C', '👩‍💻']) {
          expect(measured[`${icon}-32`]?.fontSize, icon).toBeCloseTo(
            32 * GLYPH_SHARE,
            2,
          );
        }
        // Text glyphs still scale with the box, just at a smaller share.
        expect(
          (measured['MV-32']?.fontSize ?? 0) /
            (measured['MV-22']?.fontSize ?? 1),
        ).toBeCloseTo(32 / 22, 5);
      } finally {
        await pg.close();
      }
    });
  },
);

test.skipIf(chromiumIsInstalled(REPO_ROOT))(
  'BrandIcon glyph sizing — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so BrandIcon glyph sizing ' +
        'could not be measured: a missing precondition, not a passing ' +
        'check. Run `npm run install:playwright`.',
    );
  },
);
