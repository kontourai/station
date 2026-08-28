/**
 * @vitest-environment jsdom
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';
import { MIN_TOUCH_TARGET_PX } from '../../../../../tests/helpers/touch-target';
import { bannerStore } from '../../../contexts/banner-store';
import { BannerHost } from '../BannerHost';

/**
 * archive#4470a — reproduces (and pins the fix for) the reported overlap: on
 * a real Android build, the pairing-mismatch banner's inline "Less" toggle
 * rendered on top of the message text once the banner was expanded.
 *
 * jsdom does not lay out CSS (same precondition as
 * `BannerHost.touch-target.test.tsx`, archive#3453's own docblock), so
 * geometry can only be proven against a real engine: this renders the actual
 * `BannerHost` component through `@testing-library/react`, injects the
 * resulting markup into a real Chromium page carrying the REAL, cascade-
 * resolved stylesheets (`index.css` + `BannerHost.css`, `@import`s fully
 * inlined and proven complete by `assertNoImportsSurvive`), and measures
 * actual `getBoundingClientRect`/`Range.getClientRects` geometry at a
 * 390x844 phone viewport — the same shape archive#3453 used to prove a real,
 * rendered control height where a CSS-source-text ratchet cannot see the
 * resolved cascade.
 *
 * Root cause (see `BannerHost.css`'s own comment on `.banner-host__disclosure`):
 * the control used `margin: -14px 0` to reach a 44px-tall tap target without
 * growing its own line's height. A negative vertical margin on an inline box
 * does not push neighbouring line boxes apart — it only changes where the box
 * PAINTS — so the 44px-tall box bled into whatever sat above or below its own
 * line. Two independently-shaped fixtures pin both directions of that bleed:
 * a long message that WRAPS (the toggle lands on line 2 and bled upward into
 * line 1 — the exact defect reported, "isn't the one this device paired
 * with" overlapped by "Less") and a short, non-wrapping message (the toggle
 * bled downward into the detail text directly beneath it). Both are asserted
 * here so a fix that only moves the bleed from one neighbour to the other
 * (tried and rejected while diagnosing this: biasing the negative margin
 * asymmetrically toward the bottom killed the wrap case but reproduced the
 * short-message case) cannot pass silently.
 *
 * PRECONDITION: same as `BannerHost.touch-target.test.tsx` — launches a real
 * Chromium via `@playwright/test`, provisioned by `npm run
 * install:playwright` (not by `npm ci`). Per this repo's browser-test
 * doctrine ("no conditional green exits"), a missing precondition FAILS this
 * file loudly rather than skipping silently.
 *
 * RESOURCE CLASSIFICATION: like its sibling, this spawns a real Chromium
 * process via `playwright-core` and belongs in
 * `scripts/vitest-resource-manifest.mjs`'s `PROCESS_HEAVY_VITEST_FILES`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const INDEX_CSS_PATH = resolve(HERE, '../../../index.css');
const BANNER_CSS_PATH = resolve(HERE, '../BannerHost.css');

function buildFixtureCss(): string {
  const css = `${resolveCssImports(INDEX_CSS_PATH)}\n${resolveCssImports(BANNER_CSS_PATH)}`;
  assertNoImportsSurvive(css);
  return css;
}

function renderExpandedFixtureMarkup(input: {
  message: string;
  detail: string;
}): string {
  act(() => {
    bannerStore.present({
      id: 'station-4470:overlap',
      priority: 100,
      tone: 'error',
      message: input.message,
      detail: input.detail,
      actions: [
        { label: 'Pair again', onClick: () => {} },
        { label: 'Remove', variant: 'danger', onClick: () => {} },
      ],
    });
  });
  const { container, unmount } = render(<BannerHost connectionSlot={false} />);
  // Expand the disclosure — the overlap only exists once `detail` is
  // showing; collapsed, the disclosure is not rendered at all
  // (BannerHost.tsx). archive#4470b: the toggle's label is now the constant
  // "Details" regardless of state (was "More"/"Less").
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  const markup = container.innerHTML;
  unmount();
  return markup;
}

function buildFixtureHtml(markup: string): string {
  const css = buildFixtureCss();
  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <style>${css}</style>
  </head>
  <body style="margin:0">${markup}</body>
</html>`;
}

type Box = { x: number; y: number; width: number; height: number };

// The real defect this file exists to catch overlapped by double-digit
// pixels (an 11px vertical bleed into the preceding wrapped line, measured
// while diagnosing archive#4470a). A small epsilon absorbs ordinary
// Chromium subpixel/font-hinting rounding under concurrent load — observed
// up to ~1px drift running alongside this repo's other real-Chromium
// geometry tests, matching this repo's own documented "shared-host sibling
// sessions are the dominant flake source" (see CLAUDE.md) — without coming
// anywhere near masking the real, tens-of-pixels overlap.
function boxesOverlap(a: Box, b: Box, epsilon = 1.5): boolean {
  return (
    a.y < b.y + b.height - epsilon &&
    b.y < a.y + a.height - epsilon &&
    a.x < b.x + b.width - epsilon &&
    b.x < a.x + a.width - epsilon
  );
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'BannerHost disclosure toggle does not overlap message text (station#4470a)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    afterEach(() => {
      act(() => bannerStore.reset());
    });

    test.each([
      [
        'a long message that wraps across lines',
        "The Station at station-nightly.example.ts.net isn't the one this device paired with.",
        'It may have been reset or reinstalled. Pair again, or remove this connection.',
      ],
      [
        'a short, single-line message',
        'Connection needs attention.',
        'Detail text that sits directly beneath the short one-line message.',
      ],
    ])(
      'the expanded "Less" toggle never paints over the message text — %s',
      async (_label, message, detail) => {
        const markup = renderExpandedFixtureMarkup({ message, detail });
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        try {
          await page.setContent(buildFixtureHtml(markup));

          const disclosure = await page
            .locator('.banner-host__disclosure')
            .boundingBox();
          expect(disclosure, '.banner-host__disclosure not visible').not.toBe(
            null,
          );
          // The overlap fix must not regress the touch-target floor
          // (archive#3453) it shares CSS with.
          expect(disclosure!.height).toBeGreaterThanOrEqual(
            MIN_TOUCH_TARGET_PX,
          );

          const detailBox = await page
            .locator('.banner-host__detail')
            .boundingBox();
          expect(detailBox, '.banner-host__detail not visible').not.toBe(null);

          // Every visual LINE of the message's own text, independent of the
          // disclosure's own inline position within it — `Range.getClientRects`
          // returns one rect per wrapped line, which a block-level
          // `getBoundingClientRect` on `.banner-host__message` cannot.
          const lineRects: Box[] = await page.evaluate(() => {
            const messageEl = document.querySelector('.banner-host__message');
            const textNode = messageEl?.childNodes[0];
            if (!textNode) return [];
            const range = document.createRange();
            range.selectNodeContents(textNode);
            return [...range.getClientRects()].map((r) => ({
              x: r.left,
              y: r.top,
              width: r.width,
              height: r.height,
            }));
          });
          expect(
            lineRects.length,
            'expected at least one message text line rect',
          ).toBeGreaterThan(0);

          const overlappingLines = lineRects
            .map((rect, i) => ({ i, rect }))
            .filter(({ rect }) => boxesOverlap(disclosure!, rect));
          expect(
            overlappingLines,
            `disclosure ${JSON.stringify(disclosure)} overlaps message text line(s): ${JSON.stringify(overlappingLines)}`,
          ).toEqual([]);

          expect(
            boxesOverlap(disclosure!, detailBox!),
            `disclosure ${JSON.stringify(disclosure)} overlaps detail ${JSON.stringify(detailBox)}`,
          ).toBe(false);
        } finally {
          await page.close();
        }
      },
    );
  },
);

test.skipIf(chromiumAvailable)(
  'BannerHost disclosure overlap — Chromium not installed, cannot verify (station#4470a)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'disclosure-overlap fix (station#4470a) could not be checked — this ' +
        'is a missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
