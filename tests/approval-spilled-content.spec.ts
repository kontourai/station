import { expect, type Page } from '@playwright/test';
import { test } from './helpers/fixture-audit';
import {
  dismissSetupLauncher,
  installMockOrchestrationConversationEventWindow,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  openChatRegion,
  seedActiveChats,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

/**
 * docs/design/event-content-spill.md, in a real browser: an approval whose
 * content Station stored out of line offers only Deny until the card has
 * loaded the whole request through the content route, then shows the loaded
 * content and offers Allow, and the allow carries the proof of the load.
 * The event windows are fixtures shaped like EventStore's stored form; the
 * content route and `respondToRequest` are captured at their real paths.
 */

const CONTENT = Array.from(
  { length: 1200 },
  (_, index) => `export const value${index} = ${index};`,
).join('\n');
const REF = `sha256-${'e'.repeat(64)}`;
const contentRef = {
  $stationContent: 1,
  ref: REF,
  kind: 'string',
  bytes: CONTENT.length,
  length: CONTENT.length,
  preview: CONTENT.slice(0, 120),
};

const EVENTS = [
  {
    method: 'turn.started',
    provider: 'claude',
    threadId: 'session-1',
    turnId: 'turn-1',
    createdAt: '2026-10-26T12:00:00.000Z',
    prompt: 'Write the generated constants file',
  },
  {
    method: 'tool.started',
    provider: 'claude',
    threadId: 'session-1',
    turnId: 'turn-1',
    itemId: 'toolu_1',
    toolCallId: 'toolu_1',
    toolName: 'Write',
    createdAt: '2026-10-26T12:00:01.000Z',
    spilledContent: { v: 1, count: 1, bytes: CONTENT.length },
    arguments: { file_path: '/repo/src/generated.ts', content: contentRef },
  },
  {
    method: 'request.opened',
    provider: 'claude',
    threadId: 'session-1',
    turnId: 'turn-1',
    createdAt: '2026-10-26T12:00:02.000Z',
    eventId: 'evt-approval-big',
    requestId: 'approval-big',
    requestType: 'approval',
    title: 'Allow Write',
    spilledContent: { v: 1, count: 1, bytes: CONTENT.length },
    payload: {
      toolName: 'Write',
      toolCallId: 'toolu_1',
      toolInput: { file_path: '/repo/src/generated.ts', content: contentRef },
      suggestions: [],
    },
  },
];

/**
 * Wait until the layout stops moving (the sheet's entrance, content that
 * just loaded): two frames apart, every dialog and the main region keep the
 * same box.
 */
async function settled(page: Page) {
  const boxes = () =>
    page.evaluate(
      () =>
        new Promise<string>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve(
                JSON.stringify(
                  [...document.querySelectorAll('[role="dialog"], main')].map(
                    (element) => {
                      const box = element.getBoundingClientRect();
                      return [box.x, box.y, box.width, box.height];
                    },
                  ),
                ),
              ),
            ),
          ),
        ),
    );
  let previous = await boxes();
  await expect
    .poll(async () => {
      const current = await boxes();
      const stable = current === previous;
      previous = current;
      return stable;
    })
    .toBe(true);
}

