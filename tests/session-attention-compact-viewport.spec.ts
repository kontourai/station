import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  installMockOrchestrationSse,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

/**
 * archive#1170 (HIGH #1) regression guard.
 *
 * The session detail page hides its generic compose box whenever a
 * needs_input session's AttentionCard is showing its own answer form (see
 * `hideGenericCompose` in SessionsView.tsx) — so that answer form is the
 * ONLY way to respond once a live in-turn request isn't already covering
 * it. `.sessions-detail__attention` (the block containing that form) used
 * to be hidden by the compact-viewport media query, which is exactly the
 * condition an on-screen mobile keyboard produces
 * (`visualViewport.height <= 620` in `SessionsView.tsx`) — so the one
 * control this page exists to offer disappeared the moment someone
 * actually tried to use it on a phone.
 *
 * This MUST be a real-browser check: an RTL/jsdom test can only prove the
 * textarea is present in the DOM, never that it is visible — jsdom does
 * not load or apply stylesheets, so a `display: none` regression is
 * invisible to it. `getComputedStyle` and
 * `boundingBox()` here read the real CSS cascade.
 */
const THREAD_ID = {
  needs_input: 'claude:1785191319504',
  failed: 'claude:1785191319999',
} as const;

/**
 * Opens one Station-owned session's detail at 390x560. The short height is
 * the on-screen keyboard: headless Chromium has no real OS keyboard, but
 * window.visualViewport.height tracks window.innerHeight absent one, so a
 * genuinely short layout viewport reproduces the same
 * visualViewport.height <= 620 signal SessionsView reacts to. Returns the
 * detail once the compact variant is actually engaged — the exact condition
 * both regressions below were hidden by.
 */
async function openCompactSessionDetail(
  page: Page,
  lifecycleState: keyof typeof THREAD_ID,
) {
  await page.setViewportSize({ width: 390, height: 560 });

  const threadId = THREAD_ID[lifecycleState];
  const session = {
    provider: 'claude',
    threadId,
    status: lifecycleState === 'failed' ? 'failed' : 'ready',
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:05:00.000Z',
    controlMode: 'station-owned',
    lifecycleState,
    model: 'claude-fable-5',
    projectSlug: 'dev',
    ...(lifecycleState === 'failed'
      ? { blockedReason: 'Claude model "claude-fable-5" failed: rate limited' }
      : {}),
  };
  const events = [
    {
      eventId: 'e1',
      provider: 'claude',
      threadId,
      createdAt: '2026-07-28T09:00:05.000Z',
      turnId: 't1',
      method: 'turn.started',
      prompt: 'Investigate the failing nightly build and report back',
    },
  ];
  const attentionItems =
    lifecycleState === 'needs_input'
      ? [
          {
            id: `needs_input:${threadId}`,
            kind: 'needs_input',
            title: 'Input needed',
            createdAt: '2026-07-28T09:04:00.000Z',
            updatedAt: '2026-07-28T09:05:00.000Z',
            sessionId: threadId,
            openHref: `/?surface=activity&session=${encodeURIComponent(threadId)}`,
            source: { threadId },
          },
        ]
      : [];

  await installMockOrchestrationSse(page);
  await seedOrchestrationRoutes(page);
  await page.route('**/api/attention', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          items: attentionItems,
          pendingCount: attentionItems.length,
        },
      },
    }),
  );
  await page.route('**/api/projects/*/workflow/tasks', (route) =>
    route.fulfill({ json: { success: true, data: [] } }),
  );
  await page.route('**/api/orchestration/sessions/**', (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    const last = parts.at(-1);
    if (last === 'read-model') {
      return route.fulfill({ json: { success: true, data: [session] } });
    }
    if (last === 'flow-run') {
      return route.fulfill({ json: { success: true, data: null } });
    }
    return route.fulfill({
      json: { success: true, data: { session, events } },
    });
  });

  await page.goto(`/?surface=activity&session=${encodeURIComponent(threadId)}`);
  const detail = page.getByTestId('session-detail');
  await detail.waitFor({ state: 'visible' });
  await expect(detail).toHaveClass(/sessions-detail--viewport-compact/);
  return detail;
}

/**
 * archive#1170 (HIGH #3): `.sessions-detail__header` used to be hidden
 * entirely (`display: none`) at this exact viewport — reproduced live at
 * 390x560 with a `failed` session: title/prompt, status badge, live
 * indicator, and Stop task all disappeared. The header rule is not
 * state-specific, so both lifecycle states below assert it survives, using
 * real CSS (`getComputedStyle`, a non-zero bounding box, `toBeVisible()`),
 * not DOM presence alone.
 */
async function expectIdentityHeaderVisible(detail: Locator) {
  const title = detail.locator('h2');
  await expect(title).toBeVisible();
  const titleBox = await title.boundingBox();
  expect(titleBox, 'bounding box of the session title').not.toBeNull();
  expect(titleBox?.width ?? 0, 'title width').toBeGreaterThan(0);
  expect(titleBox?.height ?? 0, 'title height').toBeGreaterThan(0);

  const status = detail.locator('.sessions-detail__status');
  await expect(status).toBeVisible();
  const statusDisplay = await status.evaluate(
    (el) => getComputedStyle(el).display,
  );
  expect(statusDisplay, 'computed display of the status badge').not.toBe(
    'none',
  );
  return status;
}

test('needs_input attention answer field stays genuinely visible once the viewport goes compact (keyboard-open)', async ({
  page,
}) => {
  const detail = await openCompactSessionDetail(page, 'needs_input');

  const attentionBlock = page.getByTestId('session-attention');
  const display = await attentionBlock.evaluate(
    (el) => getComputedStyle(el).display,
  );
  expect(display, 'computed display of .sessions-detail__attention').not.toBe(
    'none',
  );

  const answer = page.getByLabel('Answer this session');
  const box = await answer.boundingBox();
  expect(box, 'bounding box of the answer textarea').not.toBeNull();
  expect(box?.width ?? 0, 'answer textarea width').toBeGreaterThan(0);
  expect(box?.height ?? 0, 'answer textarea height').toBeGreaterThan(0);

  // Playwright's own actionability check — real layout, real CSS cascade.
  await expect(answer).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send answer' })).toBeVisible();

  await expectIdentityHeaderVisible(detail);
});

test('failed session keeps its title and status badge visible once the viewport goes compact', async ({
  page,
}) => {
  const detail = await openCompactSessionDetail(page, 'failed');
  const status = await expectIdentityHeaderVisible(detail);
  // Lifecycle labels are user-facing title case; the underlying lifecycle
  // state remains the lowercase `failed` fixture value.
  await expect(status).toHaveText('Failed');
});
