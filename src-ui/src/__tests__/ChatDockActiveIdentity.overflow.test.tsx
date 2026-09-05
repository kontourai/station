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
import { ChatDockProjectContext } from '../components/chat-dock/ChatDockProjectContext';
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
  return dockFixtureHtml(
    `<div class="chat-dock__title">
       <div class="chat-dock__header-identity">${rowMarkup}</div>
     </div>`,
    width,
  );
}

/** `.chat-dock__header`'s real contents, whatever they are, at a given width. */
function dockFixtureHtml(headerMarkup: string, width: number): string {
  const css = resolveCssImports(INDEX_CSS_PATH);
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0">
    <div class="chat-dock" style="width:${width}px">
      <div class="chat-dock__header">${headerMarkup}</div>
    </div>
  </body>
</html>`;
}

/**
 * The whole title cluster as `ChatDockHeader` composes it: the identity block,
 * the project context, and the empty spacer that owns the row's growth.
 */
function titleClusterMarkup(title = 'New chat'): string {
  const { container, unmount } = render(
    <div className="chat-dock__title">
      <div className="chat-dock__header-identity">
        <ChatDockActiveIdentity
          session={
            {
              id: 'chat-1',
              title,
              agentSlug: 'codex',
              agentName: 'Claude Code',
            } as ChatSession
          }
          agent={
            {
              slug: 'codex',
              name: 'Claude Code',
              engineId: 'claude-code',
              engineDisplayName: 'Claude Code',
            } as unknown as AgentData
          }
          modelLabel="Opus 5"
          onClose={() => {}}
        />
      </div>
      <div className="chat-dock__header-context">
        {/* A real project name and path, not "No project": the badge is the
            identity cluster's competitor for the row, and an empty one would
            make every narrow measurement below optimistic. */}
        <ChatDockProjectContext
          projectSlug="kontourai-station"
          projectName="kontourai-station"
          workingDirectory="/Users/someone/dev/kontourai-station"
          projects={[]}
          onSelectProject={() => {}}
          onSwitchProject={() => {}}
        />
      </div>
      <span className="chat-dock__title-spacer" />
    </div>,
  );
  const html = container.innerHTML;
  unmount();
  return html;
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
     * Squeezed past that, the parts that are not the row's subject stop at their
     * floors and the title takes over the yielding.
     *
     * Measured in the REAL CLUSTER — identity plus the project badge plus the
     * spacer — because the identity-only fixture is optimistic: the badge is the
     * identity's competitor for the row, and every earlier version of this claim
     * was measured without it. A side dock's floor is `MIN_DOCK_WIDTH` = 280px
     * (`useDockShellChrome`), so every width here is reachable by dragging the
     * resize handle; none of it is hypothetical.
     *
     * WHAT HOLDS, and what does not:
     *  - the engine/model token never drops below 48px (a legible prefix and a
     *    hover target for its `title`) and the agent's name never below 40px;
     *  - at 320px and wider the conversation title keeps ~9 glyphs or more;
     *  - at the 280px floor it holds ~5. That is the disclosed limit of a
     *    CSS-only distribution: the floors cannot be conditional on the DOCK's
     *    width, because a media query sees the viewport (a 280px side dock lives
     *    in a 1456px window) and a container query would need `container-type`
     *    on a flex item that has to stay content-sized. Tapering them properly
     *    belongs to the header-composition pass, not here.
     * Before this round the same measurement read 21px at 320 and 5px at 280 —
     * a title of one or two characters, which is the defect this arc opened on.
     */
    test.each([
      [520, 180],
      [460, 140],
      [420, 110],
      [380, 90],
      [320, 64],
      [280, 32],
    ])(
      'at %ipx in the real cluster the floors hold and the title keeps %ipx',
      async (width, minTitle) => {
        const page = await browser.newPage({
          viewport: { width: Math.max(width, 400), height: 400 },
        });
        try {
          // The LONG title, so the title is a starvation candidate: at
          // `flex-basis: auto` a short one simply fits and the measurement says
          // nothing about the distribution.
          await page.setContent(
            dockFixtureHtml(titleClusterMarkup(LONG_TITLE), width),
          );
          const measured = await page.evaluate(() => {
            const box = (selector: string) => {
              const element = document.querySelector(selector);
              if (!element) throw new Error(`missing ${selector}`);
              const rect = element.getBoundingClientRect();
              return {
                left: rect.left,
                right: rect.right,
                width: rect.width,
                clipped: element.scrollWidth > element.clientWidth + 1,
              };
            };
            return {
              agent: box('.chat-dock__active-identity-agent'),
              title: box('.chat-dock__active-identity-title'),
              engine: box('.chat-dock__active-identity-engine'),
              close: box('.chat-dock__active-identity-close'),
              badge: box('.chat-dock__project-badge'),
              row: box('.chat-dock__header'),
            };
          });

          expect(Math.round(measured.engine.width)).toBeGreaterThanOrEqual(48);
          expect(Math.round(measured.agent.width)).toBeGreaterThanOrEqual(40);
          expect(Math.round(measured.title.width)).toBeGreaterThanOrEqual(
            minTitle,
          );
          // Still one run, still ordered, and the close control — the only
          // destructive one here — is never pushed out of the row.
          expect(measured.agent.right).toBeLessThanOrEqual(
            measured.title.left + 1,
          );
          expect(measured.title.right).toBeLessThanOrEqual(
            measured.engine.left + 1,
          );
          expect(measured.close.right).toBeLessThanOrEqual(
            measured.row.right + 1,
          );
          expect(measured.badge.right).toBeLessThanOrEqual(
            measured.row.right + 1,
          );
        } finally {
          await page.close();
        }
      },
    );
  },
);

describe.skipIf(!chromiumAvailable)(
  'the dock header title cluster reads as one run (#1536 F)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => cleanup());

    /**
     * The reported symptom was fragmentation, which is a distance: the identity
     * and the project context both GREW, so on a wide dock they split the spare
     * width and drifted to opposite ends —
     * `[avatar | New chat] ……… [Opus 5] [×] ……… [No project]`. Growth belongs to
     * an empty spacer, and this measures that it went there.
     */
    test('at a wide dock the badge follows the identity immediately, and the spacer holds the slack', async () => {
      const page = await browser.newPage({
        viewport: { width: 1456, height: 800 },
      });
      try {
        await page.setContent(dockFixtureHtml(titleClusterMarkup(), 1400));
        const measured = await page.evaluate(() => {
          const box = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`missing ${selector}`);
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width };
          };
          return {
            identity: box('.chat-dock__header-identity'),
            close: box('.chat-dock__active-identity-close'),
            badge: box('.chat-dock__project-badge'),
            spacer: box('.chat-dock__title-spacer'),
            title: box('.chat-dock__title'),
          };
        });

        // One run: the badge starts within a fixed seam of the identity block's
        // end, not half a row away.
        expect(measured.badge.left - measured.identity.right).toBeLessThan(16);
        // The × belongs to the identity cluster, immediately after its token.
        expect(measured.close.right).toBeLessThanOrEqual(
          measured.identity.right + 1,
        );
        // And the slack really is on the spacer, which is where a 1400px dock's
        // spare width has to go.
        expect(measured.spacer.width).toBeGreaterThan(600);
        expect(measured.spacer.left).toBeGreaterThanOrEqual(
          measured.badge.right - 1,
        );
      } finally {
        await page.close();
      }
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
