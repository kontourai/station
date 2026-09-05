import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  buildLongSessionTurns,
  createLongSessionEventWindowHandler,
} from './fixtures/long-session';
import { backgroundPaint, contrastRatio } from './helpers/color-contrast';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import { E2E_STATION_COMPATIBILITY } from './helpers/current-station-contract';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import {
  dismissSetupLauncher,
  emitMockOrchestrationEvent,
  installMockOrchestrationSse,
  seedActiveChats,
} from './helpers/orchestration';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';
import {
  installVisualViewportFixture,
  setVisualViewport,
} from './helpers/visual-viewport';

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

async function expectSettledTouchTargetHeight(locator: Locator) {
  // Visibility begins at the first painted animation frame. Geometry must be
  // sampled after the opening scale reaches its resting size, especially when
  // a loaded whole-file run advances frames more slowly than a focused case.
  await expect
    .poll(async () => (await locator.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
}

async function mockChatShell(
  page: Page,
  options: { expectedEnvironmentId?: string } = {},
) {
  let providerCalls = 0;
  page.on('pageerror', (error) => {
    console.error(`mobile-chat page error: ${error.message}`);
  });
  await installVisualViewportFixture(page);
  await page.addInitScript((expectedEnvironmentId) => {
    localStorage.setItem('station-connect-connections-active', 'mobile');
    localStorage.setItem(
      'station-connect-connections',
      JSON.stringify([
        {
          id: 'mobile',
          name: 'Mobile',
          url: location.origin,
          ...(expectedEnvironmentId
            ? { environmentId: expectedEnvironmentId }
            : {}),
        },
      ]),
    );
  }, options.expectedEnvironmentId ?? null);
  await page.route('**/.well-known/station/v1', (route) =>
    route.fulfill(
      json({
        schemaVersion: 1,
        environmentId: '11111111-1111-4111-8111-111111111111',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
        transports: { http: 1, sse: 1, websocket: 1 },
        compatibility: E2E_STATION_COMPATIBILITY,
        capabilities: { sessionEventWindow: true },
      }),
    ),
  );
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    // `GET /api/plugins` answers `{ plugins: [...] }`, not the `{success,data}`
    // envelope the catch-all below returns. `PluginRegistry.ts:207-212`
    // destructures `plugins` and iterates it, so the envelope makes it throw,
    // land in `degraded`, and present the non-dismissible "Extensions
    // unavailable" chrome banner — which sits above the dock's stacking context
    // on mobile (`BannerHost.css:619-624`) and swallowed clicks on the composer
    // sheets, and whose reserved height pushed the maximized desktop dock past
    // the viewport.
    if (path === '/api/plugins') return route.fulfill(json({ plugins: [] }));
    if (path === '/api/orchestration/sessions/read-model')
      return route.fulfill(
        json({
          success: true,
          data: [
            {
              threadId: 'delegated-review',
              provider: 'codex',
              model: 'model-selected',
              projectSlug: 'default',
              assignedAgentSlug: 'station',
              delegation: { taskId: 'task:delegated-review' },
              status: 'ready',
              lifecycleState: 'needs_input',
              createdAt: '2026-07-19T10:06:00Z',
              updatedAt: '2026-07-19T10:06:00Z',
              isLoaded: true,
              isPersisted: true,
              eventCount: 1,
            },
          ],
        }),
      );
    if (/^\/api\/agents\/[^/]+\/chat$/.test(path)) {
      providerCalls += 1;
      return route.abort();
    }
    if (path === '/api/orchestration/delegations/options')
      return route.fulfill(
        json({
          success: true,
          data: {
            environment: {
              id: '11111111-1111-4111-8111-111111111111',
              name: 'Current environment',
              kind: 'current',
            },
            project: { slug: 'default' },
            targets: [
              {
                id: 'codex',
                name: 'Codex',
                kind: 'agent-app',
                ready: true,
                defaultModel: 'model-selected',
                models: [
                  {
                    id: 'model-default',
                    name: 'Default Test Model',
                    originalId: 'model-default',
                  },
                  {
                    id: 'model-selected',
                    name: 'Selected Test Model',
                    originalId: 'model-selected',
                  },
                ],
                capabilities: {
                  resume: true,
                  interrupt: true,
                  approvals: true,
                  modelSelection: true,
                },
              },
            ],
          },
        }),
      );
    if (path === '/api/orchestration/delegations')
      return route.fulfill(
        json({
          success: true,
          data: {
            taskId: 'task:mobile-delegation',
            sessionId: 'task:mobile-delegation',
            status: 'dispatched',
            environment: {
              id: 'mobile',
              name: 'This Station',
              kind: 'current',
            },
            target: { kind: 'agent-app', id: 'codex' },
            model: 'model-selected',
            resumable: true,
          },
        }),
      );
    if (path === '/api/agents')
      return route.fulfill(
        json({
          success: true,
          data: [
            {
              slug: 'station',
              name: 'Station',
              description: 'Local test agent',
              source: 'local',
              engineId: 'station',
              engineDisplayName: 'Station',
              engineDefault: true,
              available: true,
              model: 'model-default',
            },
            {
              slug: 'claude',
              name: 'Claude',
              description: 'Connected Claude test agent',
              source: 'local',
              engineId: 'claude',
              engineDisplayName: 'Claude',
              engineDefault: true,
              available: true,
              model: 'model-selected',
              execution: {
                agentConnectionId: 'claude',
                modelId: 'model-selected',
              },
            },
          ],
        }),
      );
    if (path === '/api/projects')
      return route.fulfill(
        json({
          success: true,
          data: [
            {
              id: 'default',
              slug: 'default',
              name: 'Default',
              hasWorkingDirectory: false,
              layoutCount: 0,
            },
          ],
        }),
      );
    if (path === '/api/connections/agents')
      return route.fulfill(
        json({
          success: true,
          data: [
            agentConnectionFixture({
              id: 'claude',
              kind: 'agent',
              type: 'claude',
              name: 'Claude',
              enabled: true,
              capabilities: ['agent-runtime', 'image-input', 'file-input'],
              config: {
                executionClass: 'external',
                defaultModel: 'model-selected',
              },
              status: 'ready',
              runtimeCatalog: {
                source: 'live',
                models: [
                  {
                    id: 'model-default',
                    name: 'Default Test Model',
                    originalId: 'model-default',
                  },
                  {
                    id: 'model-selected',
                    name: 'Selected Test Model',
                    originalId: 'model-selected',
                  },
                ],
                builtInModels: [],
              },
              prerequisites: [],
            }),
          ],
        }),
      );
    if (path === '/api/connections/models')
      return route.fulfill(
        json({
          success: true,
          data: [
            {
              id: 'ollama-local',
              kind: 'model',
              type: 'ollama',
              name: 'Ollama',
              enabled: true,
              capabilities: ['llm'],
              config: {},
              status: 'ready',
              prerequisites: [],
            },
          ],
        }),
      );
    if (path === '/api/system/status')
      return route.fulfill(
        json({
          ready: true,
          acp: { connected: false, connections: [] },
          providers: {
            configuredChatReady: true,
            configured: [],
            detected: {},
          },
          capabilities: {
            chat: { ready: true },
            runtime: { ready: false },
            knowledge: { ready: false },
            acp: { ready: false },
          },
          prerequisites: [],
          clis: {},
        }),
      );
    if (path === '/api/system/identity')
      return route.fulfill(
        json({
          environmentId: '11111111-1111-4111-8111-111111111111',
          bootId: 'mobile-test-boot',
        }),
      );
    if (path === '/api/system/capabilities')
      return route.fulfill(
        json({ voice: { stt: [], tts: [] }, context: { providers: [] } }),
      );
    if (path === '/api/attention')
      return route.fulfill(
        json({ success: true, data: { items: [], pendingCount: 0 } }),
      );
    if (path === '/api/models/capabilities')
      return route.fulfill(
        json({
          success: true,
          data: [{ modelId: 'model-default' }, { modelId: 'model-selected' }],
        }),
      );
    if (path === '/api/models')
      return route.fulfill(
        json({
          success: true,
          data: [
            {
              modelId: 'model-default',
              modelName: 'Default Test Model',
              outputModalities: ['TEXT'],
            },
            {
              modelId: 'model-selected',
              modelName: 'Selected Test Model',
              outputModalities: ['TEXT'],
            },
          ],
        }),
      );
    return route.fulfill(json({ success: true, data: [] }));
  });
  await page.route('**/config/app', (route) =>
    route.fulfill(
      json({ success: true, data: { defaultModel: 'test-model' } }),
    ),
  );
  await page.route(/\/agents\/station\/conversations(?:\?.*)?$/, (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          {
            id: 'conv-running',
            title: 'Mobile running task',
            agentSlug: 'station',
            updatedAt: '2026-07-19T10:00:00Z',
          },
          {
            id: 'conv-review',
            title: 'Mobile review task',
            agentSlug: 'station',
            updatedAt: '2026-07-19T10:05:00Z',
          },
        ],
      }),
    ),
  );
  await page.route('**/events', (route) => route.abort());
  return () => providerCalls;
}

async function openComposer(
  page: Page,
  projectScoped = false,
  agentSlug = 'claude',
) {
  await page.goto('/?dock=open');
  await dismissSetupLauncher(page);
  await openNewChat(page);
  // With exactly one chat-ready runtime, the visible New button intentionally
  // takes the one-click default path. Open the selection surface explicitly so
  // this helper can bind a runtime and optional project deterministically.
  await page.evaluate(() =>
    window.dispatchEvent(new Event('station:open-new-chat')),
  );
  const modal = page.getByRole('dialog', { name: 'New Chat' });
  await expect(modal).toBeVisible({ timeout: 15_000 });
  const runtimeRow = modal.locator(`[data-agent-slug="${agentSlug}"]`).first();
  const textarea = page.locator('textarea[placeholder*="Type a message"]');
  await expect(runtimeRow).toBeVisible({ timeout: 15_000 });
  if (projectScoped) {
    await page.locator('.new-chat-modal__context-button').click();
    const projectRow = page.locator('[data-context-value="default"]');
    await expect(projectRow).toBeVisible();
    await projectRow.click();
  }
  await runtimeRow.click();
  await expect(modal).toBeHidden();
  await expect(textarea).toBeVisible({ timeout: 15_000 });
  return textarea;
}

