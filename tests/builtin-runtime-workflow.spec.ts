import { expect, test } from '@playwright/test';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import {
  emitMockOrchestrationEvent,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

const PROJECT = {
  id: 'p-default',
  slug: 'station',
  name: 'Default',
  description: 'Default project',
  hasWorkingDirectory: false,
  layoutCount: 0,
  hasKnowledge: false,
};

const AGENTS = [
  {
    slug: 'claude',
    name: 'Claude Runtime',
    description:
      'Direct chat using Claude Runtime with project working directory context when available.',
    source: 'local',
    execution: {
      agentConnectionId: 'claude-runtime',
      modelId: 'claude-sonnet-4-20250514',
    },
  },
  {
    slug: 'codex',
    name: 'Codex Runtime',
    description:
      'Direct chat using Codex Runtime with project working directory context when available.',
    source: 'local',
    execution: {
      agentConnectionId: 'codex-runtime',
      modelId: 'gpt-5-codex',
    },
  },
];

type ExecutionRequest = {
  conversationId?: string;
  message?: string;
  target?: { agent?: string };
};

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

async function seedRuntimeRoutes(
  page: import('@playwright/test').Page,
  commandBodies: any[] = [],
) {
  const runtimeHistory = {
    claude: [
      {
        id: 'conv-claude-1',
        title: 'Claude history',
        createdAt: '2026-04-12T00:00:00Z',
        updatedAt: '2026-04-12T00:01:00Z',
        messageCount: 2,
      },
    ],
    codex: [
      {
        id: 'conv-codex-1',
        title: 'Codex history',
        createdAt: '2026-04-12T00:00:00Z',
        updatedAt: '2026-04-12T00:01:00Z',
        messageCount: 2,
      },
    ],
  } as Record<string, any[]>;

  await installMockOrchestrationEventWindow(page, 'claude', {
    'conv-claude-1': historicalTurn(
      'conv-claude-1',
      'turn-claude-history',
      'claude',
      'hello claude',
      'Claude says hi',
    ),
    'conv-codex-1': historicalTurn(
      'conv-codex-1',
      'turn-codex-history',
      'codex',
      'hello codex',
      'Codex says hi',
    ),
  });

  const runtimeMessages = {
    'conv-claude-1': [
      {
        role: 'user',
        parts: [{ type: 'text', text: 'hello claude' }],
        metadata: { timestamp: '2026-04-12T00:00:00Z' },
      },
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'Claude says hi' }],
        metadata: { timestamp: '2026-04-12T00:00:01Z' },
      },
    ],
    'conv-codex-1': [
      {
        role: 'user',
        parts: [{ type: 'text', text: 'hello codex' }],
        metadata: { timestamp: '2026-04-12T00:00:00Z' },
      },
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'Codex says hi' }],
        metadata: { timestamp: '2026-04-12T00:00:01Z' },
      },
    ],
  } as Record<string, any[]>;

  const runtimeInventory = Object.entries(runtimeHistory).flatMap(
    ([agentSlug, conversations]) =>
      conversations.map((conversation) => ({
        ...conversation,
        source: 'runtime',
        agentSlug,
        projectSlug: 'default',
        mutable: false,
        answerability: { answerable: true },
      })),
  );

  await Promise.all([
    page.route('**/api/system/status', (route) =>
      route.fulfill(
        json({
          ready: true,
          acp: { connected: false, connections: [] },
          providers: {
            configured: [],
            detected: { ollama: false, bedrock: false },
          },
          capabilities: {
            chat: { ready: true, source: 'codex-runtime' },
            runtime: { ready: true, source: 'codex-runtime' },
            knowledge: { ready: false, source: null },
            acp: { ready: false, source: null },
          },
          recommendation: null,
          prerequisites: [],
          clis: { codex: true, claude: true, 'kiro-cli': false },
        }),
      ),
    ),
    page.route('**/api/system/capabilities', (route) =>
      route.fulfill(
        json({
          voice: { stt: [], tts: [] },
          context: { providers: [] },
        }),
      ),
    ),
    page.route('**/api/models/capabilities', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    ),
    page.route('**/api/projects', (route) =>
      route.fulfill(json({ success: true, data: [PROJECT] })),
    ),
    page.route('**/api/projects/default', (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            ...PROJECT,
            createdAt: '2026-04-12T00:00:00Z',
            updatedAt: '2026-04-12T00:00:00Z',
          },
        }),
      ),
    ),
    page.route('**/api/agents', (route) =>
      route.fulfill(json({ success: true, data: AGENTS })),
    ),
    page.route('**/api/connections/agents', (route) =>
      route.fulfill(
        json({
          success: true,
          data: [
            agentConnectionFixture({
              id: 'claude-runtime',
              kind: 'agent',
              type: 'claude-runtime',
              name: 'Claude Runtime',
              enabled: true,
              capabilities: ['agent-runtime'],
              config: {
                executionClass: 'connected',
                defaultModel: 'claude-sonnet-4-20250514',
              },
              runtimeCatalog: {
                source: 'live',
                models: [
                  {
                    id: 'claude-sonnet-4-20250514',
                    name: 'Claude Sonnet 4',
                    originalId: 'claude-sonnet-4-20250514',
                  },
                ],
                builtInModels: [],
              },
              status: 'ready',
              prerequisites: [],
            }),
            agentConnectionFixture({
              id: 'codex-runtime',
              kind: 'agent',
              type: 'codex-runtime',
              name: 'Codex Runtime',
              enabled: true,
              capabilities: ['agent-runtime'],
              config: {
                executionClass: 'connected',
                defaultModel: 'gpt-5-codex',
              },
              runtimeCatalog: {
                source: 'live',
                models: [
                  {
                    id: 'gpt-5-codex',
                    name: 'GPT-5 Codex',
                    originalId: 'gpt-5-codex',
                  },
                ],
                builtInModels: [],
              },
              status: 'ready',
              prerequisites: [],
            }),
          ],
        }),
      ),
    ),
    page.route('**/api/connections/models', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    ),
    page.route('**/config/app', (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            defaultModel: 'claude-sonnet-4-20250514',
          },
        }),
      ),
    ),
    page.route('**/api/orchestration/providers', (route) =>
      route.fulfill(
        json({
          success: true,
          data: [
            { provider: 'claude', activeSessions: 0, prerequisites: [] },
            { provider: 'codex', activeSessions: 0, prerequisites: [] },
          ],
        }),
      ),
    ),
    page.route('**/api/orchestration/commands', async (route) => {
      const payload = route.request().postDataJSON();
      commandBodies.push(payload);
      await route.fulfill(
        json({
          success: true,
          data: {
            ok: true,
            echoedType: payload?.type,
          },
        }),
      );
    }),
    page.route('**/api/orchestration/chat', async (route) => {
      const payload = route.request().postDataJSON() as ExecutionRequest;
      commandBodies.push(payload);
      const conversationId = payload.conversationId ?? 'runtime-conversation';
      await route.fulfill(
        json(
          foregroundMessageReceiptEnvelope({
            conversationId,
            providerTurnId: `provider-turn-${commandBodies.length}`,
            agent: payload.target?.agent ?? 'claude',
          }),
        ),
      );
    }),
    page.route(/\/agents\/[^/]+\/conversations(?:\?.*)?$/, (route) => {
      const match = new URL(route.request().url()).pathname.match(
        /\/agents\/([^/]+)\/conversations$/,
      );
      const slug = match?.[1] ? decodeURIComponent(match[1]) : '';
      route.fulfill(json({ success: true, data: runtimeHistory[slug] || [] }));
    }),
    page.route('**/agents/*/conversations/*/messages', (route) => {
      const match = route
        .request()
        .url()
        .match(/conversations\/([^/]+)\/messages/);
      const conversationId = match?.[1] ? decodeURIComponent(match[1]) : '';
      route.fulfill(
        json({ success: true, data: runtimeMessages[conversationId] || [] }),
      );
    }),
    page.route('**/api/conversations**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/conversations') {
        return route.fulfill(
          json({
            success: true,
            data: { items: runtimeInventory, hasMore: false },
          }),
        );
      }
      const conversationId = url.pathname.split('/').filter(Boolean).pop();
      const conversation = runtimeInventory.find(
        (entry) => entry.id === conversationId,
      );
      return route.fulfill(
        conversation
          ? json({ success: true, data: conversation })
          : json({ success: false, error: 'Not found' }, 404),
      );
    }),
    page.route('**/events', (route) => route.abort()),
  ]);
}

