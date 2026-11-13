/** @vitest-environment jsdom */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../../../tests/helpers/css-cascade-fixture';
import { InboxRowStatusLine } from '../../inbox-row/InboxRowStatus';
import { ChatStatusPill } from '../ChatStatusPill';
import { deriveChatStatus } from '../chatStatus';

// Browser-backed presentation fixture: real React markup and app CSS; no provider or Station instance.
test('request and background pills fit desktop and phone in both themes', async () => {
  const now = Date.now();
  const base = { approvalCount: 0, turnLive: false, waitingOnUser: false };
  const states = [
    { ...base, approvalCount: 1 },
    { ...base, inputCount: 1 },
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
  const view = render(
    <div>
      {states.map((input, index) => (
        <div key={index} style={{ marginBottom: 24 }}>
          <ChatStatusPill
            status={deriveChatStatus(input)}
            onRevealApproval={() => {}}
          />
        </div>
      ))}
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
          word: 'Needs answer',
          line: 'Needs answer',
          lane: 'needsYou',
          tone: 'attention',
        }}
      />
    </div>,
  );
  const css = [
    '../../../index.css',
    '../live-status.css',
    '../../inbox-row/InboxRow.css',
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
            await page.getByText('Needs answer', { exact: true }).count(),
          ).toBe(2);
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
