/**
 * @vitest-environment jsdom
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
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
 * The render-evidence cases also cover the mobile header and shared Model picker.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
const NEW_CHAT_ACTION_CSS_PATH = resolve(
  HERE,
  '../components/NewChatAction.css',
);

const fixtureViewport = vi.hoisted(() => ({ width: 1440 }));
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: fixtureViewport.width <= 768,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});
vi.mock('../hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => fixtureViewport.width <= 768,
}));

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
import { ChatDockMobileHeader } from '../components/chat-dock/ChatDockMobileHeader';
import { ChatDockWorkspaceActions } from '../components/chat-dock/ChatDockWorkspaceControls';
import { StartModelPicker } from '../components/chat-start/StartMenus';

const session = {
  id: 'session-1',
  conversationId: 'thread-abc',
  agentSlug: 'claude',
  agentName: 'Claude Code',
  title: 'Reply with exactly: TURN TWO OK',
  messages: [],
} as never;

function renderHeaderMarkup(state = 'active'): string {
  const { container, unmount } = render(
    <div className="chat-dock chat-dock--bottom">
      <div className="chat-dock__header">
        <div className="chat-dock__title">
          <div className="chat-dock__header-identity">
            {state === 'active' ? (
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
            ) : (
              <span>{state === 'inbox' ? 'Inbox' : 'New chat'}</span>
            )}
          </div>
          <span className="chat-dock__title-spacer" />
        </div>
        <div className="chat-dock__header-actions">
          <div className="chat-dock__new-split">
            <ChatDockWorkspaceActions onNewChat={() => {}} />
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
    ? [NEW_CHAT_ACTION_CSS_PATH, INDEX_CSS_PATH]
    : [INDEX_CSS_PATH, NEW_CHAT_ACTION_CSS_PATH];
  const css = [
    ...cssPaths,
    resolve(HERE, '../components/chat/chat.css'),
    resolve(HERE, '../components/chat-dock/ChatDockHeader.css'),
  ]
    .map((path) => resolveCssImports(path))
    .join('\n');
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
  top: number;
  bottom: number;
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
              top: box.top,
              bottom: box.bottom,
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
      'the row never spills past the header at %ipx',
      async (width) => {
        const header = (await measure(width)).find(
          (m) => m.selector === '.chat-dock__header',
        );
        expect(header?.right).toBeLessThanOrEqual(width + 1);
      },
    );

    const find = (measurements: Measurement[], selector: string) =>
      measurements.find((m) => m.selector === selector)!;
    // Below the row's one clipped line: stepped aside, not squeezed.
    const offTheLine = (part: Measurement, row: Measurement) =>
      part.top >= row.bottom - 1;

    test.each([320, 560, 800])(
      'squeezed (%ipx): while the title is cut, the agent and engine are off its line',
      async (width) => {
        const measurements = await measure(width);
        const row = find(measurements, '.chat-dock__active-identity-text');
        const title = find(measurements, '.chat-dock__active-identity-title');
        const agent = find(measurements, '.chat-dock__active-identity-agent');
        const engine = find(measurements, '.chat-dock__active-identity-engine');
        // Not vacuous at the narrowest width: the title is cut there.
        if (width === 320) expect(doesNotFit(title)).toBe(true);
        if (doesNotFit(title)) {
          expect(offTheLine(agent, row)).toBe(true);
          expect(offTheLine(engine, row)).toBe(true);
        }
        // The engine goes before the agent.
        if (!offTheLine(engine, row))
          expect(offTheLine(agent, row)).toBe(false);
      },
    );

    test('with room (1200px), the title is whole and the agent and engine share its line', async () => {
      const measurements = await measure(1200);
      const row = find(measurements, '.chat-dock__active-identity-text');
      expect(
        doesNotFit(find(measurements, '.chat-dock__active-identity-title')),
      ).toBe(false);
      for (const selector of [
        '.chat-dock__active-identity-agent',
        '.chat-dock__active-identity-engine',
      ])
        expect(offTheLine(find(measurements, selector), row)).toBe(false);
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

describe.skipIf(!chromiumAvailable).each(['dark', 'light'])(
  'chat control render evidence (%s)',
  (theme) => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    const captures = resolve(REPO_ROOT, 'test-results/ui-reliability');
    beforeAll(async () => {
      mkdirSync(captures, { recursive: true });
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    test.each(
      [320, 390, 412, 1440].flatMap((width) =>
        ['empty', 'inbox', 'active'].map((state) => ({ width, state })),
      ),
    )(
      'chat bar controls fit at $width px ($state)',
      async ({ width, state }) => {
        fixtureViewport.width = width;
        let markup: string;
        if (width < 769) {
          const view = render(
            <div className="chat-dock chat-dock--bottom">
              <ChatDockMobileHeader
                inboxActive={state === 'inbox'}
                hasConversation={state === 'active'}
                showDrawerToggle={false}
                showConnection={true}
                sessionTitle={
                  state === 'active' ? 'Review the implementation' : 'New chat'
                }
                agentIdentity={
                  state === 'active' ? { name: 'Agent', slug: 'agent' } : null
                }
                activeCount={0}
                unreadCount={0}
                inboxTriggerRef={createRef<HTMLButtonElement>()}
                onToggleInbox={() => {}}
                onToggleSidebar={() => {}}
                onDragPointerDown={() => {}}
                onDragClickCapture={() => {}}
                dockToggle={{
                  state: 'collapsed',
                  onExpand: () => {},
                  onCollapse: () => {},
                }}
                extentToggle={{ maximized: false, onToggle: () => {} }}
                onNewChat={() => {}}
                overflow={{
                  onOpenConversation: () => {},
                  onToggleHistory: () => {},
                  onOpenChatSettings: () => {},
                  onOpenProject: null,
                  openProjectName: null,
                  onOpenProfile: () => {},
                  onOpenAppSettings: () => {},
                  onCollapseDock: () => {},
                  onExpandDock: () => {},
                  onRestoreDock: () => {},
                  isDockMaximized: false,
                }}
              />
            </div>,
          );
          markup = view.container.innerHTML;
          view.unmount();
        } else markup = renderHeaderMarkup(state);
        fixtureViewport.width = 1440;
        const page = await browser.newPage({
          viewport: { width, height: 300 },
        });
        try {
          await page.setContent(buildFixtureHtml(markup, theme, false));
          await page.evaluate(() =>
            Promise.all(
              document.getAnimations().map((animation) => animation.finished),
            ),
          );
          const header = page.locator('.chat-dock__header');
          expect(
            await header
              .getByRole('button', {
                name: /Switch project|New chats:|Choose a project/,
              })
              .count(),
          ).toBe(0);
          if (width < 769) {
            const maximize = page.getByRole('button', {
              name: 'Full screen chat',
            });
            expect(await maximize.isVisible()).toBe(true);
            const box = await maximize.boundingBox();
            expect(box?.width).toBeGreaterThanOrEqual(44);
            expect(box?.height).toBeGreaterThanOrEqual(44);
            expect(
              await maximize.evaluate((button) => {
                const r = button.getBoundingClientRect();
                const hit = document.elementFromPoint(
                  r.x + r.width / 2,
                  r.y + r.height / 2,
                );
                return hit !== null && button.contains(hit);
              }),
            ).toBe(true);
          }
          await header.screenshot({
            path: resolve(captures, `chat-bar-${width}-${theme}-${state}.png`),
          });
        } finally {
          await page.close();
        }
      },
    );

    test.each([390, 1440])(
      'the shared model picker fits at %ipx',
      async (width) => {
        fixtureViewport.width = width;
        const view = render(
          <StartModelPicker
            anchor={null}
            layer="dialog"
            loading={false}
            modelConnections={[]}
            models={[
              {
                id: 'gpt-6.1-terra',
                name: 'GPT 6.1 Terra',
                engineName: 'Codex',
                capabilities: {
                  supportsEffort: true,
                  supportedEffortLevels: ['low', 'high'],
                },
              },
            ]}
            choice={{ modelId: 'gpt-6.1-terra', providerOptions: {} }}
            onSelect={() => {}}
            onReset={() => {}}
            onRuntimeOptionChange={() => {}}
            onClose={() => {}}
          />,
        );
        await screen.findByRole('option', { name: /GPT 6.1 Terra/ });
        const overlay = document.querySelector('.composer-popover-overlay');
        if (!overlay) throw new Error('Model picker did not render');
        const markup = overlay.outerHTML;
        view.unmount();
        fixtureViewport.width = 1440;
        const page = await browser.newPage({
          viewport: { width, height: 900 },
        });
        try {
          const css = [
            'components/chat/chat.css',
            'components/chat-start/StartComposer.css',
            'components/session/SessionModelPicker.css',
          ]
            .map((path) => resolveCssImports(resolve(HERE, '..', path)))
            .join('\n');
          assertNoImportsSurvive(css);
          await page.setContent(
            buildFixtureHtml(markup, theme, false).replace(
              '</style>',
              `${css}</style>`,
            ),
          );
          await page.evaluate(() =>
            Promise.all(
              document.getAnimations().map((animation) => animation.finished),
            ),
          );
          const picker = page.locator('.session-model-picker');
          const box = await picker.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
          await page.screenshot({
            path: resolve(captures, `model-picker-${width}-${theme}.png`),
          });
        } finally {
          await page.close();
        }
      },
    );
  },
);
