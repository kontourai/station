/**
 * @vitest-environment jsdom
 *
 * #1536 section F reported two things about the dock header's identity row, and
 * both are geometry: with a long project path the conversation title got about
 * ONE CHARACTER, and "Claude Code" printed on top of "Opus 5".
 *
 * jsdom lays out nothing, so neither is observable there — the shrink factors
 * that fix them are CSS. This renders the real `ChatDockActiveIdentity` markup
 * into a real Chromium page carrying the real, cascade-resolved `index.css` at a
 * width narrow enough to force the overflow, and measures.
 *
 * The pre-fix arrangement is what makes the two claims discriminating: the agent
 * name, the engine chip and the model were each `flex-shrink: 0` inside an
 * `overflow: hidden` row, and a `flex-shrink: 0` box in an overflowing flex line
 * does not truncate — it keeps its width and the line overflows, which is how
 * two spans end up occupying the same pixels.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { ChatDockActiveIdentity } from '../components/chat-dock/ChatDockActiveIdentity';
import type { AgentData } from '../contexts/AgentsContext';
import type { ChatSession } from '../types';

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: () => '⌘W',
}));

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');

const LONG_TITLE =
  'Reduce default toolbar clutter in the main header and the chat dock';

function markup(): string {
  const { container, unmount } = render(
    <ChatDockActiveIdentity
      session={
        {
          id: 'chat-1',
          title: LONG_TITLE,
          agentSlug: 'codex',
          agentName: 'Codex',
        } as ChatSession
      }
      agent={
        {
          slug: 'codex',
          name: 'Codex',
          engineId: 'claude-code',
          engineDisplayName: 'Claude Code',
        } as unknown as AgentData
      }
      modelLabel="Opus 5 (1M context)"
      onClose={() => {}}
    />,
  );
  const html = container.innerHTML;
  unmount();
  return html;
}

/**
 * The row's real host: `.chat-dock__header-identity` inside a
 * `.chat-dock__header` flex line, at a width where the content cannot fit.
 */
function fixtureHtml(rowMarkup: string, width: number): string {
  const css = resolveCssImports(INDEX_CSS_PATH);
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0">
    <div class="chat-dock" style="width:${width}px">
      <div class="chat-dock__header">
        <div class="chat-dock__title">
          <div class="chat-dock__header-identity">${rowMarkup}</div>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'ChatDockActiveIdentity overflow behaviour (#1536 F)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => cleanup());

    async function measure(width: number) {
      const page = await browser.newPage({
        viewport: { width: Math.max(width, 400), height: 200 },
      });
      try {
        await page.setContent(fixtureHtml(markup(), width));
        return await page.evaluate(() => {
          const box = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`missing ${selector}`);
            const rect = element.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              width: rect.width,
              text: element.textContent ?? '',
              clipped: element.scrollWidth > element.clientWidth + 1,
            };
          };
          return {
            title: box('.chat-dock__active-identity-title'),
            engine: box('.chat-dock__active-identity-engine'),
            agent: box('.chat-dock__active-identity-agent'),
            row: box('.chat-dock__header-identity'),
          };
        });
      } finally {
        await page.close();
      }
    }

    // Measured, not chosen: with this fixture nothing clips at 700 and wider,
    // the token alone clips at 600, and the title joins it below ~520.
    test.each([700, 600, 420, 260])(
      'nothing overprints at %ipx: the row is ordered left to right and stays inside its host',
      async (width) => {
        const { title, engine, agent, row } = await measure(width);

        expect(agent.right).toBeLessThanOrEqual(title.left + 1);
        expect(title.right).toBeLessThanOrEqual(engine.left + 1);
        // A `flex-shrink: 0` span in an overflowing flex line keeps its width
        // and the line overflows — which is how two of them end up on the same
        // pixels. Nothing here leaves its host.
        expect(engine.right).toBeLessThanOrEqual(row.right + 1);
      },
    );

    test('a dock with room for the whole row truncates neither part', async () => {
      const { title, engine } = await measure(700);

      expect(title.clipped).toBe(false);
      expect(engine.clipped).toBe(false);
    });

    test('the engine/model token is the first thing to give way', async () => {
      const { title, engine } = await measure(600);

      expect(
        engine.clipped,
        'the engine token should be the one truncating first',
      ).toBe(true);
      expect(title.clipped, 'the title should still fit at this width').toBe(
        false,
      );
      // The reported symptom was a title reduced to about one character. Here
      // it holds most of the row.
      expect(title.width).toBeGreaterThan(300);
    });

    /**
     * Squeezed past that, the token yields ENTIRELY (its shrink factor is two
     * orders of magnitude above the title's, so it reaches zero before the
     * title starts losing characters) and only then does the title truncate.
     * That is the trade #1536 F asked for, stated plainly: in a ~400px side
     * dock the engine and model are no longer legible, and the agent's own name
     * — which never shrinks — is what still identifies who is answering.
     */
    test('below that the token yields entirely and the title truncates rather than pushing the row open', async () => {
      const { title, engine, row } = await measure(420);

      expect(Math.round(engine.width)).toBe(0);
      expect(title.clipped).toBe(true);
      expect(title.width).toBeGreaterThan(100);
      expect(title.right).toBeLessThanOrEqual(row.right + 1);
    });
  },
);

test.skipIf(chromiumAvailable)(
  'ChatDockActiveIdentity overflow — Chromium not installed, cannot verify (#1536 F)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the dock ' +
        'identity row’s overflow behaviour could not be measured — this is ' +
        'a missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
