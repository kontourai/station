import { expect, test } from '@playwright/test';
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
test('needs_input attention answer field stays genuinely visible once the viewport goes compact (keyboard-open)', async ({
  page,
}) => {
  // Short viewport height simulates the on-screen keyboard shrinking the
  // visual viewport: headless Chromium has no real OS keyboard, but
  // window.visualViewport.height tracks window.innerHeight absent one, so a
  // genuinely short layout viewport reproduces the same
  // visualViewport.height <= 620 signal SessionsView reacts to.
  await page.setViewportSize({ width: 390, height: 560 });

  const threadId = 'claude:1785191319504';
  const session = {
    provider: 'claude',
    threadId,
    status: 'ready',
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:05:00.000Z',
    controlMode: 'station-owned',
    lifecycleState: 'needs_input',
    model: 'claude-fable-5',
    projectSlug: 'dev',
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

  await installMockOrchestrationSse(page);
  await seedOrchestrationRoutes(page);
  await page.route('**/api/attention', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          items: [
            {
              id: `needs_input:${threadId}`,
              kind: 'needs_input',
              title: 'Input needed',
              createdAt: '2026-07-28T09:04:00.000Z',
              updatedAt: '2026-07-28T09:05:00.000Z',
              sessionId: threadId,
              openHref: `/activity?session=${encodeURIComponent(threadId)}`,
              source: { threadId },
            },
          ],
          pendingCount: 1,
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

  await page.goto(`/activity?session=${encodeURIComponent(threadId)}`);
  const detail = page.getByTestId('session-detail');
  await detail.waitFor({ state: 'visible' });

  // Confirm the compact variant is actually engaged — the exact condition
  // that used to hide the answer form.
  await expect(detail).toHaveClass(/sessions-detail--viewport-compact/);

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

  // archive#1170 (HIGH #3): .sessions-detail__header used
  // to be hidden entirely at this exact viewport, taking the page's title
  // and status badge with it — reproduced live at 390x560 with a `failed`
  // session (title/prompt, status badge, live indicator, and Stop task all
  // disappeared; only failure text and the collapsed diagnostics summary
  // remained). This session is `needs_input`, not `failed`, but the header
  // rule is not state-specific, so it must hold here too.
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
});

/**
 * archive#1170 (HIGH #3) regression guard.
 *
 * `.sessions-detail__header` used to be hidden entirely (`display: none`)
 * in the same compact-viewport media query the sibling test above covers —
 * reproduced live at 390x560 with a `failed` session: title/prompt, status
 * badge, live indicator, and Stop task all disappeared, leaving only the
 * failure text and the collapsed diagnostics summary. The owner's original
 * archive#1170 complaint came from a phone, so the exact moment the keyboard
 * opens is when "what am I looking at" (title) and "what state is it in"
 * (status badge) matter most — this asserts both survive, using the same
 * real-CSS technique as the sibling test (`getComputedStyle`, a non-zero
 * bounding box, and `toBeVisible()`), not DOM presence alone.
 */
test('failed session keeps its title and status badge visible once the viewport goes compact', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 560 });

  const threadId = 'claude:1785191319999';
  const session = {
    provider: 'claude',
    threadId,
    status: 'failed',
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-28T09:05:00.000Z',
    controlMode: 'station-owned',
    lifecycleState: 'failed',
    model: 'claude-fable-5',
    projectSlug: 'dev',
    blockedReason: 'Claude model "claude-fable-5" failed: rate limited',
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

  await installMockOrchestrationSse(page);
  await seedOrchestrationRoutes(page);
  await page.route('**/api/attention', (route) =>
    route.fulfill({
      json: { success: true, data: { items: [], pendingCount: 0 } },
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

  await page.goto(`/activity?session=${encodeURIComponent(threadId)}`);
  const detail = page.getByTestId('session-detail');
  await detail.waitFor({ state: 'visible' });

  await expect(detail).toHaveClass(/sessions-detail--viewport-compact/);

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
  // Lifecycle labels are user-facing title case; the underlying lifecycle
  // state remains the lowercase `failed` fixture value above.
  await expect(status).toHaveText('Failed');
});
