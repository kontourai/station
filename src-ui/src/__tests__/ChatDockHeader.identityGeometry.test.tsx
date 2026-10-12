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
 * With a project bound, the dock header's identity row and project-context row
 * share one line. Its parts refused to shrink (`flex-shrink: 0` on the agent
 * name and the model) inside a box that could be narrower than they were, and
 * nothing clipped that box — so "Claude Code" and "Opus 5" painted over the
 * session title, the project name wrapped onto a second line inside its
 * <button>, and "main" dropped below the ⎇ glyph.
 *
 * jsdom lays nothing out, so it cannot see any of that. This measures the real
 * markup in a real Chromium page against the real, cascade-resolved
 * stylesheet — the same harness as
 * `ConnectionsSectionFrame.banner-hittest.test.tsx`.
 *
 * OWNERSHIP, after #1536 F merged: `ChatDockActiveIdentity.overflow.test.tsx`
 * is the identity row's authority — it measures real dock widths (down to
 * 260px, below `MIN_DOCK_WIDTH`) and pins the yield ORDER their policy sets
 * (engine, then agent, then title), including containment and the title's
 * floors, so this file no longer re-measures them. What it owns is the
 * PROJECT-CONTEXT half: the project badge and the git badge, which #1536 F left
 * in place when it deleted the visible path segment beside them, plus the
 * clip-or-fit rule across the shared row. #3144 deliberately stacked a
 * "New chats" caption above the project name: each label must stay on one
 * line, rather than requiring the whole badge to be one line tall.
 *
 * DRIVEN: three widths, each chosen because it makes a different part of the
 * row the binding constraint — 320px (the identity row's own contents no
 * longer fit its box: the overprint), 800px (the project row is squeezed and
 * the git badge is still rendered, so the wrapped project name and branch are
 * both observable), and 1200px (comfortable, proving the fix costs nothing
 * when there is room). NOT driven: the mobile header
 * (`ChatDockMobileHeader`, its own component and its own wrap rules) and the
 * maximized dock. Below the dock's mobile breakpoint the project path and git
 * badge are `display: none`, so a width alone is not enough to make the branch
 * assertion meaningful — `renders the git branch` below pins that.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');
const PROJECT_CONTEXT_CSS_PATH = resolve(
  HERE,
  '../components/chat-dock/ChatDockProjectContext.css',
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

const session = {
  id: 'session-1',
  conversationId: 'thread-abc',
  agentSlug: 'claude',
  agentName: 'Claude Code',
  title: 'Reply with exactly: TURN TWO OK',
  messages: [],
} as never;

const gitStatus = {
  isRepo: true,
  // A real branch name from this lane: short enough labels never squeezed the
  // badge at all, which is why "⎇ main" wrapping went unnoticed for so long.
  branch: 'ux-audit/2026-09-05-fresh-home-highs',
  changes: [],
  staged: 0,
  unstaged: 0,
  untracked: 0,
  ahead: 0,
  behind: 0,
  lastCommit: null,
};

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
          <div className="chat-dock__header-context">
            <ChatDockProjectContext
              projectSlug="demo"
              projectName="Demo Project"
              workingDirectory="/Users/me/dev/github/kontourai/demo-project"
              gitStatus={gitStatus}
              projects={[]}
              onSelectProject={() => {}}
              onSwitchProject={() => {}}
            />
          </div>
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
    ? [PROJECT_CONTEXT_CSS_PATH, INDEX_CSS_PATH]
    : [INDEX_CSS_PATH, PROJECT_CONTEXT_CSS_PATH];
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
            '.chat-dock__active-identity-text',
            '.chat-dock__active-identity-agent',
            '.chat-dock__active-identity-engine',
            '.chat-dock__active-identity-title',
            '.chat-dock__project-context',
            '.chat-dock__project-badge',
            '.chat-dock__project-badge-lines',
            '.chat-dock__project-badge-caption',
            '.chat-dock__project-badge-name',
            '.git-badge',
            '.git-badge__branch',
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
      'the project labels stay left aligned and all labels fit one line at %ipx',
      async (width) => {
        const measurements = await measure(width);
        const column = measurements.find(
          (entry) => entry.selector === '.chat-dock__project-badge-lines',
        );
        if (!column) throw new Error('missing project label column');
        for (const selector of [
          '.chat-dock__project-badge-caption',
          '.chat-dock__project-badge-name',
          '.git-badge__branch',
        ]) {
          const entry = measurements.find((m) => m.selector === selector);
          if (!entry) throw new Error(`missing ${selector}`);
          // Below the dock's mobile breakpoint the git badge is display:none,
          // so it has no line to wrap. `renders the git branch` proves this
          // skip cannot quietly cover every width.
          if (entry.clientWidth === 0) continue;
          // A wrapped second line at least doubles the box height.
          expect(entry.clientHeight).toBeLessThan(entry.lineHeight * 1.8);
          if (selector !== '.git-badge__branch') {
            expect(entry.left).toBeGreaterThanOrEqual(column.left - 1);
            expect(entry.right).toBeLessThanOrEqual(column.right + 1);
            expect(
              entry.inkLeft,
              `${selector} text remains left aligned`,
            ).toBeCloseTo(column.left, 0);
          }
        }
      },
    );

    test('renders the git branch at 800px, so the one-line check is not vacuous', async () => {
      const branch = (await measure(800)).find(
        (entry) => entry.selector === '.git-badge__branch',
      );
      expect(branch?.clientWidth).toBeGreaterThan(0);
    });

    test.each(WIDTHS)(
      'the git badge stays inside its own box at %ipx',
      async (width) => {
        // #1536 L10: the branch label ellipsises, but the badge that holds it
        // must not spill — a `flex-shrink: 0` anchor plus a long branch name is
        // exactly how the header used to push content past its edge.
        const measurements = await measure(width);
        const badge = measurements.find((m) => m.selector === '.git-badge');
        if (!badge) throw new Error('missing git badge');
        if (badge.clientWidth === 0) return; // display:none below the breakpoint
        expect(
          badge.scrollWidth <= badge.clientWidth + 1 ||
            badge.overflowX === 'hidden' ||
            badge.overflowX === 'clip',
          `the git badge holds ${badge.scrollWidth}px in a ${badge.clientWidth}px ` +
            `box with overflow-x:${badge.overflowX}, so it is painting outside it`,
        ).toBe(true);
      },
    );
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