async function openChat(
  page: Page,
  viewport: { width: number; height: number },
  colorScheme: 'light' | 'dark',
) {
  await seedActiveChats(page, [
    {
      sessionId: 'session-1',
      conversationId: 'conv-1',
      agentSlug: 'dev-agent',
      model: 'claude-sonnet',
      provider: 'claude',
      orchestrationSessionStarted: true,
      ephemeralMessages: [],
      inputHistory: [],
    },
  ]);
  await installMockOrchestrationSse(page);
  await seedOrchestrationRoutes(page);
  await installMockOrchestrationEventWindow(page, 'claude', {
    'session-1': EVENTS,
  });
  await installMockOrchestrationConversationEventWindow(page, (id) =>
    id === 'conv-1' ? ['session-1'] : [],
  );
  await page.route('**/api/orchestration/sessions/read-model', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [
          {
            threadId: 'session-1',
            provider: 'claude',
            status: 'running',
            lifecycleState: 'running',
            hasActiveTurn: true,
            controlMode: 'station-owned',
            answerability: { answerable: true },
            isLoaded: true,
            isPersisted: true,
            eventCount: EVENTS.length,
            createdAt: '2026-10-26T12:00:00.000Z',
            updatedAt: '2026-10-26T12:00:02.000Z',
          },
        ],
      }),
    }),
  );
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const contentReads: string[] = [];
  await page.route(
    '**/api/orchestration/sessions/session-1/content/**',
    async (route) => {
      contentReads.push(new URL(route.request().url()).pathname);
      await released;
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Station-Content-Kind': 'string',
          'X-Station-Content-Bytes': String(CONTENT.length),
          'X-Station-Content-Complete': 'true',
        },
        body: CONTENT,
      });
    },
  );
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/orchestration/commands', async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { result: null, receipt: { status: 'accepted' } },
      }),
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/projects/dev/layouts/code?chat=conv-1');
  await dismissSetupLauncher(page);
  await openChatRegion(page);
  await waitForMockOrchestrationSse(page);
  await page.evaluate((theme) => {
    document.documentElement.setAttribute('data-theme', theme);
  }, colorScheme);
  if (viewport.width < 1440) await page.setViewportSize(viewport);
  return { release, posted, contentReads };
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`a spilled approval offers Allow only after loading it whole at 1440 (${colorScheme})`, async ({
    page,
  }, testInfo) => {
    const { release, posted, contentReads } = await openChat(
      page,
      { width: 1440, height: 900 },
      colorScheme,
    );
    const dock = page.locator('body');
    await expect(
      dock.getByText('Loading the full request before it can be allowed…'),
    ).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Allow Once' })).toHaveCount(
      0,
    );
    await expect(dock.getByRole('button', { name: 'Deny' })).toBeVisible();
    expect(contentReads.length).toBeGreaterThan(0);
    await settled(page);
    await page.screenshot({
      path: testInfo.outputPath(
        `spilled-approval-loading-1440-${colorScheme}.png`,
      ),
    });

    release();
    const allow = dock.getByRole('button', { name: 'Allow Once' });
    await expect(allow).toBeVisible();
    await expect(
      dock.getByText('export const value1199 = 1199;'),
    ).toBeAttached();
    await settled(page);
    await page.screenshot({
      path: testInfo.outputPath(
        `spilled-approval-loaded-1440-${colorScheme}.png`,
      ),
    });

    await allow.click();
    await expect
      .poll(() => posted.filter((c) => c.type === 'respondToRequest'))
      .toHaveLength(1);
    const [answer] = posted.filter((c) => c.type === 'respondToRequest');
    expect(answer).toMatchObject({
      requestId: 'approval-big',
      expectedRequestEventId: 'evt-approval-big',
      decision: 'accept',
      viewedContentDigest: expect.stringMatching(/^sha256-[0-9a-f]{64}$/),
    });
  });

  test(`a spilled approval offers Allow only after loading it whole at 390 (${colorScheme})`, async ({
    page,
  }, testInfo) => {
    const { release } = await openChat(
      page,
      { width: 390, height: 844 },
      colorScheme,
    );
    const sheet = page.getByRole('dialog', { name: /Needs approval/ });
    await expect(sheet).toBeVisible();
    await expect(
      sheet.getByText('Loading the full request before it can be allowed…'),
    ).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Allow Once' })).toHaveCount(
      0,
    );
    await settled(page);
    await page.screenshot({
      path: testInfo.outputPath(
        `spilled-approval-loading-390-${colorScheme}.png`,
      ),
    });
    release();
    await expect(
      sheet.getByRole('button', { name: 'Allow Once' }),
    ).toBeVisible();
    // However long the loaded request, the decision stays on screen.
    await expect(
      sheet.getByText('export const value1199 = 1199;'),
    ).toBeAttached();
    await settled(page);
    await expect(
      sheet.getByRole('button', { name: 'Allow Once' }),
    ).toBeInViewport();
    await expect(sheet.getByRole('button', { name: 'Deny' })).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath(
        `spilled-approval-loaded-390-${colorScheme}.png`,
      ),
    });
  });
}