function historicalTurn(
  threadId: string,
  turnId: string,
  provider: string,
  prompt: string,
  answer: string,
) {
  const base = {
    threadId,
    turnId,
    provider,
    createdAt: '2026-04-12T00:00:00Z',
  };
  return [
    { ...base, eventId: `${turnId}-started`, method: 'turn.started', prompt },
    {
      ...base,
      eventId: `${turnId}-delta`,
      method: 'content.text-delta',
      itemId: `${turnId}-item`,
      delta: answer,
    },
    { ...base, eventId: `${turnId}-completed`, method: 'turn.completed' },
  ];
}

async function openRuntimeSession(
  page: import('@playwright/test').Page,
  runtimeName: 'Claude Runtime' | 'Codex Runtime',
) {
  await page.addInitScript(() => {
    localStorage.setItem('lastProject', 'default');
    localStorage.removeItem('recentAgents');
  });
  await page.goto('/?dock=open');
  await expect(
    page.locator('.chat-dock__tab-actions .chat-dock__new').nth(1),
  ).toBeVisible({ timeout: 15_000 });
  await dismissSetupLauncher(page);
  await page
    .locator('.chat-dock__tab-actions .chat-dock__new')
    .nth(1)
    .dispatchEvent('click');
  await expect(
    page.locator('.new-chat-modal__agent', { hasText: runtimeName }),
  ).toBeVisible({ timeout: 10_000 });
  await page
    .locator('.new-chat-modal__agent', { hasText: runtimeName })
    .dispatchEvent('click');
  await page.getByRole('button', { name: 'Earlier' }).click();
  const selectedChat = page
    .getByRole('complementary', { name: 'Inbox chats' })
    .locator('button[aria-current="true"]');
  await expect(selectedChat).toBeVisible();
  await expect(selectedChat).toContainText(runtimeName);
}