test('virtualizes a long real transcript while preserving reader controls on mobile', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatShell(page);
  await installMockOrchestrationSse(page);
  const threadId = 'thread-long-transcript';
  const turns = buildLongSessionTurns({ threadId });
  turns[9_997]?.splice(
    1,
    0,
    {
      eventId: 'turn-9997-tool-started',
      method: 'tool.started',
      provider: 'bedrock',
      threadId,
      turnId: 'turn-9997',
      itemId: 'tool-approval',
      toolCallId: 'call-approval',
      toolName: 'protected_write',
      arguments: { path: 'approved.txt' },
      createdAt: '2026-07-19T10:00:09.997Z',
    },
    {
      eventId: 'turn-9997-request-opened',
      method: 'request.opened',
      provider: 'bedrock',
      threadId,
      turnId: 'turn-9997',
      requestId: 'approval-browser',
      requestType: 'approval',
      title: 'Allow protected write',
      payload: { toolCallId: 'call-approval' },
      createdAt: '2026-07-19T10:00:09.998Z',
    },
  );
  turns[9_998]?.splice(
    1,
    0,
    {
      eventId: 'turn-9998-tool-started',
      method: 'tool.started',
      provider: 'bedrock',
      threadId,
      turnId: 'turn-9998',
      itemId: 'tool-error',
      toolCallId: 'call-error',
      toolName: 'failing_tool',
      arguments: { input: 'fixture' },
      createdAt: '2026-07-19T10:00:09.998Z',
    },
    {
      eventId: 'turn-9998-tool-completed',
      method: 'tool.completed',
      provider: 'bedrock',
      threadId,
      turnId: 'turn-9998',
      itemId: 'tool-error',
      toolCallId: 'call-error',
      toolName: 'failing_tool',
      status: 'error',
      error: 'browser fixture failure',
      createdAt: '2026-07-19T10:00:09.999Z',
    },
  );
  expect(
    new TextEncoder().encode(JSON.stringify(turns)).byteLength,
  ).toBeGreaterThanOrEqual(1_000_000);
  const persistedLiveTurn: Array<Record<string, unknown>> = [
    {
      eventId: 'turn-live-started',
      method: 'turn.started',
      provider: 'bedrock',
      threadId,
      turnId: 'turn-live',
      createdAt: '2026-07-19T10:09:59.000Z',
      prompt: 'Live question',
    },
    {
      eventId: 'turn-live-delta',
      method: 'content.text-delta',
      provider: 'bedrock',
      threadId,
      turnId: 'turn-live',
      itemId: 'turn-live',
      createdAt: '2026-07-19T10:10:00.000Z',
      delta: 'Live bounded streaming growth.',
    },
    {
      eventId: 'turn-live-completed',
      method: 'turn.completed',
      provider: 'bedrock',
      threadId,
      turnId: 'turn-live',
      createdAt: '2026-07-19T10:10:01.000Z',
      outputText: 'Live bounded streaming growth.',
    },
  ];
  let liveTurnPersisted = false;
  const requestedWindows: string[] = [];
  let messagesRequested = false;
  await page.route(
    `**/api/orchestration/sessions/${threadId}/event-window**`,
    createLongSessionEventWindowHandler({
      threadId,
      availableTurns: () =>
        liveTurnPersisted ? [...turns, persistedLiveTurn] : turns,
      onRequest: (url) => requestedWindows.push(url),
    }),
  );
  await page.route('**/api/orchestration/chat', (route) =>
    route.fulfill(
      json(
        foregroundMessageReceiptEnvelope({
          conversationId: threadId,
          agent: 'agent:station',
        }),
      ),
    ),
  );
  await page.route(
    `**/agents/station/conversations/${threadId}/messages`,
    (route) => {
      messagesRequested = true;
      return route.abort();
    },
  );
  await page.route(/\/agents\/station\/conversations(?:\?.*)?$/, (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          {
            id: threadId,
            title: 'Long transcript',
            agentSlug: 'station',
            updatedAt: '2026-07-19T10:00:00Z',
          },
        ],
      }),
    ),
  );
  await seedActiveChats(page, [
    {
      sessionId: threadId,
      conversationId: threadId,
      agentSlug: 'station',
      projectSlug: 'default',
      projectName: 'Default',
      model: 'model-selected',
      title: 'Long transcript',
      provider: 'bedrock',
      orchestrationSessionStarted: true,
    },
  ]);

  await page.goto(`/?dock=open&maximize=true&chat=${threadId}`);
  await dismissSetupLauncher(page);

  const transcript = page.locator('.chat-messages');
  await expect(transcript).toBeVisible({ timeout: 20_000 });
  await expect(transcript).toHaveAttribute('role', 'log');
  await expect(transcript).toHaveAttribute(
    'aria-label',
    'Conversation transcript',
  );
  expect(messagesRequested).toBe(false);
  expect(requestedWindows).toHaveLength(1);
  expect(new URL(requestedWindows[0]).searchParams.get('turnLimit')).toBe('10');
  await page.waitForFunction(
    () => (window as any).__mockOrchestrationSse?.count?.() === 1,
  );
  const composer = page.locator('textarea[placeholder*="Type a message"]');
  await composer.fill('Live question');
  await composer.press('Enter');
  await expect(
    transcript.getByText('Live question', { exact: true }),
  ).toHaveCount(1);
  const liveOrder = await transcript.evaluate((element) => {
    const text = element.textContent ?? '';
    return [
      text.indexOf('Transcript fixture 9999: prompt.'),
      text.indexOf('Transcript fixture 9999: retained content for selection.'),
      text.indexOf('Live question'),
    ];
  });
  expect(liveOrder.every((position) => position >= 0)).toBe(true);
  expect(liveOrder).toEqual([...liveOrder].sort((a, b) => a - b));
  // archive#2652 redesign: settled work renders inline as quiet rows in
  // reading order — there is no "Show N work activities" gate. The
  // awaiting-approval call surfaces its approval buttons without any
  // expansion step, and a failed call discloses "Failed" collapsed.
  await expect(
    page.getByRole('button', { name: 'Show 1 work activities' }),
  ).toHaveCount(0);
  // The Allow/Deny controls belong to the LIVE turn: `MessageContent.tsx:56-59`
  // supplies `onApprove` only when the row is the streaming message, and
  // `ToolCallDisplay.tsx:244-248` renders the buttons only when it has one. This
  // fixture plants the approval on turn 9997, three turns back, so what a
  // historical unresolved call surfaces — and what this line asserts — is the
  // awaiting marker itself, inline and without an expansion step. The buttons
  // are covered on the shape that actually wires them by
  // `tests/orchestration-chat-flow.spec.ts:196-199`.
  await expect(
    transcript.getByRole('button', { name: 'Edit approved.txt' }),
  ).toBeVisible();
  await expect(
    transcript.getByRole('img', { name: 'Awaiting approval' }),
  ).toBeVisible();
  // `callLabel` speaks the bare infinitive for an unresolved call
  // (`utils/tool-call-labels.ts:181-199`): "Used" is the resolved past tense.
  const failedWork = transcript.getByRole('button', {
    name: 'Use failing tool',
  });
  await expect(failedWork).toBeVisible();
  await expect(failedWork).toContainText('Failed');
  await failedWork.click();
  await expect(transcript.locator('.tool-call__code--error')).toContainText(
    'browser fixture failure',
  );

  const loadEarlier = page.getByRole('button', { name: 'Load earlier events' });
  await expect(loadEarlier).toBeVisible();
  for (let pageIndex = 1; pageIndex <= 3; pageIndex++) {
    await loadEarlier.click();
    await expect.poll(() => requestedWindows.length).toBe(pageIndex + 1);
    expect(
      new URL(requestedWindows[pageIndex]).searchParams.get('cursor'),
    ).toBe(`older-turns-${10 + (pageIndex - 1) * 20}`);
  }
  await expect
    .poll(async () => transcript.locator('[data-transcript-row]').count())
    .toBeGreaterThan(0);
  expect(
    await transcript.locator('[data-transcript-row]').count(),
  ).toBeLessThan(80);
  const anchoredRow = await transcript.evaluate((element) => {
    element.scrollTop = Math.max(
      1,
      element.scrollHeight - element.clientHeight - 500,
    );
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
    const bounds = element.getBoundingClientRect();
    const row = [
      ...element.querySelectorAll<HTMLElement>('[data-transcript-row]'),
    ].find(
      (candidate) => candidate.getBoundingClientRect().bottom > bounds.top,
    );
    return row
      ? {
          key: row.dataset.transcriptRow,
          offset: row.getBoundingClientRect().top - bounds.top,
        }
      : null;
  });
  expect(anchoredRow?.key).toBeTruthy();
  await loadEarlier.click();
  await expect.poll(() => requestedWindows.length).toBe(5);
  await expect
    .poll(() =>
      transcript.evaluate((element, anchor) => {
        const bounds = element.getBoundingClientRect();
        const row = [
          ...element.querySelectorAll<HTMLElement>('[data-transcript-row]'),
        ].find((candidate) => candidate.dataset.transcriptRow === anchor.key);
        return row
          ? Math.abs(
              row.getBoundingClientRect().top - bounds.top - anchor.offset,
            )
          : Number.POSITIVE_INFINITY;
      }, anchoredRow!),
    )
    .toBeLessThanOrEqual(2);
  const settledAnchorDrift = await transcript.evaluate(
    async (element, anchor) => {
      const samples: number[] = [];
      for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        const bounds = element.getBoundingClientRect();
        const row = [
          ...element.querySelectorAll<HTMLElement>('[data-transcript-row]'),
        ].find((candidate) => candidate.dataset.transcriptRow === anchor.key);
        samples.push(
          row
            ? Math.abs(
                row.getBoundingClientRect().top - bounds.top - anchor.offset,
              )
            : Number.POSITIVE_INFINITY,
        );
      }
      return samples;
    },
    anchoredRow!,
  );
  expect(Math.max(...settledAnchorDrift)).toBeLessThanOrEqual(2);

  for (let requestCount = 6; requestCount <= 11; requestCount++) {
    await loadEarlier.click();
    await expect.poll(() => requestedWindows.length).toBe(requestCount);
  }
  expect(requestedWindows).toHaveLength(11);
  const jumpToTail = page.getByRole('button', { name: 'Scroll to bottom' });
  await expect(jumpToTail).toBeVisible();
  await jumpToTail.focus();
  await page.keyboard.press('Enter');

  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      eventId: 'turn-live-started',
      method: 'turn.started',
      provider: 'bedrock',
      threadId,
      turnId: 'turn-live',
      createdAt: '2026-07-19T10:09:59.000Z',
      prompt: 'Live question',
    },
  });
  await expect(
    transcript.getByText('Live question', { exact: true }),
  ).toHaveCount(1);
  liveTurnPersisted = true;
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      eventId: 'turn-live-delta',
      method: 'content.text-delta',
      provider: 'bedrock',
      threadId,
      turnId: 'turn-live',
      itemId: 'turn-live',
      createdAt: '2026-07-19T10:10:00.000Z',
      delta: 'Live bounded streaming growth.',
    },
  });
  await expect(transcript).toContainText('Live bounded streaming growth.');
  await expect(
    transcript.getByText('Live bounded streaming growth.', { exact: true }),
  ).toHaveCount(1);
  const liveRowCount = Number(
    await transcript
      .getByTestId('virtualized-transcript-spacer')
      .getAttribute('data-transcript-row-count'),
  );
  expect(liveRowCount).toBeGreaterThan(0);
  expect(requestedWindows).toHaveLength(11);
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(32);

  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      eventId: 'turn-live-completed',
      method: 'turn.completed',
      provider: 'bedrock',
      threadId,
      turnId: 'turn-live',
      createdAt: '2026-07-19T10:10:01.000Z',
      outputText: 'Live bounded streaming growth.',
    },
  });
  await expect.poll(() => requestedWindows.length).toBe(12);
  await expect(
    transcript.getByText('Live question', { exact: true }),
  ).toHaveCount(1);
  await expect
    .poll(async () =>
      Number(
        await transcript
          .getByTestId('virtualized-transcript-spacer')
          .getAttribute('data-transcript-row-count'),
      ),
    )
    // The local prompt becomes one canonical user row and gains exactly one
    // terminal assistant row. A sliding-window refresh that drops the
    // displaced prior-newest turn would decrease this count instead.
    .toBe(liveRowCount + 1);
  const terminalOrder = await transcript.evaluate((element) => {
    const text = element.textContent ?? '';
    return [
      text.indexOf('Transcript fixture 9999: prompt.'),
      text.indexOf('Transcript fixture 9999: retained content for selection.'),
      text.indexOf('Live question'),
      text.indexOf('Live bounded streaming growth.'),
    ];
  });
  expect(terminalOrder.every((position) => position >= 0)).toBe(true);
  expect(terminalOrder).toEqual([...terminalOrder].sort((a, b) => a - b));
  await loadEarlier.click();
  await expect.poll(() => requestedWindows.length).toBe(13);
  expect(new URL(requestedWindows[12]).searchParams.get('cursor')).toBe(
    'older-turns-210',
  );

  // Selection is native browser selection on a production MessageBubble row;
  // virtual positioning must not turn completed text into a canvas or copy-only
  // control.
  const selection = await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll('.chat-messages p')].find(
      (candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      },
    );
    if (!paragraph) return { selectedText: '', userSelect: 'none' };
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const nativeSelection = window.getSelection();
    nativeSelection?.removeAllRanges();
    nativeSelection?.addRange(range);
    return {
      selectedText: nativeSelection?.toString() ?? '',
      userSelect: getComputedStyle(paragraph).userSelect,
    };
  });
  expect(selection.userSelect).not.toBe('none');
  expect(selection.selectedText).toContain('Transcript fixture');

  // Establish the current viewport height before simulating a reader scroll;
  // ChatMessageList intentionally treats a height change as a dock/keyboard
  // transition, not reader navigation.
  await transcript.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(jumpToTail).toBeVisible();
  await jumpToTail.focus();
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(32);

  await setVisualViewport(page, 500);
  const transcriptBox = await transcript.boundingBox();
  expect(
    (transcriptBox?.y ?? 0) + (transcriptBox?.height ?? 0),
  ).toBeLessThanOrEqual(500);
});

/**
 * Start a new chat through whichever affordance the current viewport actually
 * offers. Desktop keeps the dock's tab-action row; on a phone that row is gone
 * and New/Open/history live in the one-row header's overflow
 * (ChatDockMobileHeader). This helper is shared by mobile AND desktop specs, so
 * it must not assume either.
 */
/**
 * Take the mobile dock full-screen. Maximize/Restore are no longer permanent
 * buttons on a phone — the drag gesture owns dock height and the named
 * keyboard/agent path lives in the header overflow.
 */
