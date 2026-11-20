/** @vitest-environment jsdom */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { chromium } from '@playwright/test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { resolveCssImports } from '../../../../../tests/helpers/css-cascade-fixture';
import { buildOrchestrationItems } from '../../../views/home/home-view-model';
import { buildWorkFacts } from '../../../views/home/work-facts';
import { InboxRow } from '../../chat-dock/ChatDockInboxRows';
import { renderHomeWorkRow } from '../../home/HomeWorkRow';
import { InboxRowStatusLine } from '../../inbox-row/InboxRowStatus';
import { ChatStatusPill } from '../ChatStatusPill';
import { deriveChatStatus } from '../chatStatus';

vi.mock('../../../contexts/ApiBaseContext', async (original) => ({
  ...(await original<typeof import('../../../contexts/ApiBaseContext')>()),
  useHostRequestAuthorityScope: () => null,
}));

// Browser-backed presentation fixture: real React markup and app CSS; no provider or Station instance.
test('request and background pills fit desktop and phone in both themes', async () => {
  const now = Date.now();
  const base = { approvalCount: 0, turnLive: false, waitingOnUser: false };
  const states = [
    { ...base, approvalCount: 1 },
    { ...base, inputCount: 1 },
    { ...base, inputCount: 1, approvalCount: 1 },
    {
      ...base,
      activity: {
        conversationId: 'c',
        asOfSequence: 1,
        runningChildWork: {
          count: 2,
          producers: [],
          oldestStartedAt: new Date(now - 192000).toISOString(),
        },
      },
    },
  ];
  const sessions: OrchestrationSessionSummary[] = [
    'Form only',
    'Permission only',
    'Both',
  ].map((title, i) => ({
    provider: 'claude',
    threadId: `request-${i}`,
    title,
    status: 'running',
    lifecycleState: 'review_pending',
    pendingReview: true, // The real writer sets this for forms too.
    openRequestIds:
      i === 2 ? ['form', 'permission'] : [i === 0 ? 'form' : 'permission'],
    blockingOpenRequestIds:
      i === 2 ? ['form', 'permission'] : [i === 0 ? 'form' : 'permission'],
    openRequestKinds: { form: 'input', permission: 'approval' },
    answerability: { answerable: true },
    controlMode: 'station-owned',
    isLoaded: true,
    isPersisted: true,
    eventCount: 2,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }));
  const items = buildOrchestrationItems(sessions, []);
  const workFacts = buildWorkFacts({ items, sessions });
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <div>
        <h2>Composer pills: permission, form, both, background</h2>
        {states.map((input, index) => (
          <div key={index} style={{ marginBottom: 24 }}>
            <ChatStatusPill
              status={deriveChatStatus(input)}
              onRevealApproval={() => {}}
            />
          </div>
        ))}
        <h2>Inbox</h2>
        {items.map((item) => (
          <InboxRow
            key={item.id}
            item={item}
            now={now}
            facts={workFacts.get(item.id)}
            isCurrent={false}
            isSnoozed={false}
            isOpenChat={false}
            chrome="touch"
            onActivate={() => {}}
          />
        ))}
        <h2>Home · Needs you</h2>
        {items.map((item) =>
          renderHomeWorkRow({
            task: { ...item, stableId: item.id },
            agents: [],
            isWoken: false,
            onOpen: () => {},
            context: {
              now,
              workFacts,
              detailsFor: null,
              setDetailsFor: () => {},
              chrome: 'touch',
            },
          }),
        )}
        <InboxRowStatusLine
          id="running-row"
          now={now}
          status={{
            rung: 'running',
            lane: 'running',
            word: 'Running',
            detail: 'Bash',
            tone: 'active',
            since: now - 121000,
            line: 'Running · Bash · 2m 1s',
          }}
        />
        <InboxRowStatusLine
          id="input-row"
          now={now}
          status={{
            rung: 'answer',
            word: 'Needs input',
            line: 'Needs input',
            lane: 'needsYou',
            tone: 'attention',
          }}
        />
      </div>
    </QueryClientProvider>,
  );
  const css = [
    '../../../index.css',
    '../live-status.css',
    '../../inbox-row/InboxRow.css',
    '../../home/HomeWorkRow.css',
    '../../icons/BrandIcon.css',
    '../../icons/ProjectIcon.css',
  ]
    .map((p) => resolveCssImports(resolve(import.meta.dirname, p)))
    .join('\n');
  const browser = await chromium.launch();
  const artifacts = resolve('.surface/ux-lane-A');
  await mkdir(artifacts, { recursive: true });
  try {
    for (const width of [390, 412, 1440])
      for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({
          viewport: { width, height: 915 },
          reducedMotion: 'reduce',
        });
        try {
          await page.setContent(
            `<html data-theme="${theme}"><head><style>${css}</style></head><body style="padding:16px">${view.container.innerHTML}</body></html>`,
          );
          await page.evaluate(() => document.fonts.ready);
          expect(
            await page.getByText('Needs input', { exact: true }).count(),
          ).toBe(4);
          expect(
            await page
              .getByText('2 background tasks running', { exact: true })
              .count(),
          ).toBe(1);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
          ).toBe(false);
          await page.screenshot({
            path: resolve(artifacts, `status-${width}-${theme}.png`),
            fullPage: true,
          });
        } finally {
          await page.close();
        }
      }
  } finally {
    await browser.close();
    cleanup();
  }
});