async function waitForExecutionThread(
  requests: ExecutionRequest[],
  message: string,
) {
  await expect
    .poll(
      () =>
        requests.find((request) => request.message === message)?.conversationId,
    )
    .toBeTruthy();
  return requests.find((request) => request.message === message)!
    .conversationId!;
}

async function dismissSetupLauncher(page: import('@playwright/test').Page) {
  const continueBtn = page.getByRole('button', {
    name: 'Continue Without Setup',
  });
  if (await continueBtn.isVisible().catch(() => false)) {
    await continueBtn.click({ force: true });
    await expect(continueBtn).not.toBeVisible({ timeout: 5_000 });
  }
}

test.describe('Built-in runtime chat workflows', () => {
  test('opens a Claude runtime session from New Chat', async ({ page }) => {
    await seedRuntimeRoutes(page);
    await openRuntimeSession(page, 'Claude Runtime');

    await expect(
      page
        .getByRole('complementary', { name: 'Inbox chats' })
        .locator('button[aria-current="true"]'),
    ).toContainText('Claude Runtime');
    await expect(page.locator('body')).toContainText('Default');
  });

  test('opens a Codex runtime session from New Chat', async ({ page }) => {
    await seedRuntimeRoutes(page);
    await openRuntimeSession(page, 'Codex Runtime');

    await expect(
      page
        .getByRole('complementary', { name: 'Inbox chats' })
        .locator('button[aria-current="true"]'),
    ).toContainText('Codex Runtime');
    await expect(page.locator('body')).toContainText('Default');
  });

  test('reopens Claude runtime history from the history panel', async ({
    page,
  }) => {
    await seedRuntimeRoutes(page);
    await page.addInitScript(() => {
      localStorage.setItem('lastProject', 'default');
      localStorage.removeItem('recentAgents');
    });
    await page.goto('/?dock=open');
    await expect(
      page.getByRole('button', { name: 'Conversation history' }),
    ).toBeVisible({ timeout: 15_000 });
    await dismissSetupLauncher(page);

    await page
      .getByRole('button', { name: 'Conversation history' })
      .click({ force: true });
    await expect(page.locator('.conversation-history')).toContainText(
      'Claude history',
    );
    await page
      .locator('.session-item__content', { hasText: 'Claude history' })
      .click();
    await page.getByRole('button', { name: 'Earlier' }).click();

    await expect(
      page
        .getByRole('complementary', { name: 'Inbox chats' })
        .locator('button[aria-current="true"]'),
    ).toContainText('Claude Runtime');
    await expect(page.locator('body')).toContainText('Claude says hi');
  });

  test('reopens Codex runtime history from the history panel', async ({
    page,
  }) => {
    await seedRuntimeRoutes(page);
    await page.addInitScript(() => {
      localStorage.setItem('lastProject', 'default');
      localStorage.removeItem('recentAgents');
    });
    await page.goto('/?dock=open');
    await expect(
      page.getByRole('button', { name: 'Conversation history' }),
    ).toBeVisible({ timeout: 15_000 });
    await dismissSetupLauncher(page);

    await page
      .getByRole('button', { name: 'Conversation history' })
      .click({ force: true });
    await expect(page.locator('.conversation-history')).toContainText(
      'Codex history',
    );
    await page
      .locator('.session-item__content', { hasText: 'Codex history' })
      .click();
    await page.getByRole('button', { name: 'Earlier' }).click();

    await expect(
      page
        .getByRole('complementary', { name: 'Inbox chats' })
        .locator('button[aria-current="true"]'),
    ).toContainText('Codex Runtime');
    await expect(page.locator('body')).toContainText('Codex says hi');
  });

  test('streams a Claude runtime reply end-to-end', async ({ page }) => {
    const commandBodies: any[] = [];
    await installMockOrchestrationSse(page);
    await seedRuntimeRoutes(page, commandBodies);
    await openRuntimeSession(page, 'Claude Runtime');
    await waitForMockOrchestrationSse(page);

    const textarea = page.locator('textarea[placeholder*="Type a message"]');
    await textarea.fill('hello claude');
    await page.getByRole('button', { name: 'Send' }).click();

    const threadId = await waitForExecutionThread(
      commandBodies,
      'hello claude',
    );
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'claude',
        threadId,
        createdAt: '2026-04-12T00:00:00.000Z',
        method: 'session.started',
        sessionId: threadId,
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'claude',
        threadId,
        createdAt: '2026-04-12T00:00:01.000Z',
        method: 'content.text-delta',
        itemId: 'item-1',
        delta: 'Claude says hi',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'claude',
        threadId,
        createdAt: '2026-04-12T00:00:02.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
      },
    });

    await expect(page.locator('body')).toContainText('Claude says hi');
  });

  test('restores a Claude runtime transcript after a full page reload', async ({
    page,
  }) => {
    /*
     * archive#3782/#3765: a runtime chat is DURABLE. Its first successful turn
     * promotes it to a conversation (`useActiveChatSessionMessaging`'s success
     * path assigns the receipt's `conversationId`), `serializeActiveChats`
     * persists exactly the chats that reached that point, and the dock stamps
     * that same durable identity into `?chat=` — so a plain reload reopens
     * this chat with its transcript. There is no Save affordance to press.
     *
     * Two things had to be true for this phase to run at all, and both are
     * fixed rather than asserted around:
     *   - the mock receipt above now carries `providerTurnId`, without which
     *     the SDK cannot read a response as accepted and every send in this
     *     spec took the indeterminate branch, which promotes nothing;
     *   - `ChatDock`'s `onSessionMigrate` no longer writes
     *     `conversationId ?? null`, which erased the very pointer this phase
     *     reloads with.
     */
    const commandBodies: any[] = [];
    await installMockOrchestrationSse(page);
    await seedRuntimeRoutes(page, commandBodies);
    await openRuntimeSession(page, 'Claude Runtime');
    await waitForMockOrchestrationSse(page);

    await page
      .locator('textarea[placeholder*="Type a message"]')
      .fill('remember this turn');
    await page.getByRole('button', { name: 'Send' }).click();

    const threadId = await waitForExecutionThread(
      commandBodies,
      'remember this turn',
    );
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        eventId: 'reload-turn-started',
        provider: 'claude',
        threadId,
        turnId: 'reload-turn',
        createdAt: '2026-04-12T00:00:00.000Z',
        method: 'turn.started',
        prompt: 'remember this turn',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        eventId: 'reload-turn-delta',
        provider: 'claude',
        threadId,
        turnId: 'reload-turn',
        createdAt: '2026-04-12T00:00:01.000Z',
        method: 'content.text-delta',
        itemId: 'reload-item',
        delta: 'I will remember this after reload',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        eventId: 'reload-turn-completed',
        provider: 'claude',
        threadId,
        turnId: 'reload-turn',
        createdAt: '2026-04-12T00:00:02.000Z',
        method: 'turn.completed',
      },
    });
    await expect(page.locator('body')).toContainText(
      'I will remember this after reload',
    );
    const restoredUserTurn = page
      .locator('.chat-messages .message.user')
      .filter({ hasText: 'remember this turn' });
    const restoredAssistantTurn = page
      .locator('.chat-messages .message.assistant')
      .filter({ hasText: 'I will remember this after reload' });
    await expect(restoredUserTurn).toHaveCount(1);
    await expect(restoredAssistantTurn).toHaveCount(1);

    await page.route(
      `**/agents/*/conversations/${encodeURIComponent(threadId)}/messages`,
      (route) =>
        route.fulfill(
          json({
            success: true,
            data: [
              {
                role: 'user',
                parts: [{ type: 'text', text: 'remember this turn' }],
                metadata: { timestamp: '2026-04-12T00:00:00Z' },
              },
              {
                role: 'assistant',
                parts: [
                  {
                    type: 'text',
                    text: 'I will remember this after reload',
                  },
                ],
                metadata: { timestamp: '2026-04-12T00:00:02Z' },
              },
            ],
          }),
        ),
    );
    await page.route('**/api/orchestration/sessions/read-model', (route) =>
      route.fulfill(
        json({
          success: true,
          data: [
            {
              provider: 'claude',
              threadId,
              status: 'ready',
              controlMode: 'station-owned',
              model: 'claude-sonnet-4-20250514',
              createdAt: '2026-04-12T00:00:00Z',
              updatedAt: '2026-04-12T00:00:02Z',
              isLoaded: true,
              isPersisted: true,
              eventCount: 3,
            },
          ],
        }),
      ),
    );

    await page.reload();
    await expect(page.locator('body')).toContainText(
      'I will remember this after reload',
      { timeout: 15_000 },
    );
    await expect(restoredUserTurn).toHaveCount(1);
    await expect(restoredAssistantTurn).toHaveCount(1);

    await page.route(
      `**/api/conversations/${encodeURIComponent(threadId)}`,
      (route) =>
        route.fulfill(
          json({
            success: true,
            data: {
              id: threadId,
              agentSlug: 'claude',
              projectSlug: 'default',
              title: 'remember this turn',
            },
          }),
        ),
    );
    await page.evaluate(() => sessionStorage.clear());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?dock=open&chat=${encodeURIComponent(threadId)}`);
    await expect(page.locator('body')).toContainText(
      'I will remember this after reload',
      { timeout: 15_000 },
    );
    await expect(restoredUserTurn).toHaveCount(1);
    await expect(restoredAssistantTurn).toHaveCount(1);
  });

  test('streams a Codex runtime reply end-to-end', async ({ page }) => {
    const commandBodies: any[] = [];
    await installMockOrchestrationSse(page);
    await seedRuntimeRoutes(page, commandBodies);
    await openRuntimeSession(page, 'Codex Runtime');
    await waitForMockOrchestrationSse(page);

    const textarea = page.locator('textarea[placeholder*="Type a message"]');
    await textarea.fill('hello codex');
    await page.getByRole('button', { name: 'Send' }).click();

    const threadId = await waitForExecutionThread(commandBodies, 'hello codex');
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId,
        createdAt: '2026-04-12T00:00:00.000Z',
        method: 'session.started',
        sessionId: threadId,
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId,
        createdAt: '2026-04-12T00:00:01.000Z',
        method: 'content.text-delta',
        itemId: 'item-1',
        delta: 'Codex says hi',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'codex',
        threadId,
        createdAt: '2026-04-12T00:00:02.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
      },
    });

    await expect(page.locator('body')).toContainText('Codex says hi');
  });

  test('renders a tool call and surfaces a runtime error for a Claude runtime turn', async ({
    page,
  }) => {
    const commandBodies: any[] = [];
    await installMockOrchestrationSse(page);
    await seedRuntimeRoutes(page, commandBodies);
    await openRuntimeSession(page, 'Claude Runtime');
    await waitForMockOrchestrationSse(page);

    const textarea = page.locator('textarea[placeholder*="Type a message"]');
    await textarea.fill('use a tool');
    await page.getByRole('button', { name: 'Send' }).click();

    const threadId = await waitForExecutionThread(commandBodies, 'use a tool');
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'claude',
        threadId,
        createdAt: '2026-04-12T00:00:00.000Z',
        method: 'tool.started',
        itemId: 'item-1',
        toolCallId: 'call-1',
        toolName: 'list_files',
        arguments: { path: '.' },
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'claude',
        threadId,
        createdAt: '2026-04-12T00:00:01.000Z',
        method: 'tool.completed',
        itemId: 'item-1',
        toolCallId: 'call-1',
        toolName: 'list_files',
        status: 'success',
        output: 'a.txt',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'claude',
        threadId,
        createdAt: '2026-04-12T00:00:02.000Z',
        method: 'runtime.error',
        severity: 'error',
        message: 'model timeout',
      },
    });
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'claude',
        threadId,
        createdAt: '2026-04-12T00:00:03.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
      },
    });

    // archive#2652 redesign: the settled activity renders inline as a quiet
    // verb-first row — no "Show N work activities" gate. Expanding the row
    // preserves the exact tool name in the detail meta...
    const activityRow = page.getByRole('button', { name: 'Used list files' });
    await expect(activityRow).toBeVisible();
    await activityRow.click();
    await expect(page.locator('body')).toContainText('list_files');
    // ...and a runtime error must surface, not vanish silently.
    await expect(page.locator('body')).toContainText('model timeout');
  });

  test('renders the tool-approval prompt and resolves it for a Claude runtime turn', async ({
    page,
  }) => {
    const commandBodies: any[] = [];
    await installMockOrchestrationSse(page);
    await seedRuntimeRoutes(page, commandBodies);
    await openRuntimeSession(page, 'Claude Runtime');
    await waitForMockOrchestrationSse(page);

    const textarea = page.locator('textarea[placeholder*="Type a message"]');
    await textarea.fill('delete a file');
    await page.getByRole('button', { name: 'Send' }).click();

    const threadId = await waitForExecutionThread(
      commandBodies,
      'delete a file',
    );

    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'claude',
        threadId,
        createdAt: '2026-04-12T00:00:00.000Z',
        method: 'session.started',
        sessionId: threadId,
      },
    });
    // A tool starts running...
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'claude',
        threadId,
        createdAt: '2026-04-12T00:00:01.000Z',
        method: 'tool.started',
        itemId: 'item-1',
        toolCallId: 'call-1',
        toolName: 'delete_file',
        arguments: { path: 'secret.txt' },
      },
    });
    // ...and the runtime opens an approval request for it.
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'claude',
        threadId,
        createdAt: '2026-04-12T00:00:02.000Z',
        method: 'request.opened',
        requestId: 'req-1',
        requestType: 'tool-approval',
        title: 'Approve tool use',
        payload: { toolName: 'delete_file' },
      },
    });

    // Pending approval stays compact until the user opens the queue, then its
    // approve/deny actions must render.
    await expect(page.locator('body')).toContainText('delete_file');
    const approvalQueue = page.getByRole('button', {
      name: '1 pending approval',
    });
    await expect(approvalQueue).toBeVisible({ timeout: 10_000 });
    const allowOnce = page.getByRole('button', { name: 'Allow Once' });
    await expect(allowOnce).toBeHidden();
    await approvalQueue.click();
    await expect(allowOnce).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();

    // Approving must dispatch a respondToRequest command with the accept
    // decision and the originating requestId, mirroring how the other tests
    // capture sendTurn command bodies.
    await allowOnce.click();

    await expect
      .poll(() =>
        commandBodies.some((body) => body.type === 'respondToRequest'),
      )
      .toBe(true);

    const respond = commandBodies.find(
      (body) => body.type === 'respondToRequest',
    );
    expect(respond.requestId).toBe('req-1');
    expect(respond.decision).toBe('accept');
    expect(respond.threadId).toBe(threadId);

    // Resolving the request clears the approval prompt.
    await emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        provider: 'claude',
        threadId,
        createdAt: '2026-04-12T00:00:03.000Z',
        method: 'request.resolved',
        requestId: 'req-1',
        status: 'approved',
      },
    });
    await expect(page.getByRole('button', { name: 'Allow Once' })).toHaveCount(
      0,
    );
  });
});