async function expandMobileDock(page: Page) {
  await page.getByRole('button', { name: 'Chat actions' }).click();
  await page
    .getByRole('menu', { name: 'Chat actions' })
    .getByRole('menuitem', { name: /^Expand chat/ })
    .click();
}

async function openNewChat(page: Page) {
  const tabBarNew = page
    .locator('.chat-dock__tab-actions .chat-dock__new')
    .last();
  if (await tabBarNew.isVisible().catch(() => false)) {
    await expect(tabBarNew).toBeVisible({ timeout: 15_000 });
    return;
  }
  await page.getByRole('button', { name: 'Chat actions', exact: true }).click();
  await expect(
    page.getByRole('menuitem', { name: 'New chat', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close actions menu' }).click();
}

test('keeps mobile attachment selection reviewable without moving the draft', async ({
  page,
}) => {
  test.setTimeout(20_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatShell(page);
  const textarea = await openComposer(page);
  await textarea.fill('Review the attached notes');

  const attach = page.getByRole('button', { name: 'Attach files' });
  await expect(attach).toBeVisible();
  const attachBox = await attach.boundingBox();
  expect(attachBox?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  expect(attachBox?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

  await page.locator('.attachment-input').setInputFiles([
    {
      name: 'mobile-context.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Mobile context'),
    },
    {
      name: 'mobile-photo.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+Q5q9WQAAAABJRU5ErkJggg==',
        'base64',
      ),
    },
    {
      name: 'requirements.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Requirements'),
    },
    {
      name: 'review-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Review notes'),
    },
    {
      name: 'accessibility.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Accessibility'),
    },
  ]);
  await expect(
    page.getByRole('button', { name: 'Review 5 attachments' }),
  ).toBeVisible();
  await expect(textarea).toHaveValue('Review the attached notes');

  const reviewAttachments = page.getByRole('button', {
    name: 'Review 5 attachments',
  });
  await reviewAttachments.click();
  const menu = page.locator('.attachment-menu');
  await expect(menu).toBeVisible();
  await setVisualViewport(page, 360);
  await expect(menu).toContainText('mobile-context.md');
  await expect(menu).toContainText('mobile-photo.png');
  const menuBox = await menu.boundingBox();
  expect(menuBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(390);
  expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(360);
  const listBox = await menu.locator('.attachment-menu__list').boundingBox();
  expect((listBox?.y ?? 0) + (listBox?.height ?? 0)).toBeLessThanOrEqual(360);
  for (const label of ['Add more', 'Clear all']) {
    const box = await menu.getByRole('button', { name: label }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  }

  await setVisualViewport(page, 844);
  await textarea.click();
  await expect(menu).toBeHidden();
  await expect(textarea).toHaveValue('Review the attached notes');
  await reviewAttachments.click();
  await menu.getByRole('button', { name: 'Clear all' }).click();
  await expect(attach).toBeVisible();
  await expect(textarea).toHaveValue('Review the attached notes');
});

test('stages a current-host attachment before dispatching only its opaque reference', async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatShell(page);

  const stageId = 'stage_11111111-1111-4111-8111-111111111111';
  let prepared: Record<string, unknown> | undefined;
  const dispatched: unknown[] = [];
  await page.route(
    /\/api\/orchestration\/attachment-staging(?:\/.*)?$/u,
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/capability'))
        return route.fulfill(
          json({ state: 'supported', version: 1, maxConcurrentUploads: 3 }),
        );
      if (path.endsWith('/prepare')) {
        prepared = request.postDataJSON() as Record<string, unknown>;
        return route.fulfill(
          json({
            ...prepared,
            stageId,
            uploadGrant: 'a'.repeat(43),
            expiresAt: '2030-01-01T00:00:00.000Z',
          }),
        );
      }
      if (path.endsWith(`/${stageId}`) && request.method() === 'PUT')
        return route.fulfill(
          json({
            ...prepared,
            stageId,
            source: 'current-composer',
            digest: `sha256-${'a'.repeat(64)}`,
            expiresAt: '2030-01-01T00:00:00.000Z',
          }),
        );
      return route.abort();
    },
  );
  await page.route('**/api/orchestration/chat', async (route) => {
    dispatched.push(route.request().postDataJSON());
    return route.fulfill(
      json(
        foregroundMessageReceiptEnvelope({
          conversationId: 'staged-attachment-thread',
          agent: 'agent:claude',
        }),
      ),
    );
  });

  const textarea = await openComposer(page);
  await textarea.fill('Send the staged attachment');
  await page.locator('.attachment-input').setInputFiles({
    name: 'staged-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('stage me'),
  });

  const strip = page.getByRole('list', { name: 'Attached files' });
  await expect(strip.getByText('Ready to send')).toBeVisible();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(() => expect(dispatched).toHaveLength(1)).toPass({
    timeout: 10_000,
  });
  expect(dispatched[0]).toMatchObject({
    attachmentRefs: [
      {
        stageId,
        source: 'current-composer',
        name: 'staged-notes.txt',
      },
    ],
  });
  expect(JSON.stringify(dispatched[0])).not.toContain('c3RhZ2UgbWU=');
});

// archive#3344. The whole paste path against the STATION engine — the one an
// unbound Station agent uses, and the one whose composer used to refuse every
// image because no signal it read said yes. Three claims, each of which failed
// before the fix or would fail if the transport regressed: the paste attaches,
// the attachment is visible without opening a menu, and the dispatched turn
// carries the image bytes.
test('pasting an image into a Station-engine composer attaches it and sends it as image content', async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatShell(page);

  const dispatched: unknown[] = [];
  await page.route('**/api/orchestration/chat', async (route) => {
    dispatched.push(route.request().postDataJSON());
    return route.fulfill(
      json(
        foregroundMessageReceiptEnvelope({
          conversationId: 'paste-thread',
          agent: 'agent:station',
        }),
      ),
    );
  });

  const textarea = await openComposer(page, false, 'station');
  await textarea.fill('what is in this screenshot?');

  // A real clipboard paste, synthesized as the browser delivers one: a
  // DataTransfer whose `items` carry a `kind: 'file'` entry. That is the
  // shape a macOS screenshot paste produces, and the shape `files` alone
  // misses in WKWebView.
  const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+Q5q9WQAAAABJRU5ErkJggg==';
  await textarea.evaluate(async (element, base64: string) => {
    const bytes = Uint8Array.from(atob(base64), (character) =>
      character.charCodeAt(0),
    );
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([bytes], 'pasted-screenshot.png', { type: 'image/png' }),
    );
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, PNG_BASE64);

  // Visible in the composer itself, not behind the paperclip popover.
  const strip = page.getByRole('list', { name: 'Attached files' });
  await expect(strip).toBeVisible();
  await expect(
    strip.getByRole('img', { name: 'pasted-screenshot.png' }),
  ).toBeVisible();
  const remove = strip.getByRole('button', {
    name: 'Remove pasted-screenshot.png',
  });
  await expect(remove).toBeVisible();
  // Same 44px floor this spec asserts for every other composer control.
  const removeBox = await remove.boundingBox();
  expect(removeBox?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  expect(removeBox?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  // The paste must not have eaten the draft.
  await expect(textarea).toHaveValue('what is in this screenshot?');

  await page.getByRole('button', { name: 'Send', exact: true }).click();

  await expect(() => expect(dispatched.length).toBeGreaterThan(0)).toPass({
    timeout: 10_000,
  });
  const body = dispatched[0] as {
    attachments?: {
      kind?: string;
      mimeType?: string;
      name?: string;
      dataUrl?: string;
      size?: number;
    }[];
  };
  // The payload assertion is the point: an attach that does not put image
  // bytes on the dispatched turn is the fake attach this issue is about.
  expect(body.attachments).toHaveLength(1);
  expect(body.attachments?.[0]).toMatchObject({
    kind: 'image',
    mimeType: 'image/png',
    name: 'pasted-screenshot.png',
  });
  expect(body.attachments?.[0]?.dataUrl).toBe(
    `data:image/png;base64,${PNG_BASE64}`,
  );
});

/**
 * The two-chat + delegated-row fixture the mobile task switcher is exercised
 * against. Shared by the switch-and-restore journey below and the Escape
 * dismissal regression beside it (archive#3771), so two tests about one sheet
 * cannot drift into describing two different products.
 */
async function seedMobileTaskSwitcher(page: Page) {
  await mockChatShell(page);
  await seedActiveChats(page, [
    {
      sessionId: 'chat-running',
      conversationId: 'conv-running',
      agentSlug: 'station',
      projectSlug: 'default',
      projectName: 'Default',
      model: 'model-selected',
      ephemeralMessages: [
        {
          role: 'assistant',
          content: 'Working through the current task.',
          timestamp: Date.parse('2026-07-19T10:00:00Z'),
        },
      ],
    },
    {
      sessionId: 'chat-review',
      conversationId: 'conv-review',
      agentSlug: 'station',
      projectSlug: 'default',
      projectName: 'Default',
      model: 'model-selected',
      ephemeralMessages: [
        {
          role: 'assistant',
          content: 'Review needed before continuing.',
          timestamp: Date.parse('2026-07-19T10:05:00Z'),
        },
      ],
    },
  ]);

  // archive#3300 (`contexts/active-chats-state.ts:626-640`) deliberately drops a
  // persisted 'running'/'awaiting-approval' on rehydrate — never resurrect a
  // LIVE status claim from storage — so the seeds above cannot put a lifecycle
  // chip on a row. The read-model is the live channel those chips derive from
  // (`utils/session-state.ts:118-162`), and it is what the delegated row in
  // `mockChatShell` already uses. Registered after it, so it wins.
  await page.route('**/api/orchestration/sessions/read-model', (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          {
            threadId: 'delegated-review',
            provider: 'codex',
            model: 'model-selected',
            projectSlug: 'default',
            assignedAgentSlug: 'station',
            delegation: { taskId: 'task:delegated-review' },
            status: 'ready',
            lifecycleState: 'needs_input',
            createdAt: '2026-07-19T10:06:00Z',
            updatedAt: '2026-07-19T10:06:00Z',
            isLoaded: true,
            isPersisted: true,
            eventCount: 1,
          },
          {
            threadId: 'conv-running',
            provider: 'codex',
            model: 'model-selected',
            projectSlug: 'default',
            assignedAgentSlug: 'station',
            status: 'running',
            lifecycleState: 'running',
            hasActiveTurn: true,
            createdAt: '2026-07-19T10:00:00Z',
            updatedAt: '2026-07-19T10:00:00Z',
            isLoaded: true,
            isPersisted: true,
            eventCount: 2,
          },
          {
            threadId: 'conv-review',
            provider: 'codex',
            model: 'model-selected',
            projectSlug: 'default',
            assignedAgentSlug: 'station',
            status: 'ready',
            lifecycleState: 'needs_input',
            createdAt: '2026-07-19T10:05:00Z',
            updatedAt: '2026-07-19T10:05:00Z',
            isLoaded: true,
            isPersisted: true,
            eventCount: 2,
          },
        ],
      }),
    ),
  );
}

