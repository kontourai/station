/**
 * @vitest-environment jsdom
 *
 * #3061: a framed page's subtitle is a sentence people read, and it measured
 * 4.1:1 in the light theme (the muted tier on the page background). The kit's
 * 1.17 retint of that tier brought it to 4.52:1 — inside AA by two hundredths,
 * which is the reason this is measured rather than assumed. The real
 * `PageFrame` markup goes into Chromium under the cascade-resolved app CSS and
 * the subtitle's computed colour is measured against the background it
 * actually sits on, for every channel in both modes.
 */

import { resolve } from 'node:path';
import { contrastRatio } from '@kontourai/ui/contrast';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { PageFrame } from '../components/page-frame';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const CSS_PATHS = [
  resolve(import.meta.dirname, '../index.css'),
  resolve(import.meta.dirname, '../components/page-frame/page-frame.css'),
];
const AA_TEXT = 4.5;

const PRESETS = (['release', 'dev', 'beta', 'nightly'] as const).flatMap(
  (channel) =>
    (['light', 'dark'] as const).map((theme) => ({ theme, channel })),
);

function fixtureHtml(): string {
  const { container, unmount } = render(
    <PageFrame
      spec={{
        title: 'Agents',
        subtitle: 'Choose an AI app or create your own agent.',
      }}
      routeIdentity="agents"
    >
      <div>body</div>
    </PageFrame>,
  );
  if (!container.querySelector('.page__subtitle'))
    throw new Error('the frame did not render a subtitle');
  const html = container.innerHTML;
  unmount();
  const css = CSS_PATHS.map((path) => resolveCssImports(path)).join('\n');
  assertNoImportsSurvive(css);
  return `<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'a framed page subtitle keeps AA text contrast',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    let html: string;

    beforeAll(async () => {
      browser = await chromium.launch();
      html = fixtureHtml();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => cleanup());

    test.each(PRESETS)('$theme / $channel', async ({ theme, channel }) => {
      const page = await browser.newPage();
      try {
        await page.setContent(html);
        const measured = await page.evaluate(
          ({ theme, channel }) => {
            const root = document.documentElement;
            root.setAttribute('data-theme', theme);
            if (channel === 'dev') root.classList.add('is-dev-build');
            else if (channel !== 'release')
              root.setAttribute('data-app-channel', channel);
            const probe = document.createElement('canvas').getContext('2d');
            if (!probe) throw new Error('no 2d context');
            const rgba = (value: string) => {
              probe.clearRect(0, 0, 1, 1);
              probe.fillStyle = value;
              probe.fillRect(0, 0, 1, 1);
              const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
              return [r, g, b, a / 255];
            };
            const hex = (c: number[]) =>
              `#${c
                .slice(0, 3)
                .map((n) => Math.round(n).toString(16).padStart(2, '0'))
                .join('')}`;
            const subtitle =
              document.querySelector<HTMLElement>('.page__subtitle');
            if (!subtitle) throw new Error('no subtitle');
            const text = rgba(getComputedStyle(subtitle).color);
            if (text[3] < 0.999) throw new Error('translucent subtitle text');
            // Nearest opaque fill behind the text; a translucent or image
            // layer on the way would make the measurement meaningless.
            let background: number[] | null = null;
            for (
              let node: HTMLElement | null = subtitle;
              node;
              node = node.parentElement
            ) {
              const style = getComputedStyle(node);
              if (style.backgroundImage !== 'none')
                throw new Error(`background image behind ${node.className}`);
              const fill = rgba(style.backgroundColor);
              if (fill[3] === 0) continue;
              if (fill[3] < 0.999)
                throw new Error(`translucent fill on ${node.className}`);
              background = fill;
              break;
            }
            if (!background) throw new Error('no opaque backdrop');
            return { text: hex(text), background: hex(background) };
          },
          { theme, channel },
        );
        expect(
          contrastRatio(measured.text, measured.background),
          `${measured.text} on ${measured.background}`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      } finally {
        await page.close();
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'page subtitle contrast — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so this could ' +
        'not be measured — a missing precondition, not a passing check. ' +
        'Install it with `npm run install:playwright` and re-run.',
    );
  },
);
