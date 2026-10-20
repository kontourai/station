/**
 * @vitest-environment jsdom
 *
 * Browser geometry for the real title/assistant markup and application CSS.
 * Protects the two-line hierarchy and legible title at the smallest side dock.
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
 * the project context, and the remaining spacer.
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

    test.each([850, 700, 520, 420, 320, 280])(
      'title, assistant, model and project remain readable without overprinting at %ipx',
      async (width) => {
        const page = await browser.newPage({
          viewport: { width: 1456, height: 800 },
        });
        try {
          await page.setContent(
            dockFixtureHtml(titleClusterMarkup(LONG_TITLE), width),
          );
          const geometry = await page.evaluate(() => {
            const box = (selector: string) => {
              const element = document.querySelector<HTMLElement>(selector);
              if (!element) throw new Error(`missing ${selector}`);
              const rect = element.getBoundingClientRect();
              return {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                width: rect.width,
              };
            };
            return {
              title: box('.chat-dock__active-identity-title'),
              agent: box('.chat-dock__active-identity-agent'),
              engine: box('.chat-dock__active-identity-engine'),
              close: box('.chat-dock__active-identity-close'),
              project: box('.chat-dock__project-badge'),
              header: box('.chat-dock__header'),
            };
          });
          expect(geometry.title.width).toBeGreaterThanOrEqual(
            width >= 420 ? 110 : 48,
          );
          expect(geometry.agent.width).toBeGreaterThan(24);
          expect(geometry.engine.width).toBeGreaterThan(24);
          expect(geometry.title.bottom).toBeLessThanOrEqual(
            geometry.agent.top + 1,
          );
          expect(geometry.agent.right).toBeLessThanOrEqual(
            geometry.engine.left + 1,
          );
          expect(geometry.close.right).toBeLessThanOrEqual(
            geometry.project.left + 1,
          );
          expect(geometry.project.right).toBeLessThanOrEqual(
            geometry.header.right + 1,
          );
          for (const item of [
            geometry.title,
            geometry.agent,
            geometry.engine,
            geometry.close,
          ]) {
            expect(item.left).toBeGreaterThanOrEqual(geometry.header.left);
            expect(item.right).toBeLessThanOrEqual(geometry.header.right + 1);
            expect(item.bottom).toBeLessThanOrEqual(geometry.header.bottom + 1);
          }
        } finally {
          await page.close();
        }
      },
    );
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