test('switches between mobile tasks and restores the exact active chat context', async ({
  page,
}) => {
  test.setTimeout(20_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await seedMobileTaskSwitcher(page);

  await page.goto('/?dock=open&maximize=true&chat=conv-running');
  await dismissSetupLauncher(page);

  const switcher = page.getByRole('button', { name: /^Switch task/ });
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  const triggerBox = await switcher.boundingBox();

  await switcher.click();
  const menu = page.getByRole('dialog', { name: 'Switch task' });
  await expect(menu).toBeVisible();
  await expect(page.getByText(/credential|connect an account/i)).toHaveCount(0);
  // Shared inbox rows (archive#3312): the row button's accessible name is
  // "{title}, {project}" and the lifecycle renders as the shared chip text
  // ("Active"/"Attention needed"), so state discrimination filters on the
  // chip content rather than the old raw-text accessible name.
  await expect(
    menu
      .getByRole('button', { name: 'Station Chat, Default' })
      .filter({ hasText: 'Active' }),
  ).toBeVisible();
  const reviewRow = menu
    .getByRole('button', { name: 'Station Chat, Default' })
    .filter({ hasText: 'Attention needed' });
  await expect(reviewRow).toBeVisible();
  const reviewBox = await reviewRow.boundingBox();
  expect(triggerBox?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  expect(reviewBox?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  const menuBox = await menu.boundingBox();
  expect(menuBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((menuBox?.x ?? 0) + (menuBox?.width ?? 0)).toBeLessThanOrEqual(390);

  await reviewRow.click();
  await expect(menu).toBeHidden();
  await expect(switcher).toBeFocused();
  expect(new URL(page.url()).searchParams.get('chat')).toBe('conv-review');

  const textarea = page.locator('textarea[placeholder*="Type a message"]');
  await textarea.evaluate((element) => element.removeAttribute('disabled'));
  await textarea.fill('return to this draft');

  // The sheet's own dismiss control. The Escape path is the same claim through
  // a different affordance and has its own test below (archive#3771), so this
  // journey keeps exercising the button.
  await switcher.click();
  await menu.getByRole('button', { name: 'Close task switcher' }).click();
  await expect(menu).toBeHidden();
  await expect(switcher).toBeFocused();

  await switcher.click();
  await menu
    .getByRole('button', { name: 'Station Chat, Default' })
    .filter({ hasText: 'Active' })
    .click();
  expect(new URL(page.url()).searchParams.get('chat')).toBe('conv-running');

  await switcher.click();
  await menu
    .getByRole('button', { name: 'Station Chat, Default' })
    .filter({ hasText: 'Attention needed' })
    .click();
  await expect(textarea).toHaveValue('return to this draft');
  await expect(page.locator('.chat-input__model-name')).toHaveText(
    'model-selected',
  );

  await switcher.click();
  await page.evaluate(() => (window as any).__setChatViewport(480, 120));
  await expect
    .poll(async () => {
      const box = await menu.boundingBox();
      return box ? box.y + box.height : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(600);
  // Anchored: the sibling snooze control's name is "Snooze <title>", so an
  // unanchored title match would resolve to both. The delegated row is titled
  // by its task, "Worker task · delegated review".
  await menu
    .getByRole('button', { name: /^Worker task · delegated review,/i })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('chat'))
    .toBe('delegated-review');
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).searchParams.get('dock')).toBe('open');
  expect(new URL(page.url()).searchParams.get('maximize')).toBeNull();

  // A provider-backed task with an assigned agent rehydrates directly into
  // the chat dock. Returning to the prior chat restores its in-memory draft.
  await switcher.click();
  await menu
    .getByRole('button', { name: 'Station Chat, Default' })
    .filter({ hasText: 'Attention needed' })
    .click();
  expect(new URL(page.url()).searchParams.get('chat')).toBe('conv-review');
  expect(new URL(page.url()).searchParams.get('dock')).toBe('open');
  expect(new URL(page.url()).searchParams.get('maximize')).toBeNull();
  await expect(textarea).toHaveValue('return to this draft');
  // The standalone project-context row is desktop-only now; on a phone the
  // project switcher carries the visible name instead of a folder-only glyph.
  await expect(
    page.getByRole('button', { name: 'Switch project — Default' }),
  ).toContainText('Default');
  await expect(page.locator('.chat-input__model-name')).toHaveText(
    'model-selected',
  );

  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => (window as any).__setChatViewport(568, 0));
  await expect(switcher).toBeVisible();

  // Repeat the real cross-kind continuation journey at the smallest supported
  // viewport, not only the dialog geometry checks.
  await switcher.click();
  await page
    .getByRole('dialog', { name: 'Switch task' })
    .getByRole('button', { name: 'Station Chat, Default' })
    .filter({ hasText: 'Active' })
    .click();
  expect(new URL(page.url()).searchParams.get('chat')).toBe('conv-running');
  await switcher.click();
  // Same task, different row title: opening it above created its local chat,
  // and the switcher names a chat by its title — an unstarted one has none, so
  // the row that read "Worker task · delegated review" now reads "New chat".
  // (Worth its own look: a delegated task's row loses its task identity the
  // moment you open it.)
  await page
    .getByRole('dialog', { name: 'Switch task' })
    .getByRole('button', { name: 'New chat, default', exact: true })
    .click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('chat'))
    .toBe('delegated-review');
  await switcher.click();
  await page
    .getByRole('dialog', { name: 'Switch task' })
    .getByRole('button', { name: 'Station Chat, Default' })
    .filter({ hasText: 'Attention needed' })
    .click();
  await expect(textarea).toHaveValue('return to this draft');

  await switcher.click();
  const compactDialog = page.getByRole('dialog', { name: 'Switch task' });
  const compactBox = await compactDialog.boundingBox();
  expect(compactBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((compactBox?.x ?? 0) + (compactBox?.width ?? 0)).toBeLessThanOrEqual(
    320,
  );
  const compactClose = compactDialog.getByRole('button', {
    name: 'Close task switcher',
  });
  // Focus containment, asserted against the last focusable control rather than
  // the last task row: each row now has a sibling snooze button, so the row is
  // no longer the tail of the tab order.
  const compactFocusables = compactDialog.locator(
    'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  );
  await expect(compactClose).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(compactFocusables.last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(compactClose).toBeFocused();
  await page.mouse.click(1, 1);
  await expect(compactDialog).toBeHidden();
  await expect(switcher).toBeFocused();

  await switcher.click();
  await expect(compactDialog).toBeVisible();
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(compactDialog).toBeHidden();
});

test('mobile messages prioritize text and reveal 44px actions on demand', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatShell(page);
  await page.route('**/api/orchestration/sessions/read-model', (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          {
            threadId: 'touch-target-conversation',
            provider: 'station-agent',
            model: 'model-selected',
            projectSlug: 'default',
            assignedAgentSlug: 'station',
            status: 'ready',
            lifecycleState: 'idle',
            createdAt: '2026-08-25T12:00:00.000Z',
            updatedAt: '2026-08-25T12:00:01.000Z',
            isLoaded: true,
            isPersisted: true,
            eventCount: 2,
          },
        ],
      }),
    ),
  );
  await page.route(
    '**/api/orchestration/conversations/touch-target-conversation/event-window**',
    (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            protocolVersion: 1,
            conversationId: 'touch-target-conversation',
            currentSessionId: 'touch-target-conversation',
            sessionLineage: [
              {
                sessionId: 'touch-target-conversation',
                agentSlug: 'station',
                agentDisplayName: 'Station',
              },
            ],
            handoffs: [],
            contextBoundaries: [],
            events: [
              {
                sequence: 1,
                event: {
                  eventId: 'touch-target-started',
                  provider: 'station-agent',
                  threadId: 'touch-target-conversation',
                  turnId: 'touch-target-turn',
                  createdAt: '2026-08-25T12:00:00.000Z',
                  method: 'turn.started',
                  prompt:
                    'Can you help shepherd the open PRs through the merge queue?',
                },
              },
              {
                sequence: 2,
                event: {
                  eventId: 'touch-target-completed',
                  provider: 'station-agent',
                  threadId: 'touch-target-conversation',
                  turnId: 'touch-target-turn',
                  createdAt: '2026-08-25T12:00:01.000Z',
                  method: 'turn.completed',
                  outputText:
                    'I’ll review the open pull requests, check which are eligible, and report anything blocking the queue.',
                  finishReason: 'stop',
                },
              },
            ],
            hasMore: false,
            watermark: 2,
          },
        }),
      ),
  );
  await page.route(/\/agents\/station\/conversations(?:\?.*)?$/, (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          {
            id: 'touch-target-conversation',
            title: 'Merge queue review',
            agentSlug: 'station',
            updatedAt: '2026-08-25T12:00:01.000Z',
          },
        ],
      }),
    ),
  );
  await seedActiveChats(page, [
    {
      sessionId: 'touch-target-conversation',
      conversationId: 'touch-target-conversation',
      agentSlug: 'station',
      projectSlug: 'default',
      projectName: 'Default',
      model: 'model-selected',
      title: 'Merge queue review',
      provider: 'bedrock',
      orchestrationSessionStarted: true,
      ephemeralMessages: [],
    },
  ]);

  await page.route(
    '**/api/conversations/touch-target-conversation/open',
    (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            status: 'resolved',
            conversation: {
              id: 'touch-target-conversation',
              title: 'Merge queue review',
              agentSlug: 'station',
              source: 'runtime',
            },
            currentSessionId: 'touch-target-conversation',
            transcript: { available: true, owner: 'runtime', messageCount: 2 },
            canContinue: true,
            answerability: { answerable: true },
            recoveryActions: [],
          },
        }),
      ),
  );
  await page.goto('/?dock=open&maximize=true&chat=touch-target-conversation');
  await dismissSetupLauncher(page);
  await expect(page.locator('#station-main')).toBeHidden();
  await expect(page.locator('#station-main')).toHaveAttribute('inert', '');
  const header = page.getByTestId('chat-dock-mobile-header');
  await expect(header.getByRole('button')).toHaveCount(3);
  const title = header.getByRole('button', { name: /^Switch task/ });
  expect((await title.boundingBox())!.width).toBeGreaterThan(240);
  await expect(
    page.getByText(
      'Can you help shepherd the open PRs through the merge queue?',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'I’ll review the open pull requests, check which are eligible, and report anything blocking the queue.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Add input to Task', exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Good response' }),
  ).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Provenance', exact: true }),
  ).toBeHidden();
  await page.screenshot({
    path: testInfo.outputPath('mobile-chat-focused-390.png'),
  });
  await page.getByRole('button', { name: 'Your message actions' }).click();
  const inputTask = page.getByRole('button', {
    name: 'Add input to Task',
    exact: true,
  });
  await expect(inputTask).toBeVisible();
  expect(await contrastRatio(inputTask)).toBeGreaterThanOrEqual(4.5);
  await page.getByRole('button', { name: 'Close message details' }).click();
  await page
    .getByRole('button', { name: 'Answer details and actions', exact: true })
    .click();
  for (const control of [
    page.getByRole('button', { name: 'More answer actions' }),
    page.getByRole('button', { name: 'Good response' }),
    page.getByRole('button', { name: 'Bad response' }),
  ]) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  }
  await page.getByRole('button', { name: 'Close message details' }).click();
  await header
    .getByRole('button', { name: 'Chat actions', exact: true })
    .click();
  for (const name of ['New chat', 'Activity', 'Collapse chat']) {
    await expect(
      page.getByRole('menuitem', { name, exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByTestId('chat-dock-mobile-connection')).toBeVisible();
  await page.getByRole('button', { name: 'Close actions menu' }).click();
});

/**
 * Escape dismisses the sheet and does nothing else — including after a row
 * selection has rewritten the URL underneath it.
 *
 * Durable cover for archive#3771, which reported that Escape here navigates the
 * app back a history entry, landing on Home with the chat dock unmounted. It
 * does not, on this tree or on the merge base. The A/B it was filed from —
 * `keyboard.press('Escape')` in place of a click on `Close task switcher`, in
 * the journey above — is not one line different in effect: clicking the close
 * button makes Playwright wait for the sheet, and a bare key press does not. So
 * the Escape reached the app before the sheet had rendered, and what the
 * failure snapshot showed was the sheet arriving afterwards, over a shell that
 * had not finished settling. Adding `await expect(menu).toBeVisible()` to that
 * exact A/B makes it pass on a pristine merge-base checkout.
 *
 * (The lag it exposes is real, and its own defect: the project-layout and dock
 * routes sustain a render storm — see the note in
 * `tests/orchestration-provider-picker.spec.ts` — which is what makes a
 * hundreds-of-milliseconds gap between a click and its dialog possible at all.)
 *
 * This test is kept because the journey it covers had none: the note beside the
 * close-button dismissal above promised an expected-failing Escape test that
 * was never written, so the Escape path had no regression cover of any kind.
 * It asserts the whole URL across the keypress, not one param, because a
 * consumed history entry shows up as the address reverting to the chat that was
 * open before the switch.
 */
test('Escape dismisses the mobile task switcher without leaving the chat', async ({
  page,
}) => {
  test.setTimeout(20_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await seedMobileTaskSwitcher(page);

  await page.goto('/?dock=open&maximize=true&chat=conv-running');
  await dismissSetupLauncher(page);

  const switcher = page.getByRole('button', { name: /^Switch task/ });
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  const menu = page.getByRole('dialog', { name: 'Switch task' });

  // Escape straight away: the sheet closes and the route is untouched.
  await switcher.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(switcher).toBeFocused();
  expect(new URL(page.url()).pathname).toBe('/');
  expect(new URL(page.url()).searchParams.get('chat')).toBe('conv-running');

  // And again after a row selection has rewritten the URL while the sheet was
  // open — the case that navigated. The dock must still be mounted afterwards
  // (the failure landed on Home, where it is not) and the switched-to chat
  // must survive: Escape dismisses a sheet, it does not undo a task switch.
  await switcher.click();
  await menu
    .getByRole('button', { name: 'Station Chat, Default' })
    .filter({ hasText: 'Attention needed' })
    .click();
  await expect(menu).toBeHidden();
  expect(new URL(page.url()).searchParams.get('chat')).toBe('conv-review');

  await switcher.click();
  await expect(menu).toBeVisible();
  // The whole URL, not one param: a history entry consumed by Escape shows up
  // as the address reverting to the chat that was open before the switch.
  const urlBeforeEscape = page.url();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(switcher).toBeVisible();
  await expect(switcher).toBeFocused();
  await expect(page.locator('.chat-dock')).toBeVisible();
  expect(page.url()).toBe(urlBeforeEscape);
  expect(new URL(page.url()).searchParams.get('chat')).toBe('conv-review');
});

test('keeps delegation actions reachable above the mobile keyboard', async ({
  page,
}) => {
  test.setTimeout(20_000);
  await page.setViewportSize({ width: 320, height: 568 });
  await mockChatShell(page);
  // The delegated task must be a real session before `Open task` can reveal
  // it: `SessionsView` only selects a routed session that exists in the
  // read-model. A second session keeps the assertion honest — a detail that
  // named nothing in particular would pass on an auto-selected list of one.
  const delegatedSession = {
    threadId: 'task:mobile-delegation',
    displayTitle: 'Delegated mobile task',
    provider: 'codex',
    model: 'model-selected',
    projectSlug: 'default',
    assignedAgentSlug: 'station',
    delegation: { taskId: 'task:mobile-delegation' },
    controlMode: 'station-owned',
    status: 'ready',
    lifecycleState: 'running',
    createdAt: '2026-07-19T10:07:00Z',
    updatedAt: '2026-07-19T10:07:00Z',
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
  };
  const otherSession = {
    ...delegatedSession,
    threadId: 'delegated-review',
    displayTitle: 'Other mobile task',
    delegation: { taskId: 'task:delegated-review' },
    lifecycleState: 'needs_input',
  };
  await page.route('**/api/orchestration/sessions/**', (route) => {
    const last = new URL(route.request().url()).pathname
      .split('/')
      .filter(Boolean)
      .at(-1);
    if (last === 'read-model')
      return route.fulfill(
        json({ success: true, data: [otherSession, delegatedSession] }),
      );
    if (last === 'flow-run')
      return route.fulfill(json({ success: true, data: null }));
    return route.fulfill(
      json({ success: true, data: { session: delegatedSession, events: [] } }),
    );
  });
  await openComposer(page, true);
  const parentTaskId = await page.evaluate(() =>
    new URL(location.href).searchParams.get('chat'),
  );
  expect(parentTaskId).toBeTruthy();

  // Delegate collapsed into the composer's grouped "+" menu
  // (docs/design/chat-composer.md §3.2).
  await page.getByRole('button', { name: 'Composer actions' }).click();
  await expect(
    page.getByRole('menu', { name: 'Composer actions' }),
  ).toBeVisible();
  await page.getByRole('menuitem', { name: 'Delegate' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delegate a task' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Child worker of')).toBeVisible();
  await expect(dialog.getByText('New chat')).toBeVisible();
  await expect(dialog).toContainText('Selected Test Model');
  await page.evaluate(() => (window as any).__setChatViewport(344, 180));

  const footer = dialog.locator('.delegation-launcher__footer');
  await expect
    .poll(async () => {
      const box = await footer.boundingBox();
      return box ? box.y + box.height : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(524);

  const task = dialog.getByLabel('Task');
  await task.fill('Verify the mobile delegation flow');
  const requestPromise = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/orchestration/delegations',
  );
  await dialog.getByRole('button', { name: 'Delegate' }).click();
  const request = await requestPromise;
  expect(request.postDataJSON()).toEqual(
    expect.objectContaining({
      prompt: 'Verify the mobile delegation flow',
      parentTaskId,
      target: {
        agent: 'codex',
        environment: { kind: 'current' },
        workspace: { kind: 'project', projectSlug: 'default' },
      },
    }),
  );
  await expect(dialog).toBeHidden();

  /**
   * archive#1259. `onClose` restored focus; the *success* path did not, so
   * completing a delegation — the thing the launcher exists to do — left focus
   * on `<body>` while `onClose` (cancel) was fine. Browser-level because that
   * is the only place a failed `.focus()` is observable: jsdom reports such a
   * failed call as successful.
   */
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.getAttribute('aria-label') ?? '',
      ),
    )
    .toBe('Composer actions');

  await expect(page.getByText('Delegated to Codex')).toBeVisible();
  await page.getByRole('button', { name: 'Open task' }).click();
  /**
   * #928: `Open task` reveals the Activity surface through the region model
   * rather than changing the route, so the URL says nothing about whether the
   * click did anything — a `session` param nothing writes any more, and a
   * pathname poll that is satisfied the instant it runs, both passed against
   * a click that revealed nothing at all. Assert the surface and the session
   * it was told to show.
   */
  await expect(
    page.locator('#chat-dock').getByRole('button', { name: 'Hide Activity' }),
  ).toBeVisible({ timeout: 10_000 });
  const revealed = page.getByTestId('session-detail');
  await expect(revealed).toBeVisible({ timeout: 10_000 });
  await expect(revealed).toContainText('Delegated mobile task');
  await expect(revealed).not.toContainText('Other mobile task');
});

/**
 * archive#3309 (SF-2). The worst case for the one-bar header is
 * the MAXIMIZED chat at 320px: maximizing hides the app toolbar, so this bar
 * additionally carries the drawer toggle. Every existing containment test ran
 * un-maximized, so none of them could see it.
 *
 * The scope clear is no longer part of this arithmetic — it moved into the ⋯
 * sheet (pinned in ChatDockMobileHeader.test.tsx), so it costs the bar nothing.
 * archive#3297's always-rendered connection indicator took its slot instead, which is
 * why the count did not improve.
 *
 * With the dock toggle deferred, five 44px icon slots (220px), the measured
 * 53.28125px labelled connection chip, and six 2px gaps consume 285.28125px of
 * the 304px content row, leaving 18.71875px for the flexible identity button.
 * The 44px floor is not negotiable. The ⋯ sheet already carries dock height as
 * named menu items, so this pins all of it: the bar contains what it shows,
 * nothing collides, and the deferred dock-height action stays reachable.
 */
test('the 320px header reserves title space and exposes secondary actions in its sheet', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mockChatShell(page);
  await openComposer(page, true);
  await page.getByRole('button', { name: 'Chat actions', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Expand chat', exact: true })
    .click();
  await expect(page.locator('.chat-dock')).toHaveClass(/is-maximized/);
  const header = page.getByTestId('chat-dock-mobile-header');
  await expect(header.getByRole('button')).toHaveCount(3);
  const identity = header.getByRole('button', { name: /^Switch task/ });
  expect((await identity.boundingBox())!.width).toBeGreaterThanOrEqual(200);
  for (const button of await header.getByRole('button').all()) {
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  await header
    .getByRole('button', { name: 'Chat actions', exact: true })
    .click();
  for (const name of ['New chat', 'Activity', 'Collapse chat']) {
    await expect(
      page.getByRole('menuitem', { name, exact: true }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole('menuitem', { name: /^Switch project/ }),
  ).toBeVisible();
  await expect(page.getByTestId('chat-dock-mobile-connection')).toBeVisible();
  await page.getByRole('button', { name: 'Close actions menu' }).click();
});

for (const width of [361, 375, 390, 431, 481]) {
  test(`the maximized phone bar keeps the agent name and chat title legible at ${width}px (#3309 HIGH-1)`, async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width, height: 720 });
    await mockChatShell(page);
    await openComposer(page, true);

    await page.getByRole('button', { name: 'Chat actions' }).click();
    await page
      .getByRole('menu', { name: 'Chat actions' })
      .getByRole('menuitem', { name: /^Expand chat/ })
      .click();
    await expect(page.locator('.chat-dock')).toHaveClass(/is-maximized/);
    // This is the configuration under test: the app toolbar is gone and this
    // bar carries the drawer toggle.
    await expect(
      page.getByRole('button', { name: 'Toggle menu' }),
    ).toBeVisible();

    const header = page.locator('.chat-dock__mobile-header');
    for (const selector of [
      '.chat-dock__mobile-eyebrow',
      '.chat-dock__mobile-title-text',
    ]) {
      const box = await header.locator(selector).boundingBox();
      expect(
        box?.width ?? 0,
        `${selector} width at ${width}px`,
      ).toBeGreaterThan(0);
    }

    // The invariant the 431->481 deferral actually encodes, asserted as an
    // invariant rather than as a floor. A width floor cannot guard this fix:
    // with the deferral reverted, 431px still measured 10.72px of text, which
    // is `> 0`, so every assertion above passes on the broken CSS. What the
    // fix says is BINARY — below 481px the maximized bar shows at most one of
    // the two elements that cost the identity block, so the avatar and the
    // project label can never arrive in the same breath (they did, at exactly
    // 431px, and that is how the defect was built).
    if (width < 481) {
      const avatarShown = await header
        .locator('[data-testid="chat-dock-mobile-agent-avatar"]')
        .isVisible()
        .catch(() => false);
      const labelShown = await header
        .locator('.chat-dock__mobile-project-name')
        .isVisible()
        .catch(() => false);
      expect(
        avatarShown && labelShown,
        `at ${width}px the maximized bar shows BOTH the agent avatar and the project label; below 481px it may show at most one`,
      ).toBe(false);
    }

    // Everything still inside the viewport, nothing overlapping — the squeeze
    // must be relieved by dropping the avatar, not by pushing a control out.
    const buttons = header.locator('button:visible');
    const count = await buttons.count();
    for (let i = 0; i < count; i += 1) {
      const box = await buttons.nth(i).boundingBox();
      const name =
        (await buttons.nth(i).getAttribute('aria-label')) ?? `button-${i}`;
      expect(box?.x ?? -1, `${name} left edge`).toBeGreaterThanOrEqual(0);
      expect(
        (box?.x ?? 0) + (box?.width ?? 0),
        `${name} right edge`,
      ).toBeLessThanOrEqual(width);
    }

    // And the avatar, if it is shown at all, is inside the control that owns
    // it rather than overflowing it — the overflow was the tell that the block
    // had run out of room.
    const avatar = header.locator(
      '[data-testid="chat-dock-mobile-agent-avatar"]',
    );
    if (await avatar.isVisible().catch(() => false)) {
      const avatarBox = await avatar.boundingBox();
      const identityBox = await header
        .getByRole('button', { name: /^Switch task/ })
        .boundingBox();
      expect(
        (avatarBox?.x ?? 0) + (avatarBox?.width ?? 0),
        'avatar overflows its own control',
      ).toBeLessThanOrEqual(
        (identityBox?.x ?? 0) + (identityBox?.width ?? 0) + 1,
      );
    }
  });
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
]) {
  test(`keeps the mobile composer stable through keyboard and restore cycles at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(20_000);
    await page.setViewportSize(viewport);
    const providerCalls = await mockChatShell(page);
    await page.evaluate((dark) => {
      document.documentElement.setAttribute(
        'data-theme',
        dark ? 'dark' : 'light',
      );
      document.documentElement.style.setProperty(
        '--safe-bottom',
        dark ? '12px' : '0px',
      );
    }, viewport.width === 390);
    const textarea = await openComposer(page);
    await expect(
      page.getByRole('button', { name: /^Switch task/ }),
    ).toContainText('New chat');
    await expect(page.locator('.chat-dock__counter')).toBeHidden();
    await expect(
      page.locator('.chat-dock__header').getByTitle('Chat settings'),
    ).toBeHidden();
    // The dock's tab-action row is desktop-only now; its mobile equivalents are
    // the one-row header's own controls. Same guarantee as before: every session
    // control clears the touch floor and the cluster stays inside the viewport.
    const moreActions = page.getByRole('button', { name: 'Chat actions' });
    await expect(moreActions).toBeVisible();
    const mobileHeader = page.locator('.chat-dock__mobile-header');
    await expect(mobileHeader.getByRole('button')).toHaveCount(3);
    for (const control of await mobileHeader.getByRole('button').all()) {
      const box = await control.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    }
    const headerBox = await page
      .locator('.chat-dock__mobile-header')
      .boundingBox();
    expect(headerBox!.x + headerBox!.width).toBeLessThanOrEqual(viewport.width);
    await moreActions.click();
    // These actions moved from the tab bar's <details> menu into the one-row
    // header's overflow sheet, where each is a real menuitem.
    const mobileActions = page.getByRole('menu', { name: 'Chat actions' });
    await expect(mobileActions).toBeVisible();
    for (const name of [
      'New chat',
      'Activity',
      'Conversation history',
      'Open conversation',
      'Chat settings',
    ]) {
      await expect(mobileActions.getByRole('menuitem', { name })).toBeVisible();
    }
    const mobileActionsBox = await mobileActions.boundingBox();
    expect(mobileActionsBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(
      (mobileActionsBox?.x ?? 0) + (mobileActionsBox?.width ?? 0),
    ).toBeLessThanOrEqual(viewport.width);
    const dockClassBeforeEscape = await page
      .locator('.chat-dock')
      .getAttribute('class');
    await page.keyboard.press('Escape');
    await expect(mobileActions).toBeHidden();
    await expect(moreActions).toBeFocused();
    await expect(page.locator('.chat-dock')).toHaveAttribute(
      'class',
      dockClassBeforeEscape ?? '',
    );
    await moreActions.click();
    await mobileActions
      .getByRole('menuitem', { name: 'Chat settings' })
      .click();
    await expect(
      page.getByText('Chat Settings', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('Chat Settings', { exact: true })).toBeHidden();
    await expandMobileDock(page);
    await expect(page.locator('.chat-dock')).toHaveClass(/is-maximized/);
    const selectedModel = page.locator('.chat-input__model-name');
    await expect(selectedModel).toHaveText('test-model');
    await expect(page.locator('.chat-input__model-btn')).toHaveAttribute(
      'aria-label',
      /agent default/,
    );
    const selectedModelLabel = 'test-model';
    const activeChatParam = new URL(page.url()).searchParams.get('chat');
    const switcher = page.getByRole('button', { name: /^Switch task/ });
    await expect(switcher).toContainText('New chat');
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const scroller = page.locator('.chat-messages');
      // This chat never sends, so the region is the empty-transcript filler
      // (`role="status"`), not the message list. The populated list's
      // `role="log"` contract is asserted by the long-transcript test above.
      await expect(scroller).toHaveAttribute('role', 'status');
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await textarea.evaluate((element) => element.removeAttribute('disabled'));
      await textarea.fill('one\ntwo\nthree\nfour\nfive\nsix\nseven\neight');
      await textarea.focus();
      const openHeight = Math.round(
        viewport.height * [0.72, 0.58, 0.64][cycle],
      );
      const offsetTop = [0, 17, 8][cycle];
      await page.evaluate(
        ({ height, top }) => (window as any).__setChatViewport(height, top),
        { height: openHeight, top: offsetTop },
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(textarea).toBeInViewport();
      const geometry = await textarea.evaluate((element) => {
        const input = element.closest('.chat-input')!.getBoundingClientRect();
        const body = element
          .closest('.chat-dock__body')!
          .getBoundingClientRect();
        const dock = element.closest('.chat-dock')!.getBoundingClientRect();
        const viewport = window.visualViewport!;
        return {
          gap: Math.abs(viewport.offsetTop + viewport.height - input.bottom),
          inputBottom: input.bottom,
          bodyBottom: body.bottom,
          dockBottom: dock.bottom,
          viewportBottom: viewport.offsetTop + viewport.height,
          safeBottom: getComputedStyle(
            document.documentElement,
          ).getPropertyValue('--safe-bottom'),
        };
      });
      expect(
        geometry.gap,
        JSON.stringify({ cycle, ...geometry }),
      ).toBeLessThanOrEqual(2);
      await textarea.blur();
      // The persistent control at the top of a maximized dock must stay
      // tappable above the software keyboard. That used to be the Restore
      // button; it is now the header's Chat actions control, which is what the
      // named restore path lives behind.
      const restoreHitTarget = await moreActions.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return {
          button: { top: rect.top, bottom: rect.bottom },
          hit: hit?.className || hit?.tagName || null,
          ownsHit: !!hit && button.contains(hit),
        };
      });
      expect(restoreHitTarget.ownsHit, JSON.stringify(restoreHitTarget)).toBe(
        true,
      );
      const restoreItem = page
        .getByRole('menu', { name: 'Chat actions' })
        .getByRole('menuitem', { name: /^Restore chat/ });
      if (cycle === 0) {
        await moreActions.focus();
        await moreActions.press('Enter');
        await restoreItem.click();
      } else {
        await moreActions.click();
        await restoreItem.click();
      }
      await expect(textarea).toHaveValue(
        'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight',
      );
      expect(new URL(page.url()).searchParams.get('chat')).toBe(
        activeChatParam,
      );
      await expect(switcher).toContainText('New chat');
      await expect(selectedModel).toHaveText(selectedModelLabel ?? '');
      await expect(scroller).toBeVisible();
      await page.evaluate(
        (height) => (window as any).__setChatViewport(height, 0),
        viewport.height,
      );
      await expandMobileDock(page);
    }

    for (const button of await page
      .locator('.chat-input button:visible')
      .all()) {
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
            document.documentElement.clientWidth &&
          document.documentElement.scrollHeight <=
            document.documentElement.clientHeight,
      ),
    ).toBe(true);
    expect(providerCalls()).toBe(0);
  });
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
]) {
  test(`stacks the composer and contains the session-actions strip at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(20_000);
    await page.setViewportSize(viewport);
    await mockChatShell(page);
    const textarea = await openComposer(page, true);

    // Nothing may widen the document past the viewport with the dock open.
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
      ),
    ).toBe(false);

    // Row 1: the textarea owns (almost) the full composer width instead of
    // being squeezed by a right-hand controls column.
    const inputBox = await page.locator('.chat-input').boundingBox();
    const textareaBox = await textarea.boundingBox();
    expect(inputBox).not.toBeNull();
    expect(textareaBox).not.toBeNull();
    expect(textareaBox!.width).toBeGreaterThanOrEqual(inputBox!.width * 0.9);

    const drafts = page.getByRole('button', { name: 'Drafts', exact: true });
    await expect(drafts).toBeVisible();
    const draftsBox = await drafts.boundingBox();
    expect(draftsBox!.y).toBeGreaterThanOrEqual(
      textareaBox!.y + textareaBox!.height,
    );
    expect(draftsBox!.x + draftsBox!.width).toBeLessThanOrEqual(viewport.width);
    await drafts.click();
    await expect(
      page.getByRole('dialog', { name: 'Portable drafts' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close portable drafts' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Portable drafts' }),
    ).toBeHidden();

    // Row 2: the controls strip sits below the textarea and every visible
    // control stays fully inside the viewport (the reported bug clipped the
    // model/approval/context chips off the right edge).
    const controls = page.locator('.chat-controls-row');
    const controlsBox = await controls.boundingBox();
    expect(controlsBox).not.toBeNull();
    expect(controlsBox!.y).toBeGreaterThanOrEqual(
      textareaBox!.y + textareaBox!.height - 2,
    );
    expect(controlsBox!.x).toBeGreaterThanOrEqual(0);
    expect(controlsBox!.x + controlsBox!.width).toBeLessThanOrEqual(
      viewport.width,
    );
    const modelButton = page.locator('.chat-input__model-btn');
    await expect(modelButton).toBeVisible();
    await expect(modelButton.locator('.chat-input__choice-label')).toHaveText(
      'Model',
    );
    await expect(modelButton.locator('.chat-input__model-name')).toHaveText(
      'test-model',
    );
    await expect(modelButton).toContainText('⌄');
    const modelBox = await modelButton.boundingBox();
    expect(modelBox!.x + modelBox!.width).toBeLessThanOrEqual(viewport.width);
    const agentButton = page.locator('.chat-input__agent-btn');
    await expect(agentButton).toBeVisible();
    await expect(agentButton).toHaveAccessibleName(
      'Agent: Claude. Send a message before changing Agent.',
    );
    await expect(agentButton).toHaveAttribute('aria-disabled', 'true');
    await expect(agentButton.locator('.chat-input__choice-label')).toHaveText(
      'Agent',
    );
    await expect(agentButton.locator('.chat-input__agent-name')).toHaveText(
      'Claude',
    );
    await expect(agentButton).toContainText('⌄');
    const attach = page.getByRole('button', { name: 'Attach files' });
    const attachBox = await attach.boundingBox();
    expect(attachBox!.x + attachBox!.width).toBeLessThanOrEqual(viewport.width);

    // Delegate/Commands/Files/Task-context collapse into one grouped "+"
    // menu (docs/design/chat-composer.md §3.2), contained within the
    // viewport, and Task context is reachable from inside it.
    const actionsMenuTrigger = page.getByRole('button', {
      name: 'Composer actions',
    });
    await expect(actionsMenuTrigger).toBeVisible();
    const triggerBox = await actionsMenuTrigger.boundingBox();
    expect(triggerBox!.x).toBeGreaterThanOrEqual(0);
    expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(
      viewport.width,
    );
    await actionsMenuTrigger.click();
    const menu = page.getByRole('menu', { name: 'Composer actions' });
    await expect(menu).toBeVisible();

    // All four grouped actions (docs/design/chat-composer.md §3.2) must be
    // visible and enabled inside the menu, not just one of them.
    const delegateItem = menu.getByRole('menuitem', { name: 'Delegate' });
    const commandsItem = menu.getByRole('menuitem', {
      name: 'Open command launcher',
    });
    const filesItem = menu.getByRole('menuitemcheckbox', { name: /^Files/ });
    const taskContextItem = menu.getByRole('menuitemcheckbox', {
      name: 'Task context',
    });
    await expect(delegateItem).toBeVisible();
    await expect(delegateItem).toBeEnabled();
    await expect(commandsItem).toBeVisible();
    await expect(commandsItem).toBeEnabled();
    await expect(filesItem).toBeVisible();
    await expect(filesItem).toBeEnabled();
    await expect(taskContextItem).toBeVisible();
    await expect(taskContextItem).toBeEnabled();

    // Defense-in-depth: the desktop Active Work aside must not render inside
    // the workspace at phone width.
    await expect(
      page.locator('.chat-dock__workspace > .active-work-frame'),
    ).toBeHidden();
  });
}

