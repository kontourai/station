/**
 * @vitest-environment jsdom
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';

/**
 * The dock header's one row: the identity (title, then agent and engine, on
 * one line) on the left, and the actions on the right, where New and its
 * destination project are one split control. Parts that refused to shrink
 * once painted over the title; a project name wrapped inside its button.
 *
 * jsdom lays nothing out, so it cannot see any of that. This measures the real
 * markup in a real Chromium page against the real, cascade-resolved
 * stylesheet — the same harness as
 * `ConnectionsSectionFrame.banner-hittest.test.tsx`.
 *
 * OWNERSHIP: `ChatDockActiveIdentity.overflow.test.tsx` measures the identity
 * row alone at real dock widths. This file owns the shared row: the identity
 * beside the New split, the destination's one-line name, the clip-or-fit rule
 * across the row, and the yield order between the title and its context.
 *
 * DRIVEN: three widths — 320px (nothing fits; everything must clip, not
 * overprint), 800px (the identity is squeezed by the actions cluster) and
 * 1200px (comfortable, proving the rules cost nothing when there is room).
 * NOT driven: the mobile header (`ChatDockMobileHeader`, its own component).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
const PROJECT_CONTEXT_CSS_PATH = resolve(
  HERE,
  '../components/chat-dock/ChatDockProjectContext.css',
);
const NEW_CHAT_ACTION_CSS_PATH = resolve(
  HERE,
  '../components/NewChatAction.css',
);

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: () => '⌘W',
}));
vi.mock('../contexts/KeyboardShortcutsContext', () => ({
  withShortcutHint: (label: string) => label,
}));
vi.mock('../components/icons/AgentIcon', () => ({
  // Fixed 20px, matching the real call's `size={20}`, so the row's geometry
  // stays faithful without pulling the icon's own data dependencies in.
  AgentIcon: ({ className }: { className?: string }) => (
    <span
      className={className}
      style={{ width: 20, height: 20, display: 'inline-block' }}
    />
  ),
}));

import { ChatDockActiveIdentity } from '../components/chat-dock/ChatDockActiveIdentity';
import { ChatDockProjectContext } from '../components/chat-dock/ChatDockProjectContext';
import { ChatDockWorkspaceActions } from '../components/chat-dock/ChatDockWorkspaceControls';

const session = {
  id: 'session-1',
  conversationId: 'thread-abc',
  agentSlug: 'claude',
  agentName: 'Claude Code',
  title: 'Reply with exactly: TURN TWO OK',
  messages: [],
} as never;

function renderHeaderMarkup(): string {
  const { container, unmount } = render(
    <div className="chat-dock chat-dock--bottom">
      <div className="chat-dock__header">
        <div className="chat-dock__title">
          <div className="chat-dock__header-identity">
            <ChatDockActiveIdentity
              session={session}
              agent={
                {
                  slug: 'claude',
                  name: 'Claude Code',
                  engineId: 'claude',
                } as never
              }
              modelLabel="Opus 5"
              onClose={() => {}}
            />
          </div>
          <span className="chat-dock__title-spacer" />
        </div>
        <div className="chat-dock__header-actions">
          <div className="chat-dock__new-split">
            <ChatDockWorkspaceActions onNewChat={() => {}} />
            <ChatDockProjectContext
              projectSlug="demo"
              projectName="A Rather Long Demo Project Name"
              workingDirectory="/Users/me/dev/github/kontourai/demo-project"
              projects={[]}
              onSelectProject={() => {}}
              onSwitchProject={() => {}}
            />
          </div>
          <button type="button" className="chat-dock__more-btn">
            ⋯
          </button>
        </div>
      </div>
    </div>,
  );
  const markup = container.innerHTML;
  unmount();
  return markup;
}

function buildFixtureHtml(
  markup: string,
  theme: string,
  ownerFirst: boolean,
): string {
  const cssPaths = ownerFirst
    ? [NEW_CHAT_ACTION_CSS_PATH, PROJECT_CONTEXT_CSS_PATH, INDEX_CSS_PATH]
    : [INDEX_CSS_PATH, NEW_CHAT_ACTION_CSS_PATH, PROJECT_CONTEXT_CSS_PATH];
  const css = cssPaths.map((path) => resolveCssImports(path)).join('\n');
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html data-theme="${theme}">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>${css}</style>
  </head>
  <body style="margin:0">${markup}</body>
</html>`;
}

type Measurement = {
  selector: string;
  clientWidth: number;
  scrollWidth: number;
  clientHeight: number;
  lineHeight: number;
  overflowX: string;
  visible: boolean;
  left: number;
  right: number;
  inkLeft: number;
};

const WIDTHS = [320, 800, 1200] as const;

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

// main.tsx imports App (and its eager component CSS) before index.css. Keep
// both orders covered so extraction or hot reload cannot change truncation.
describe.skipIf(!chromiumAvailable).each([
  { theme: 'dark', ownerFirst: true },
  { theme: 'light', ownerFirst: true },
  { theme: 'dark', ownerFirst: false },
  { theme: 'light', ownerFirst: false },
])(
  'dock header labels stay on one line without overprinting ($theme, owner CSS first: $ownerFirst)',
  ({ theme, ownerFirst }) => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
    });

    async function measure(width: number): Promise<Measurement[]> {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      try {
        await page.setContent(
          buildFixtureHtml(renderHeaderMarkup(), theme, ownerFirst),
        );
        return await page.evaluate(() =>
          [
            '.chat-dock__header',
            '.chat-dock__active-identity-text',
            '.chat-dock__active-identity-context',
            '.chat-dock__active-identity-agent',
            '.chat-dock__active-identity-engine',
            '.chat-dock__active-identity-title',
            '.chat-dock__new-split',
            '.chat-dock__project-context',
            '.chat-dock__project-badge',
            '.chat-dock__project-badge-name',
          ].map((selector) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`missing ${selector}`);
            const style = window.getComputedStyle(element);
            const fontSize = Number.parseFloat(style.fontSize) || 16;
            const parsedLineHeight = Number.parseFloat(style.lineHeight);
            const box = element.getBoundingClientRect();
            const text = document.createRange();
            text.selectNodeContents(element);
            return {
              selector,
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              clientHeight: element.clientHeight,
              lineHeight: Number.isFinite(parsedLineHeight)
                ? parsedLineHeight
                : fontSize * 1.2,
              overflowX: style.overflowX,
              visible: box.width > 0,
              left: box.left,
              right: box.right,
              inkLeft: text.getBoundingClientRect().left,
            };
          }),
        );
      } finally {
        await page.close();
      }
    }

    // 1px of tolerance throughout, for subpixel text metrics.
    const doesNotFit = (entry: Measurement) =>
      entry.scrollWidth > entry.clientWidth + 1;

    test.each(WIDTHS)(
      'anything that still cannot fit is clipped, never painted over its neighbour, at %ipx',
      async (width) => {
        const measurements = await measure(width);
        const unclipped = measurements
          .filter(doesNotFit)
          .filter(
            (entry) =>
              entry.overflowX !== 'hidden' && entry.overflowX !== 'clip',
          );
        expect(
          unclipped.map(
            ({ selector, scrollWidth, clientWidth, overflowX }) =>
              `${selector} ${scrollWidth}>${clientWidth} overflow-x:${overflowX}`,
          ),
        ).toEqual([]);
      },
    );

    test.each(WIDTHS)(
      'the destination project name stays on one line inside the split at %ipx',
      async (width) => {
        const measurements = await measure(width);
        const find = (selector: string) => {
          const entry = measurements.find((m) => m.selector === selector);
          if (!entry) throw new Error(`missing ${selector}`);
          return entry;
        };
        const name = find('.chat-dock__project-badge-name');
        const split = find('.chat-dock__new-split');
        // A wrapped second line at least doubles the box height.
        expect(name.clientHeight).toBeLessThan(name.lineHeight * 1.8);
        expect(name.left).toBeGreaterThanOrEqual(split.left - 1);
        expect(name.right).toBeLessThanOrEqual(split.right + 1);
      },
    );

    test.each(WIDTHS)(
      'the row never spills past the header at %ipx',
      async (width) => {
        const header = (await measure(width)).find(
          (m) => m.selector === '.chat-dock__header',
        );
        expect(header?.right).toBeLessThanOrEqual(width + 1);
      },
    );

    test('when the row is squeezed (560px), the agent and engine give up their width before the title does', async () => {
      const measurements = await measure(560);
      const title = measurements.find(
        (m) => m.selector === '.chat-dock__active-identity-title',
      )!;
      const context = measurements.find(
        (m) => m.selector === '.chat-dock__active-identity-context',
      )!;
      // The row is squeezed here, so this is not vacuous: the title is cut.
      expect(doesNotFit(title)).toBe(true);
      // And its context holds no more than a sliver of width while it is:
      // the context yields first (flex-shrink 100 to 1).
      expect(context.clientWidth).toBeLessThan(8);
    });
  },
);

/**
 * A `describe.skipIf` alone would make an uninstalled browser look like a
 * pass — the exact absence-as-success shape this suite exists to catch. The
 * sibling `HeaderActions.connection-reflow.test.tsx` established this guard.
 */
test.skipIf(chromiumAvailable)(
  'dock header identity/project-context geometry (#1536 E2) — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the ' +
        'browser-backed geometry assertions above did not run. Install it ' +
        '(`npx playwright install chromium`) and re-run.',
    );
  },
);
