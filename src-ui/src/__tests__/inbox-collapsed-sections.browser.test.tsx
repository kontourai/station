import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The production desktop inbox list with every section collapsed and the
// open chat in one of them, as in the owner's screenshot.
const inboxFixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {InboxGroupList} from './src-ui/src/components/chat-dock/ChatDockInboxRows';
import './src-ui/src/components/chat-dock/ChatDockInboxPanel.css';
import {buildOrchestrationItems} from './src-ui/src/views/home/home-view-model';
import {FOLD_FIXTURES, FOLD_SESSION_CREATED_AT} from './tests/helpers/session-summary-fold-fixtures';
const NOW = Date.parse('2026-09-30T10:01:15.000Z');
const session = (threadId, displayTitle) => ({
  provider: 'claude', status: 'running', createdAt: FOLD_SESSION_CREATED_AT,
  controlMode: 'station-owned', answerability: {answerable: true}, isLoaded: true,
  isPersisted: true, eventCount: 2, projectSlug: 'station',
  ...FOLD_FIXTURES.runningTool.summary,
  updatedAt: '2026-09-30T10:00:15.000Z',
  lifecycleState: 'idle', hasActiveTurn: false, conversationActivity: undefined,
  // Last: the fold fixture carries its own thread id and title.
  threadId, displayTitle, conversationId: threadId,
});
const items = buildOrchestrationItems([
  session('T1', 'Is this machine getting overwhelmed?'),
  session('T2', 'Release notes draft'),
  session('T3', 'Inventory event-row readers'),
  session('T4', 'A third-party session'),
], []);
const groups = [
  {id: 'running', label: 'Working', items: [items[2]]},
  {id: 'open', label: 'Open', items: [items[1], items[0]]},
  {id: 'external', label: 'Third-party', items: [items[3]]},
];
`;

const fixture = `${inboxFixture}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={new QueryClient()}>
    <div className="chat-dock-inbox" style={{height: '100vh', background: 'var(--bg-primary)', color: 'var(--text-primary)'}}>
      <div className="chat-dock-inbox__scroll" data-testid="scroll">
        <InboxGroupList groups={groups} idPrefix="fixture" now={NOW}
          activeChatSessionId={items[0].orchestrationThreadId ?? items[0].chatSessionId}
          chrome="hover"
          collapsible={{sections: {running: false, open: false, external: false}, onToggle: () => {}}}
          onActivate={() => {}} onSnoozeWake={() => {}} />
      </div>
    </div>
  </QueryClientProvider>);
`;

test('collapsed inbox sections stack from the top and keep the open chat visible', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    const out = resolve('.kontourai/shell-chrome');
    mkdirSync(out, { recursive: true });
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      await page.setViewportSize({ width: 360, height: 800 });
      await page.getByText('Is this machine getting overwhelmed?').waitFor();
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((a) => a.finished)),
      );
      await page.screenshot({ path: `${out}/inbox-collapsed-${theme}.png` });
      const geometry = await page.evaluate(() => {
        const scroll = document
          .querySelector('[data-testid="scroll"]')!
          .getBoundingClientRect();
        const sections = [
          ...document.querySelectorAll('.chat-dock-inbox__group'),
        ];
        const open = sections.find((section) =>
          section.textContent?.startsWith('Open'),
        )!;
        return {
          scrollTop: scroll.top,
          firstTop: sections[0].getBoundingClientRect().top,
          openRows: [...open.querySelectorAll('[data-testid="inbox-row"]')].map(
            (row) => row.textContent,
          ),
          otherRows: sections
            .filter((section) => section !== open)
            .flatMap((section) => [
              ...section.querySelectorAll('[data-testid="inbox-row"]'),
            ]).length,
        };
      });
      // From the top: no empty space above the first collapsed header.
      expect(geometry.firstTop - geometry.scrollTop, theme).toBeLessThan(24);
      // The open chat stays listed under its collapsed header; nothing else.
      expect(geometry.openRows, theme).toHaveLength(1);
      expect(geometry.openRows[0], theme).toContain(
        'Is this machine getting overwhelmed?',
      );
      expect(geometry.otherRows, theme).toBe(0);
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 120_000);

const linkedPullRequestFixture = `${inboxFixture}
import {ConnectionsProvider} from '@kontourai/station-connect';
const link = {
  conversationId: items[0].conversationId,
  source: 'explicit',
  provider: 'github',
  host: 'github.com',
  repository: { owner: 'kontourai', name: 'station' },
  ref: '5582',
  observedAt: '2026-09-30T10:01:00.000Z',
  status: {
    state: 'current',
    title: 'Tighten the pull request snapshot',
    pullRequestState: 'OPEN',
    checks: 'failing',
    isDraft: false,
  },
};
function App() {
  const [received, setReceived] = useState(false);
  globalThis.receivePullRequest = () => setReceived(true);
  const workFacts = received
    ? new Map([[items[0].id, { pullRequests: [link] }]])
    : undefined;
  return <div className="chat-dock-inbox" style={{height: '100vh', background: 'var(--bg-primary)', color: 'var(--text-primary)'}}>
    <InboxGroupList groups={[{ id: 'open', label: 'Open', items: [items[0]] }]}
      idPrefix="fixture" now={NOW} activeChatSessionId={null}
      workFacts={workFacts} onActivate={() => {}} onSnoozeWake={() => {}} />
  </div>;
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={new QueryClient()}>
    <ConnectionsProvider defaultUrl={location.origin}><App/></ConnectionsProvider>
  </QueryClientProvider>
);
`;

test.each([
  ['desktop', { width: 1280, height: 800 }],
  ['phone-width', { width: 390, height: 844 }],
] as const)(
  'linked pull request facts preserve inbox row height at %s',
  async (size, viewport) => {
    const { browser, page, errors } = await scrollBrowserFixture(
      linkedPullRequestFixture,
    );
    try {
      await page.setViewportSize(viewport);
      await page.addStyleTag({
        content: resolveCssImports(
          resolve(import.meta.dirname, '../index.css'),
        ),
      });
      const out = resolve('.kontourai/shell-chrome');
      mkdirSync(out, { recursive: true });
      const row = page.getByTestId('inbox-row');
      const chip = row.getByRole('button', {
        name: 'Open pull request #5582 · Failing',
      });
      await row.waitFor();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      expect(await chip.count()).toBe(0);
      const before = await row.evaluate(
        (element) => element.getBoundingClientRect().height,
      );
      expect(before).toBeGreaterThan(0);

      await page.evaluate(() =>
        (
          globalThis as unknown as { receivePullRequest(): void }
        ).receivePullRequest(),
      );
      await chip.waitFor({ timeout: 5000 }).catch(async (error) => {
        throw new Error(
          JSON.stringify({
            errors,
            body: await page.locator('body').innerText(),
          }),
          { cause: error },
        );
      });
      expect(
        await row.evaluate((element) => element.getBoundingClientRect().height),
      ).toBe(before);

      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        await page.screenshot({
          path: `${out}/linked-pr-chip-${size}-${theme}.png`,
        });
        await row.getByRole('button', { name: /^Is this machine/ }).hover();
        const details = page.getByText('Tighten the pull request snapshot', {
          exact: true,
        });
        await details.waitFor({ timeout: 10000 });
        await page.screenshot({
          path: `${out}/linked-pr-hover-${size}-${theme}.png`,
        });
        await page.mouse.move(viewport.width - 1, viewport.height - 1);
        await details.waitFor({ state: 'hidden', timeout: 10000 });
      }
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
  120_000,
);