test('drags the mobile dock bar between half and full without stealing taps', async ({
  page,
}) => {
  test.setTimeout(20_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatShell(page);
  const composer = await openComposer(page);

  const dock = page.locator('.chat-dock');
  const header = page.locator('.chat-dock__header');
  const expectVisibleGeometry = async (includeComposer: boolean) => {
    const dockBox = await dock.boundingBox();
    const headerBox = await header.boundingBox();
    if (!dockBox || !headerBox)
      throw new Error('Mobile dock geometry is not measurable');
    expect(dockBox.y).toBeGreaterThanOrEqual(0);
    expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(844);
    expect(headerBox.y).toBeGreaterThanOrEqual(dockBox.y);
    expect(headerBox.y + headerBox.height).toBeLessThanOrEqual(844);
    if (!includeComposer) return;
    const composerBox = await composer.boundingBox();
    if (!composerBox) throw new Error('Mobile composer is not measurable');
    expect(composerBox.y).toBeGreaterThanOrEqual(dockBox.y);
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(844);
  };
  await expect
    .poll(async () => Math.round((await dock.boundingBox())?.height ?? 0))
    .toBe(380);
  await expectVisibleGeometry(true);

  const touchDragControlTo = async (
    controlName: string | RegExp,
    toY: number,
  ) => {
    const control = page.getByRole('button', { name: controlName });
    const controlBox = await control.boundingBox();
    if (!controlBox)
      throw new Error(`${controlName} control is not measurable`);
    const x = controlBox.x + controlBox.width / 2;
    const fromY = controlBox.y + controlBox.height / 2;
    // Synthetic PointerEvents have no browser-owned active-pointer registry,
    // so the test surface supplies the no-op capture that a real touch pointer
    // provides while still exercising the production window listeners.
    await header.evaluate((element) => {
      element.setPointerCapture = () => {};
    });
    const dispatchPointer = async (
      target: 'control' | 'window',
      type: 'pointerdown' | 'pointermove' | 'pointerup',
      clientY: number,
    ) => {
      const init = {
        bubbles: true,
        pointerId: 7,
        pointerType: 'touch',
        isPrimary: true,
        button: type === 'pointerdown' ? 0 : -1,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY,
      };
      if (target === 'control') {
        await control.evaluate(
          (element, event) =>
            element.dispatchEvent(new PointerEvent(event.type, event.init)),
          { type, init },
        );
        return;
      }
      await page.evaluate(
        (event) =>
          window.dispatchEvent(new PointerEvent(event.type, event.init)),
        { type, init },
      );
    };
    await dispatchPointer('control', 'pointerdown', fromY);
    for (let step = 1; step <= 4; step += 1) {
      await dispatchPointer(
        'window',
        'pointermove',
        fromY + ((toY - fromY) * step) / 4,
      );
    }
    await dispatchPointer('window', 'pointerup', toY);
  };

  // Exercise a real touch sequence from the overflow control itself. Android
  // does not emit a compatibility click after a moved touch gesture, which is
  // the exact path that used to leave the next deliberate tap suppressed.
  await touchDragControlTo(/^Switch task/, 120);
  await expect(dock).toHaveClass(/is-maximized/);
  await expect
    .poll(async () => Math.round((await dock.boundingBox())?.height ?? 0))
    .toBeGreaterThanOrEqual(760);
  await expectVisibleGeometry(true);

  // The first independent tap after that drag must open the menu immediately;
  // it must not inherit the prior gesture's click-suppression guard.
  await page.getByRole('button', { name: 'Chat actions' }).click();
  await expect(page.getByRole('menu', { name: 'Chat actions' })).toBeVisible();
  await page.keyboard.press('Escape');

  const fullHeaderBox = await header.boundingBox();
  if (!fullHeaderBox)
    throw new Error('Full mobile dock header is not measurable');
  await page.mouse.move(fullHeaderBox.x + 4, fullHeaderBox.y + 30);
  await page.mouse.down();
  await page.mouse.move(fullHeaderBox.x + 4, 500, { steps: 4 });
  await expect
    .poll(async () => Math.round((await dock.boundingBox())?.height ?? 0))
    .toBeLessThan(700);
  await page.mouse.up();
  await expect(dock).not.toHaveClass(/is-maximized/);
  await expect
    .poll(async () => Math.round((await dock.boundingBox())?.height ?? 0))
    .toBe(380);
  await expectVisibleGeometry(true);

  const beforeTap = await dock.boundingBox();
  const headerBox = await header.boundingBox();
  if (!headerBox) throw new Error('Mobile dock header is not measurable');
  await page.mouse.click(headerBox.x + 4, headerBox.y + 30);
  expect(Math.round((await dock.boundingBox())?.height ?? 0)).toBe(
    Math.round(beforeTap?.height ?? 0),
  );

  // The mobile header no longer spends two permanent 44px slots on
  // Maximize/Restore and Collapse — dock height is the drag gesture exercised
  // above. The keyboard/agent path is preserved as a named menu item, which is
  // what actually has to stay reachable (docs/design/chat-composer.md §1).
  await page.getByRole('button', { name: 'Chat actions' }).click();
  const collapseItem = page
    .getByRole('menu', { name: 'Chat actions' })
    .getByRole('menuitem', { name: /^Collapse chat/ });
  await expect(collapseItem).toBeVisible();
  await expectSettledTouchTargetHeight(collapseItem);
  await collapseItem.click();
  await expect(dock).toHaveClass(/is-collapsed/);
  await expectVisibleGeometry(false);

  // Reopening from Collapsed is still a live resize gesture. Crossing the
  // tap threshold must reveal the dock at the pointer's actual height; it
  // must not commit Half (and run the snap transition) until release.
  const collapsedActions = page.getByRole('button', { name: /^Switch task/ });
  const collapsedActionsBox = await collapsedActions.boundingBox();
  if (!collapsedActionsBox)
    throw new Error('Collapsed Chat actions control is not measurable');
  const collapsedX = collapsedActionsBox.x + collapsedActionsBox.width / 2;
  const collapsedStartY =
    collapsedActionsBox.y + collapsedActionsBox.height / 2;
  const collapsedPreviewY = collapsedStartY - 96;
  const pointerInit = (
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    clientY: number,
  ) => ({
    bubbles: true,
    pointerId: 8,
    pointerType: 'touch',
    isPrimary: true,
    button: type === 'pointerdown' ? 0 : -1,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: collapsedX,
    clientY,
  });
  await collapsedActions.evaluate(
    (element, init) =>
      element.dispatchEvent(new PointerEvent('pointerdown', init)),
    pointerInit('pointerdown', collapsedStartY),
  );
  await page.evaluate(
    (init) => window.dispatchEvent(new PointerEvent('pointermove', init)),
    pointerInit('pointermove', collapsedPreviewY),
  );

  await expect(dock).toHaveClass(/is-dragging/);
  await expect(dock).not.toHaveClass(/is-collapsed/);
  await expect(page.locator('.chat-dock__workspace')).toHaveCount(1);
  await expect
    .poll(async () => Math.round((await dock.boundingBox())?.height ?? 0))
    .toBe(Math.round(844 - collapsedPreviewY));

  await page.evaluate(
    (init) => window.dispatchEvent(new PointerEvent('pointerup', init)),
    pointerInit('pointerup', collapsedPreviewY),
  );
  await expect(dock).not.toHaveClass(/is-dragging|is-collapsed|is-maximized/);
  await expect
    .poll(async () => Math.round((await dock.boundingBox())?.height ?? 0))
    .toBe(380);
  await expectVisibleGeometry(true);
});

test('preserves desktop dock geometry', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockChatShell(page);
  await openComposer(page);
  // archive#1064 removed the "Chat Dock" label — the dock is the only thing this
  // chrome can belong to, and the row now carries the active chat's project
  // context instead. Assert the row still identifies the surface (its toggle
  // shortcut) rather than re-pinning a label that was deliberately dropped.
  await expect(page.locator('.chat-dock__title')).not.toContainText(
    'Chat Dock',
  );
  await expect(page.locator('.chat-dock__counter')).toHaveText('1 session');
  await expect(
    page.locator('.chat-dock__header').getByTitle('Chat settings'),
  ).toBeVisible();
  await expect(
    page.locator('summary[aria-label="More chat actions"]'),
  ).toHaveCount(0);
  const desktopActions = page.locator('.chat-dock__tab-actions button');
  await expect(desktopActions).toHaveCount(2);
  await expect(desktopActions.nth(0)).toContainText('Open');
  await expect(desktopActions.nth(1)).toContainText('New');
  // archive#1048 retired the overlay bottom dock: the dock is always inline in the
  // content column, spanning from the sidebar's right edge to the viewport
  // edge (previously it overlaid the full 1280px viewport width).
  const sidebar = await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .boundingBox();
  if (!sidebar) throw new Error('Sidebar is not measurable');
  const inlineDockWidth = 1280 - (sidebar.x + sidebar.width);
  const dock = await page.locator('.chat-dock').boundingBox();
  expect(dock?.x).toBe(sidebar.x + sidebar.width);
  expect(dock?.width).toBe(inlineDockWidth);
  expect(dock?.height).toBe(320);
  await page
    .getByRole('button', { name: 'Expand dock region to workspace' })
    .click();
  // The maximized dock is `height: 100% !important` inside a grid whose first
  // row is the toolbar (`index.css:7340-7346, 7377-7385`), so what it occupies
  // is decided by the LAYOUT, not by the `--app-toolbar-height` token the old
  // expectation derived from — those two disagree by 8.4px on this viewport,
  // and the token version could not tell that apart from the real defect.
  //
  // The two facts worth pinning are the ones a regression actually breaks: the
  // dock starts immediately below the toolbar, and it ends exactly at the
  // bottom of the viewport. A presenting system notice used to floor the
  // content row's minimum height and push the dock's bottom edge 58px past the
  // window; that shows up here as a failed second assertion rather than as an
  // arithmetic mismatch nobody can read.
  const toolbar = await page.locator('.app-toolbar').boundingBox();
  if (!toolbar) throw new Error('App toolbar is not measurable');
  await expect
    .poll(async () => {
      const box = await page.locator('.chat-dock').boundingBox();
      return box ? Math.round(box.y + box.height) : undefined;
    })
    .toBe(800);
  const maximized = await page.locator('.chat-dock').boundingBox();
  expect(Math.round(maximized?.y ?? -1)).toBe(
    Math.round(toolbar.y + toolbar.height),
  );
  // archive#1055: the maximized dock spans the full content column (from the
  // sidebar's right edge to the viewport edge), same geometry invariant as
  // the pre-maximize inline dock above — not a shrink-to-fit right-anchored
  // box.
  const maximizedDock = await page.locator('.chat-dock').boundingBox();
  expect(maximizedDock?.x).toBe(sidebar.x + sidebar.width);
  expect(maximizedDock?.width).toBe(inlineDockWidth);
  await page.getByRole('button', { name: 'Restore dock region size' }).click();
  // Restore now returns to the named Half snap, whose 45% viewport contract
  // resolves to 360px at this 800px desktop viewport (rather than reviving
  // the older fixed 320px default).
  await expect
    .poll(async () => (await page.locator('.chat-dock').boundingBox())?.height)
    .toBe(360);
  const resizeHandle = page.getByRole('separator', {
    name: 'Resize chat dock',
  });
  const handleBox = await resizeHandle.boundingBox();
  if (!handleBox) throw new Error('Desktop resize handle is not measurable');
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2, 365, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () =>
      Math.round((await page.locator('.chat-dock').boundingBox())?.height ?? 0),
    )
    .toBe(435);
});

