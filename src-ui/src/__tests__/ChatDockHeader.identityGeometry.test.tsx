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
 * (engine, then agent, then title). The identity assertions below still hold
 * under that policy and are kept as containment guards, not as a second opinion
 * on priority. What this file uniquely owns is the PROJECT-CONTEXT half: the
 * project badge and the git badge, which #1536 F left in place when it deleted
 * the visible path segment beside them.
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
              workingDirectory="/Users/brian/dev/github/kontourai/demo-project"
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

function buildFixtureHtml(markup: string): string {
  const css = resolveCssImports(INDEX_CSS_PATH);
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html>
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
};

const WIDTHS = [320, 800, 1200] as const;

/**
 * The widths this component actually renders at. Below the dock's 768px
 * breakpoint the shell mounts `ChatDockMobileHeader` instead, so 320px exists in
 * `WIDTHS` only to squeeze the identity row hard enough to expose an unclipped
 * overflow — it is not a width whose READABILITY this component owns.
 */
const DESKTOP_WIDTHS = [800, 1200] as const;

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'dock header identity and project context stay on one line without overprinting',
  () => {
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
        await page.setContent(buildFixtureHtml(renderHeaderMarkup()));
        return await page.evaluate(() =>
          [
            '.chat-dock__active-identity-text',
            '.chat-dock__active-identity-agent',
            '.chat-dock__active-identity-engine',
            '.chat-dock__active-identity-title',
            '.chat-dock__project-context',
            '.chat-dock__project-badge',
            '.git-badge',
            '.git-badge__branch',
          ].map((selector) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`missing ${selector}`);
            const style = window.getComputedStyle(element);
            const fontSize = Number.parseFloat(style.fontSize) || 16;
            const parsedLineHeight = Number.parseFloat(style.lineHeight);
            return {
              selector,
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
              clientHeight: element.clientHeight,
              lineHeight: Number.isFinite(parsedLineHeight)
                ? parsedLineHeight
                : fontSize * 1.2,
              overflowX: style.overflowX,
              visible: element.getBoundingClientRect().width > 0,
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
      "the identity row's members yield to fit inside it at %ipx",
      async (width) => {
        const measurements = await measure(width);
        const row = measurements.find(
          (entry) => entry.selector === '.chat-dock__active-identity-text',
        );
        if (!row) throw new Error('missing identity row');
        // THE defect: `flex-shrink: 0` on the agent name and model meant this
        // box's contents were wider than the box, and painted outside it.
        expect(
          doesNotFit(row),
          `${row.selector} holds ${row.scrollWidth}px of content in a ` +
            `${row.clientWidth}px box, so its members are painting outside it`,
        ).toBe(false);
      },
    );

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
      'the project name and branch each stay on one line at %ipx',
      async (width) => {
        const measurements = await measure(width);
        for (const selector of [
          '.chat-dock__project-badge',
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
        }
      },
    );

    test('renders the git branch at 800px, so the one-line check is not vacuous', async () => {
      const branch = (await measure(800)).find(
        (entry) => entry.selector === '.git-badge__branch',
      );
      expect(branch?.clientWidth).toBeGreaterThan(0);
    });

    test.each(DESKTOP_WIDTHS)(
      'the session title keeps at least one glyph while the agent name yields, at %ipx',
      async (width) => {
        // #1536 L9/L10, under #1536 F's yield order: the engine token gives way
        // first, then the agent name, and the TITLE yields LAST — it is the row's
        // subject. (This originally read the other way round, off a
        // `flex-shrink: 4` on the title that F's measurement superseded and the
        // reconciliation deleted.) So the risk this pins is no longer "the title
        // was traded away first"; it is that a title which yields last can still
        // reach zero once everything ahead of it has already collapsed. One glyph
        // is the floor: an ellipsis alone still says "there is a title here,
        // truncated", which a zero-width box does not.
        //
        // Only the two desktop widths are driven here. Narrower than these the
        // identity row is `ChatDockActiveIdentity.overflow.test.tsx`'s subject,
        // not this file's — it measures real dock widths down to 260px (below
        // `MIN_DOCK_WIDTH`) and owns where each token starts truncating. 320px
        // keeps its place in the overflow assertions above, where it is the only
        // width that makes the containment constraint bite.
        const measurements = await measure(width);
        const title = measurements.find(
          (m) => m.selector === '.chat-dock__active-identity-title',
        );
        if (!title) throw new Error('missing title');
        expect(
          title.visible,
          `the session title box collapsed to ${title.clientWidth}px at ${width}px`,
        ).toBe(true);
        // A rendered glyph, not merely a non-zero box: below one character's
        // width there is nothing to read.
        expect(
          title.clientWidth,
          `the session title has ${title.clientWidth}px, under one glyph`,
        ).toBeGreaterThanOrEqual(title.lineHeight * 0.4);
      },
    );

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
