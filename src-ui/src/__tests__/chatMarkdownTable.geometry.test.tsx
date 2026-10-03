/**
 * @vitest-environment jsdom
 *
 * A markdown table in an answer on a 412px phone. The message surface sets
 * `overflow-wrap: anywhere`, which lowers every cell's min-content to one
 * character, so a squeezed table broke its first column letter by letter
 * ("Dire / ctor / y"), split `ls -la` at its hyphen, and centred its fourth
 * column (a leftover slash-command rule). The fix is geometry, so it is
 * measured: the real `MarkdownRenderer` markup, inside the real compact
 * answer row, in real Chromium with the resolved `index.css` and `chat.css`.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { MarkdownRenderer } from '../components/chat/MarkdownRenderer';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');

const TABLE = `| Check | Command | Result | Trusted |
| --- | --- | --- | --- |
| Directory contents | \`ls -la\` | Only a README and the repository metadata | yes |
| Commit history | \`git log --oneline -5\` | Fails: the default branch has no commits yet | no |
| Documentation completeness | \`README.md\` | One line only | no |`;

// Tokens no column can hold whole: a URL, a 64-character hash in prose, and
// a 60-character backticked path.
const LONG_TOKENS = `| Source | Detail |
| --- | --- |
| Manifest | https://github.com/kontourai/station/releases/download/nightly-2463/station-release-manifest.json |
| Commit | ${'0123456789abcdef'.repeat(4)} |
| Path | \`${'src-ui/src/components/'.repeat(3).slice(0, 60)}\` |`;

function answerMarkup(markdown = TABLE): string {
  const { container, unmount } = render(
    <MarkdownRenderer>{markdown}</MarkdownRenderer>,
  );
  const html = container.innerHTML;
  unmount();
  return html;
}

function fixtureHtml(answer: string, desktop = false): string {
  const css = [
    resolveCssImports(resolve(HERE, '../index.css')),
    resolveCssImports(resolve(HERE, '../components/chat/chat.css')),
  ].join('\n');
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0">
    <div class="chat-messages" style="height:900px">
      ${
        desktop
          ? // The desktop row: avatar beside an answer capped at 70% inline,
            // exactly as MessageBubble renders it off a phone.
            `<div class="message-row">
               <div class="message-row__avatar" style="width:32px;height:32px"></div>
               <div class="message assistant" style="position:relative;max-width:70%">${answer}</div>
             </div>`
          : `<div class="message-row message-row--compact">
               <div class="message assistant">${answer}</div>
               <button type="button" class="message-details__trigger">⋯</button>
             </div>`
      }
    </div>
  </body>
</html>`;
}

describe.skipIf(!chromiumIsInstalled(REPO_ROOT))(
  'markdown tables in a phone answer',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => cleanup());

    test.each([
      { label: 'a 412px phone answer', width: 412, desktop: false },
      {
        label: 'a desktop answer in its 70% column',
        width: 700,
        desktop: true,
      },
    ])(
      '$label: scrolls sideways instead of breaking words',
      async ({ width, desktop }) => {
        const page = await browser.newPage({
          viewport: { width, height: 915 },
        });
        try {
          await page.setContent(fixtureHtml(answerMarkup(), desktop));
          const m = await page.evaluate(() => {
            const lines = (element: Element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              return new Set(
                [...range.getClientRects()].map((rect) => Math.round(rect.top)),
              ).size;
            };
            const wrap = document.querySelector('.chat-markdown-table');
            const message = document.querySelector('.message.assistant');
            const row = document.querySelector('.message-row');
            if (!wrap || !message || !row)
              throw new Error('fixture incomplete');
            const firstColumn = [
              ...document.querySelectorAll('tbody tr td:first-child'),
            ].map((cell) => ({
              text: cell.textContent ?? '',
              lines: lines(cell),
            }));
            const code = [...document.querySelectorAll('td code')].map(
              (element) => ({
                text: element.textContent,
                lines: lines(element),
              }),
            );
            const fourth = document.querySelector('tbody td:nth-child(4)');
            return {
              wrapClient: wrap.clientWidth,
              wrapScroll: wrap.scrollWidth,
              messageRight: message.getBoundingClientRect().right,
              rowRight: row.getBoundingClientRect().right,
              firstColumn,
              code,
              fourthAlign: fourth ? getComputedStyle(fourth).textAlign : null,
            };
          });
          // The answer stays inside its row; the table scrolls inside it.
          expect(m.messageRight).toBeLessThanOrEqual(m.rowRight + 0.5);
          expect(m.wrapScroll, JSON.stringify(m)).toBeGreaterThan(m.wrapClient);
          // Two-word cells take at most two lines: no mid-word breaks.
          for (const cell of m.firstColumn) {
            expect(cell.lines, JSON.stringify(cell)).toBeLessThanOrEqual(2);
          }
          // Inline code stays whole, hyphens included.
          for (const code of m.code) {
            expect(code.lines, JSON.stringify(code)).toBe(1);
          }
          expect(m.fourthAlign).toBe('left');
        } finally {
          await page.close();
        }
      },
    );

    test.each([
      { label: 'a 412px phone', width: 412, desktop: false },
      { label: 'a 1200px desktop', width: 1200, desktop: true },
    ])(
      '$label: a token longer than its cell breaks inside that cell',
      async ({ width, desktop }) => {
        const page = await browser.newPage({
          viewport: { width, height: 915 },
        });
        try {
          await page.setContent(
            fixtureHtml(answerMarkup(LONG_TOKENS), desktop),
          );
          const cells = await page.evaluate(() =>
            [...document.querySelectorAll('td')].map((cell) => ({
              text: (cell.textContent ?? '').slice(0, 40),
              client: cell.clientWidth,
              scroll: cell.scrollWidth,
            })),
          );
          expect(cells.length).toBe(6);
          for (const cell of cells) {
            expect(cell.scroll, JSON.stringify(cell)).toBeLessThanOrEqual(
              cell.client + 1,
            );
          }
          // The scroller is keyboard-reachable and named, whatever the engine.
          const region = await page.evaluate(() => {
            const wrap = document.querySelector('.chat-markdown-table');
            return {
              tabIndex: (wrap as HTMLElement | null)?.tabIndex,
              label: wrap?.getAttribute('aria-label'),
            };
          });
          expect(region).toEqual({ tabIndex: 0, label: 'Table' });
        } finally {
          await page.close();
        }
      },
    );
  },
);