test('right-dock composer spans the dock width (#1006)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockChatShell(page);
  await openComposer(page);
  // Cycle the open dock into right mode with the same keyboard shortcut the
  // dock-mode suite exercises — no reload, the open chat stays mounted.
  const chatDock = page.locator('.chat-dock');
  for (let i = 0; i < 3; i++) {
    const cls = (await chatDock.getAttribute('class')) ?? '';
    if (/chat-dock--right/.test(cls)) break;
    await page.keyboard.press('Meta+Shift+M');
    await expect
      .poll(async () => (await chatDock.getAttribute('class')) ?? '')
      .not.toBe(cls);
  }
  await expect(chatDock).toHaveClass(/chat-dock--right/);
  const textarea = page.locator('.chat-dock .chat-input textarea');
  await expect(textarea).toBeVisible({ timeout: 15_000 });
  // archive#1006: a stale pre-archive#972 row override laid the composer's children out in
  // a wrapping row, shrinking the message box to a fraction of the dock. The
  // textarea must span the dock's inner width (padding tolerance).
  const dockBox = (await chatDock.boundingBox())!;
  const textareaBox = (await textarea.boundingBox())!;
  expect(textareaBox.width).toBeGreaterThanOrEqual(dockBox.width - 60);
});

/**
 * archive#992: two mobile sheets shipped with a fully transparent panel — settled,
 * `opacity: 1`, `background-color: rgba(0, 0, 0, 0)` — so their content floated
 * over whatever was behind them. Nothing caught it: the responsive-surface
 * ratchet checks geometry and contract adoption, and jsdom does not run the
 * real cascade over `chat.css` + the theme tokens, so a unit test asserting a
 * computed surface there would pass on the broken CSS. The assertion has to
 * live in a real engine, which is here.
 *
 * Both themes, because the surface is token-driven and a token that resolves in
 * one skin and not the other is the same defect.
 */