const PROMPT = Array.from(
  { length: 900 },
  (_, index) => `Requirement ${index}: keep the generated file stable.`,
).join('\n');
const promptRef = {
  $stationContent: 1,
  ref: `sha256-${'a'.repeat(64)}`,
  kind: 'string',
  bytes: PROMPT.length,
  length: PROMPT.length,
  preview: PROMPT.slice(0, 120),
};
const outputRef = { ...contentRef, ref: `sha256-${'b'.repeat(64)}` };
const HISTORY = [
  {
    method: 'turn.started',
    provider: 'claude',
    threadId: 'session-1',
    turnId: 'turn-1',
    createdAt: '2026-10-26T12:00:00.000Z',
    spilledContent: { v: 1, count: 1, bytes: PROMPT.length },
    prompt: promptRef,
  },
  {
    method: 'tool.started',
    provider: 'claude',
    threadId: 'session-1',
    turnId: 'turn-1',
    itemId: 'toolu_r',
    toolCallId: 'toolu_r',
    toolName: 'Read',
    createdAt: '2026-10-26T12:00:01.000Z',
    arguments: { file_path: '/repo/src/generated.ts' },
  },
  {
    method: 'tool.completed',
    provider: 'claude',
    threadId: 'session-1',
    turnId: 'turn-1',
    itemId: 'toolu_r',
    toolCallId: 'toolu_r',
    toolName: 'Read',
    status: 'success',
    createdAt: '2026-10-26T12:00:02.000Z',
    spilledContent: { v: 1, count: 1, bytes: CONTENT.length },
    output: outputRef,
  },
  {
    method: 'turn.completed',
    provider: 'claude',
    threadId: 'session-1',
    turnId: 'turn-1',
    createdAt: '2026-10-26T12:00:03.000Z',
    outputText: 'Read it.',
  },
];

for (const colorScheme of ['light', 'dark'] as const) {
  test(`spilled history loads on request at 1440 (${colorScheme})`, async ({
    page,
  }, testInfo) => {
    await seedActiveChats(page, [
      {
        sessionId: 'session-1',
        conversationId: 'conv-1',
        agentSlug: 'dev-agent',
        model: 'claude-sonnet',
        provider: 'claude',
        orchestrationSessionStarted: true,
        ephemeralMessages: [],
        inputHistory: [],
      },
    ]);
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
    await installMockOrchestrationEventWindow(page, 'claude', {
      'session-1': HISTORY,
    });
    await installMockOrchestrationConversationEventWindow(page, (id) =>
      id === 'conv-1' ? ['session-1'] : [],
    );
    await page.route(
      '**/api/orchestration/sessions/session-1/content/**',
      async (route) => {
        const ref = new URL(route.request().url()).pathname.split('/').at(-1);
        const body = ref === promptRef.ref ? PROMPT : CONTENT;
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Station-Content-Kind': 'string',
            'X-Station-Content-Bytes': String(body.length),
            'X-Station-Content-Complete': 'true',
          },
          body,
        });
      },
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/projects/dev/layouts/code?chat=conv-1');
    await dismissSetupLauncher(page);
    await openChatRegion(page);
    await waitForMockOrchestrationSse(page);
    await page.evaluate((theme) => {
      document.documentElement.setAttribute('data-theme', theme);
    }, colorScheme);
    const loads = page.getByRole('button', { name: 'Load full content' });
    await expect(loads.first()).toBeVisible();
    await page.getByText('Read generated.ts').first().click();
    await page.screenshot({
      path: testInfo.outputPath(
        `spilled-history-preview-1440-${colorScheme}.png`,
      ),
    });
    const count = await loads.count();
    for (let index = 0; index < count; index += 1) await loads.first().click();
    await expect(
      page.getByText('Requirement 899', { exact: false }),
    ).toBeAttached();
    await expect(
      page.getByText('export const value1199 = 1199;', { exact: false }),
    ).toBeAttached();
    await page.screenshot({
      path: testInfo.outputPath(
        `spilled-history-loaded-1440-${colorScheme}.png`,
      ),
    });
  });
}