const OPAQUE_SHEETS = [
  {
    name: 'header overflow sheet',
    open: async (page: Page) =>
      page.getByRole('button', { name: 'Chat actions' }).click(),
    panel: '.chat-dock__mobile-overflow-panel',
  },
  {
    name: 'approval-mode sheet',
    open: async (page: Page) =>
      page.locator('.chat-input__approval-chip').first().click(),
    panel: '.composer-mode-sheet',
  },
  {
    name: 'composer actions menu',
    open: async (page: Page) =>
      page.getByRole('button', { name: 'Composer actions' }).click(),
    panel: '.composer-actions-menu__panel',
  },
] as const;

test('mobile model provider filters keep a non-overlapping horizontal rail (#2266)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 540 });
  await mockChatShell(page);
  await page.route('**/api/connections/models', (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          {
            id: 'bedrock-prod',
            kind: 'model',
            type: 'bedrock',
            name: 'Bedrock Production',
            enabled: true,
            capabilities: ['llm'],
            config: {
              modelOptions: [
                { id: 'sonnet', name: 'Claude Sonnet' },
                { id: 'haiku', name: 'Claude Haiku' },
              ],
            },
            status: 'ready',
            prerequisites: [],
          },
          {
            id: 'vibe-proxy',
            kind: 'model',
            type: 'openai-compatible',
            name: 'VibeProxy (subscriptions)',
            enabled: true,
            capabilities: ['llm'],
            config: {
              modelOptions: [{ id: 'gpt-5.6', name: 'GPT-5.6' }],
            },
            status: 'ready',
            prerequisites: [],
          },
          {
            id: 'ollama-local',
            kind: 'model',
            type: 'ollama',
            name: 'Ollama Local',
            enabled: true,
            capabilities: ['llm'],
            config: {
              modelOptions: [{ id: 'qwen', name: 'Qwen' }],
            },
            status: 'ready',
            prerequisites: [],
          },
        ],
      }),
    ),
  );
  await openComposer(page, true, 'station');
  await page.locator('.chat-input__model-btn').first().click();

  const picker = page.getByRole('dialog', { name: 'Choose model' });
  const providerRail = picker.getByRole('group', { name: 'Providers' });
  const firstModel = picker.getByRole('option').first();
  await expect(providerRail).toBeVisible();
  await expect(firstModel).toBeVisible();

  const providerButtons = providerRail.getByRole('button');
  const lastProvider = providerButtons.last();
  const firstModelBox = await firstModel.boundingBox();
  const lastProviderBox = await lastProvider.boundingBox();
  expect(firstModelBox).not.toBeNull();
  expect(lastProviderBox).not.toBeNull();
  expect(lastProviderBox!.y + lastProviderBox!.height).toBeLessThanOrEqual(
    firstModelBox!.y,
  );

  const railOverflow = await providerRail.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: getComputedStyle(element).overflowX,
  }));
  expect(railOverflow.scrollWidth).toBeGreaterThan(railOverflow.clientWidth);
  expect(railOverflow.overflowX).toBe('auto');
});

for (const theme of ['dark', 'light'] as const) {
  test(`every mobile composer sheet renders an opaque panel surface (${theme}, #992)`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await mockChatShell(page);
    await openComposer(page, true);
    // ThemeToggle is not mounted in the mobile header, so drive the attribute
    // it would otherwise write directly.
    await page.evaluate((value) => {
      document.documentElement.setAttribute('data-theme', value);
    }, theme);
    // ...and confirm it took. Without this the light run silently measures
    // dark values if theming ever moves off `data-theme` — the test keeps
    // passing and its name becomes a lie. This trap already fired once while
    // the fix was being developed.
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--bg-primary')
          .trim(),
      ),
      `${theme} theme is actually applied`,
    ).toBe(theme === 'light' ? '#f5f4ef' : '#0a0e13');

    for (const sheet of OPAQUE_SHEETS) {
      await sheet.open(page);
      const panel = page.locator(sheet.panel);
      await expect(panel, sheet.name).toBeVisible();
      // Settle any open/scrim transition before reading the surface — a
      // mid-transition read would be a different measurement entirely.
      await expect
        .poll(
          async () => panel.evaluate((el) => getComputedStyle(el).opacity),
          { message: `${sheet.name} settles at full opacity` },
        )
        .toBe('1');

      // Any alpha below 1 — a translucent tint or the transparent keyword's
      // own `rgba(0, 0, 0, 0)` — means page content shows through the sheet.
      // Read it through the shared helper: an anchored `^rgba\(…\)$` regex
      // cannot see `color(srgb … / a)`, which is what Chromium serializes for
      // a `color-mix()` surface, so a translucent panel would read as opaque.
      const surface = await backgroundPaint(panel);
      expect(
        surface.alpha,
        `${sheet.name} background-color=${surface.color} (${theme})`,
      ).toBe(1);

      await page.keyboard.press('Escape');
      await expect(panel, sheet.name).toBeHidden();
    }
  });
}

/**
 * archive#992, the model-picker half — its own test because the picker is only
 * reachable on an engine that declares session model selection.
 *
 * The shared loop opens on the default `claude` fixture connection, whose
 * `type: 'claude'` carries no `engineId`, so
 * `resolveEngineCapabilityMatrix` (`packages/contracts/src/engine-capability-matrix.ts:986-991`)
 * misses `ENGINE_CAPABILITY_MATRICES` (the keyed entry is `claude`) and falls to
 * `UNKNOWN_EXTERNAL_ENGINE_MATRIX`, whose `modelSelection` is `unsupported` —
 * `ChatInputArea.tsx:373-380` then renders the trigger DISABLED with "This
 * engine does not support model selection for a chat session." The Station
 * engine is the binding this file already proves the picker on (the archive#2266
 * filter-rail test above), so the picker case moves onto it rather than being
 * dropped. The trigger is asserted ENABLED first: a disabled trigger is a
 * failure here, never a skip.
 */
for (const theme of ['dark', 'light'] as const) {
  test(`the mobile model picker renders an opaque panel surface (${theme}, #992)`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await mockChatShell(page);
    await page.route('**/api/connections/models', (route) =>
      route.fulfill(
        json({
          success: true,
          data: [
            {
              id: 'bedrock-prod',
              kind: 'model',
              type: 'bedrock',
              name: 'Bedrock Production',
              enabled: true,
              capabilities: ['llm'],
              config: {
                modelOptions: [
                  { id: 'sonnet', name: 'Claude Sonnet' },
                  { id: 'haiku', name: 'Claude Haiku' },
                ],
              },
              status: 'ready',
              prerequisites: [],
            },
          ],
        }),
      ),
    );
    await openComposer(page, true, 'station');
    await page.evaluate((value) => {
      document.documentElement.setAttribute('data-theme', value);
    }, theme);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--bg-primary')
          .trim(),
      ),
      `${theme} theme is actually applied`,
    ).toBe(theme === 'light' ? '#f5f4ef' : '#0a0e13');

    const trigger = page.locator('.chat-input__model-btn').first();
    await expect(trigger).toBeEnabled();
    await trigger.click();

    const panel = page.locator(
      '.chat-input__model-popover-panel .session-model-picker',
    );
    await expect(panel, 'model picker').toBeVisible();
    await expect
      .poll(async () => panel.evaluate((el) => getComputedStyle(el).opacity), {
        message: 'model picker settles at full opacity',
      })
      .toBe('1');
    const surface = await backgroundPaint(panel);
    expect(
      surface.alpha,
      `model picker background-color=${surface.color} (${theme})`,
    ).toBe(1);

    // The model popover's opt-out is otherwise unguarded: the wrapper's reset
    // block reads like dead CSS (`border: 0` on a wrapper with no border), and
    // deleting it would stack the shell's surface behind a picker whose rect is
    // pixel-identical — a second ring landing straight on the picker's own
    // border, with every other assertion still green.
    const wrapperLocator = page.locator('.chat-input__model-popover-panel');
    const wrapperPaint = await backgroundPaint(wrapperLocator);
    expect(
      wrapperPaint.alpha,
      `opt-out wrapper stays unpainted (got ${wrapperPaint.color})`,
    ).toBe(0);
    expect(
      await wrapperLocator.evaluate(
        (el) => getComputedStyle(el).borderTopWidth,
      ),
      'opt-out wrapper draws no ring',
    ).toBe('0px');

    await page.keyboard.press('Escape');
    await expect(panel, 'model picker').toBeHidden();
  });
}

test('a full-height task switcher keeps its dismiss header visible and tappable above the app toolbar (#1051)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatShell(page);
  // Enough chats that the sheet hits its max height and its header sits in
  // the app toolbar's band — the regression was the toolbar (root stacking
  // context, z-index 200) painting over the dock-nested overlay (z-index
  // local to the dock's own context), hiding the Close affordance.
  await seedActiveChats(page, [
    {
      sessionId: 'chat-running',
      conversationId: 'conv-running',
      agentSlug: 'station',
      projectSlug: 'default',
      projectName: 'Default',
      model: 'model-selected',
      orchestrationStatus: 'running',
      ephemeralMessages: [
        {
          role: 'assistant',
          content: 'Working through the current task.',
          timestamp: Date.parse('2026-07-19T10:00:00Z'),
        },
      ],
    },
    ...Array.from({ length: 24 }, (_, i) => ({
      sessionId: `chat-bulk-${i}`,
      conversationId: `conv-bulk-${i}`,
      agentSlug: 'station',
      projectSlug: 'default',
      projectName: 'Default',
      model: 'model-selected',
      ephemeralMessages: [
        {
          role: 'assistant' as const,
          content: `Bulk chat ${i}`,
          timestamp: Date.parse('2026-07-19T10:00:00Z') + i * 1000,
        },
      ],
    })),
  ]);

  // The shell mock's conversation catalog only knows conv-running/conv-review;
  // without this override the active-chats pruner deletes the bulk sessions on
  // load and the sheet never reaches full height.
  await page.route(/\/agents\/station\/conversations(?:\?.*)?$/, (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          {
            id: 'conv-running',
            title: 'Mobile running task',
            agentSlug: 'station',
          },
          ...Array.from({ length: 24 }, (_, i) => ({
            id: `conv-bulk-${i}`,
            title: `Bulk chat ${i}`,
            agentSlug: 'station',
          })),
        ],
      }),
    ),
  );

  await page.goto('/?dock=open&chat=conv-running');
  await dismissSetupLauncher(page);

  const switcher = page.getByRole('button', { name: /^Switch task/ });
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  await switcher.click();

  const menu = page.getByRole('dialog', { name: 'Switch task' });
  await expect(menu).toBeVisible();
  const showAll = menu.getByRole('button', {
    name: /Show all chats \(\d+ more\)/,
  });
  if (await showAll.count()) await showAll.click();
  // Restored bulk entries currently use the Station Chat display title.
  // Fullness is what matters: enough rows that the sheet hits max height.
  await expect
    .poll(async () =>
      menu.getByRole('button', { name: /^Station Chat/ }).count(),
    )
    .toBeGreaterThan(15);

  const close = page.getByRole('button', { name: 'Close task switcher' });
  await expect(close).toBeVisible();
  // The real assertion: the Close control must actually receive the tap —
  // Playwright refuses the click if another element (the app toolbar)
  // intercepts the pointer at its position.
  await close.click({ timeout: 5_000 });
  await expect(menu).not.toBeVisible();
});

test('dock drag-passthrough surfaces opt out of native touch panning (#1052)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatShell(page);
  await seedActiveChats(page, [
    {
      sessionId: 'chat-running',
      conversationId: 'conv-running',
      agentSlug: 'station',
      projectSlug: 'default',
      projectName: 'Default',
      model: 'model-selected',
      ephemeralMessages: [
        {
          role: 'assistant',
          content: 'Working through the current task.',
          timestamp: Date.parse('2026-07-19T10:00:00Z'),
        },
      ],
    },
  ]);
  await page.goto('/?dock=open&chat=conv-running');
  await dismissSetupLauncher(page);

  const identity = page.getByRole('button', { name: /^Switch task/ });
  await expect(identity).toBeVisible({ timeout: 15_000 });
  // touch-action does not inherit from the header bar; if a passthrough
  // control reverts to `auto`, real devices pointercancel the resize drag the
  // moment the browser claims the pan (scroll / pull-to-refresh).
  await expect
    .poll(() => identity.evaluate((el) => getComputedStyle(el).touchAction))
    .toBe('none');
});

test('every mobile dock header control is part of the drag surface (#1052)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChatShell(page);
  await seedActiveChats(page, [
    {
      sessionId: 'chat-running',
      conversationId: 'conv-running',
      agentSlug: 'station',
      projectSlug: 'default',
      projectName: 'Default',
      model: 'model-selected',
      ephemeralMessages: [
        {
          role: 'assistant',
          content: 'Working through the current task.',
          timestamp: Date.parse('2026-07-19T10:00:00Z'),
        },
      ],
    },
  ]);
  // Maximized so the app toolbar folds away and the header renders its drawer
  // toggle too — otherwise that control never appears in this fixture and the
  // sweep below would silently skip it (isMobileChatFullscreen gates it).
  await page.goto('/?dock=open&maximize=true&chat=conv-running');
  await dismissSetupLauncher(page);

  const header = page.getByTestId('chat-dock-mobile-header');
  await expect(header).toBeVisible({ timeout: 15_000 });
  await expect(
    header.getByRole('button', { name: 'Toggle menu' }),
  ).toBeVisible();

  // The owner's report: grabbing the header does nothing depending on where
  // the thumb lands, because a control that is not marked passthrough aborts
  // the drag before it starts (isInteractiveDockDragTarget). Every interactive
  // control in the bar must opt into the drag surface — the tap/drag
  // discrimination still delivers their clicks on a stationary press.
  const controls = header.locator('button');
  const total = await controls.count();
  // Identity block + drawer toggle + Activity + Chat actions.
  expect(total).toBe(3);
  for (let i = 0; i < total; i++) {
    const control = controls.nth(i);
    const name = (await control.getAttribute('aria-label')) ?? `control ${i}`;
    // One deliberate exception (archive#1052 follow-up): the visible dock toggle is
    // the gesture-FREE path, so it opts out of the drag surface instead of
    // into it. Anything else must be passthrough.
    if ((await control.getAttribute('data-no-dock-drag')) !== null) {
      expect(
        name,
        'navigation and action buttons keep a gesture-free tap path',
      ).toMatch(/^(Expand chat|Collapse chat|Toggle menu|Chat actions)$/);
      continue;
    }
    await expect(
      control,
      `${name} must be part of the dock drag surface`,
    ).toHaveAttribute('data-dock-drag-passthrough', '');
  }
});
