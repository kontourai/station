import { expect, test } from '@playwright/test';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import {
  dismissSetupLauncher,
  emitMockOrchestrationEvent,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';

const DEFAULT_PROJECT = {
  id: 'p-default',
  slug: 'station',
  name: 'Default',
  description: 'Default project',
  hasWorkingDirectory: false,
  layoutCount: 0,
  hasKnowledge: false,
};

const DEFAULT_AGENT = {
  slug: 'station',
  name: 'Station',
  description: 'Default agent with full access to manage Station',
  source: 'local',
  model: 'llama3.2',
};

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

async function seedDefaultAgentRoutes(
  page: import('@playwright/test').Page,
  options?: {
    chatFailure?: boolean;
    initialConversations?: Array<{
      id: string;
      resourceId: string;
      userId: string;
      title: string;
      createdAt: string;
      updatedAt: string;
    }>;
    initialMessagesByConversation?: Record<string, any[]>;
  },
) {
  const state = {
    conversations: (options?.initialConversations ?? []) as Array<{
      id: string;
      resourceId: string;
      userId: string;
      title: string;
      createdAt: string;
      updatedAt: string;
    }>,
    messagesByConversation: (options?.initialMessagesByConversation ??
      {}) as Record<string, any[]>,
  };
  const executionRequests: Array<{
    conversationId?: string;
    message?: string;
  }> = [];

  const conversationInventory = () =>
    state.conversations.map((conversation) => ({
      id: conversation.id,
      source: 'store' as const,
      agentSlug: 'station',
      projectSlug: 'default',
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messageCount: state.messagesByConversation[conversation.id]?.length ?? 0,
      mutable: true,
      answerability: { answerable: true },
    }));

  await installMockOrchestrationSse(page);
  await installMockOrchestrationEventWindow(page, 'ollama');
  // Without a read-model the dock reports "Session record missing." for the
  // thread this fixture just started, and the chat never adopts its
  // conversation id — so `/stats` answers "No conversation ID available" for a
  // conversation that plainly exists. Reported from the executed turns, so it
  // cannot claim a session the test never started.
  await page.route('**/api/orchestration/sessions/read-model', (route) =>
    route.fulfill(
      json({
        success: true,
        data: executionRequests
          .map((request) => request.conversationId)
          .filter((id): id is string => typeof id === 'string')
          .map((threadId) => ({
            threadId,
            provider: 'ollama',
            status: 'ready',
            lifecycleState: 'idle',
            controlMode: 'station-owned',
            answerability: { answerable: true },
            isLoaded: true,
            isPersisted: true,
            eventCount: 2,
            createdAt: '2026-04-12T00:00:00Z',
            updatedAt: '2026-04-12T00:00:10Z',
          })),
      }),
    ),
  );

  await Promise.all([
    page.route('**/api/system/status', (route) =>
      route.fulfill(
        json({
          ready: true,
          acp: { connected: false, connections: [] },
          providers: {
            configuredChatReady: true,
            configured: [
              {
                id: 'ollama-local',
                type: 'ollama',
                enabled: true,
                capabilities: ['llm'],
              },
            ],
            detected: { ollama: true, bedrock: false },
          },
          capabilities: {
            chat: { ready: true, source: 'ollama' },
            runtime: { ready: false, source: null },
            knowledge: { ready: false, source: null },
            acp: { ready: false, source: null },
          },
          recommendation: null,
          prerequisites: [],
          clis: { codex: false, claude: false, 'kiro-cli': false },
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
    page.route('**/api/models', (route) =>
      route.fulfill(
        json({
          success: true,
          data: [
            {
              modelId: 'llama3.2',
              modelName: 'Llama 3.2',
              outputModalities: ['TEXT'],
            },
          ],
        }),
      ),
    ),
    page.route('**/api/projects', (route) =>
      route.fulfill(json({ success: true, data: [DEFAULT_PROJECT] })),
    ),
    page.route('**/api/projects/default', (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            ...DEFAULT_PROJECT,
            agents: ['station'],
            createdAt: '2026-04-12T00:00:00Z',
            updatedAt: '2026-04-12T00:00:00Z',
          },
        }),
      ),
    ),
    page.route('**/api/agents', (route) =>
      route.fulfill(json({ success: true, data: [DEFAULT_AGENT] })),
    ),
    page.route('**/api/agents/station', (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            ...DEFAULT_AGENT,
            toolsConfig: { mcpServers: ['station-control'], autoApprove: [] },
          },
        }),
      ),
    ),
    page.route('**/agents/station/tools', (route) =>
      route.fulfill(
        json({
          success: true,
          data: [
            {
              id: 'station-control_list_agents',
              server: 'station-control',
              toolName: 'list_agents',
              originalName: 'station-control_list_agents',
              description: 'List all configured agents',
              parameters: { properties: {} },
            },
            {
              id: 'station-control_create_prompt',
              server: 'station-control',
              toolName: 'create_prompt',
              originalName: 'station-control_create_prompt',
              description: 'Create a prompt',
              parameters: { properties: { name: { type: 'string' } } },
            },
          ],
        }),
      ),
    ),
    page.route('**/api/connections/agents', (route) =>
      route.fulfill(json({ success: true, data: [] })),
    ),
    page.route('**/api/connections/models', (route) =>
      route.fulfill(
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
      ),
    ),
    page.route('**/config/app', (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            defaultModel: 'llama3.2',
            defaultLLMProvider: 'ollama-local',
          },
        }),
      ),
    ),
    page.route('**/api/bedrock/models', (route) =>
      route.fulfill(json({ models: [] })),
    ),
    page.route(/\/agents\/station\/conversations(?:\?.*)?$/, (route) =>
      route.fulfill(json({ success: true, data: state.conversations })),
    ),
    page.route('**/api/conversations**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/conversations') {
        return route.fulfill(
          json({
            success: true,
            data: { items: conversationInventory(), hasMore: false },
          }),
        );
      }
      const conversationId = url.pathname.split('/').filter(Boolean).pop();
      const conversation = conversationInventory().find(
        (entry) => entry.id === conversationId,
      );
      return route.fulfill(
        conversation
          ? json({ success: true, data: conversation })
          : json({ success: false, error: 'Not found' }, 404),
      );
    }),
    page.route('**/agents/station/conversations/*/messages', (route) => {
      const match = route
        .request()
        .url()
        .match(/\/agents\/station\/conversations\/([^/]+)\/messages/);
      const conversationId = match?.[1]
        ? decodeURIComponent(match[1])
        : 'unknown';
      route.fulfill(
        json({
          success: true,
          data: state.messagesByConversation[conversationId] || [],
        }),
      );
    }),
    page.route('**/agents/station/conversations/*/stats', (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            // Required by `parseConversationStatsResponse`
            // (`packages/contracts/src/runtime.ts:137-168`); without it the
            // whole payload is rejected and `/stats` renders
            // "Invalid conversation stats response".
            modelId: 'llama3.2',
            contextTokens: 120,
            contextWindowPercentage: 1.5,
            systemPromptTokens: 20,
            mcpServerTokens: 10,
            userMessageTokens: 30,
            assistantMessageTokens: 60,
            inputTokens: 30,
            outputTokens: 60,
            totalTokens: 90,
            turns: 1,
            toolCalls: 0,
            estimatedCost: 0,
            // Every field is required per model:
            // `isConversationModelStats` (`packages/contracts/src/runtime.ts:120-134`)
            // demands all seven, and one missing key rejects the WHOLE
            // payload.
            modelStats: {
              'llama3.2': {
                inputTokens: 30,
                outputTokens: 60,
                totalTokens: 90,
                contextTokens: 120,
                turns: 1,
                toolCalls: 0,
                estimatedCost: 0,
              },
            },
          },
        }),
      ),
    ),
    page.route('**/agents/station/conversations/*', async (route) => {
      const match = route
        .request()
        .url()
        .match(/\/agents\/station\/conversations\/([^/?]+)/);
      const conversationId = match?.[1]
        ? decodeURIComponent(match[1])
        : 'unknown';

      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON() as { title?: string };
        state.conversations = state.conversations.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                title: body.title || conversation.title,
                updatedAt: '2026-04-12T00:00:20Z',
              }
            : conversation,
        );
        await route.fulfill(
          json({
            success: true,
            data: state.conversations.find(
              (conversation) => conversation.id === conversationId,
            ),
          }),
        );
        return;
      }

      if (route.request().method() === 'DELETE') {
        state.conversations = state.conversations.filter(
          (conversation) => conversation.id !== conversationId,
        );
        delete state.messagesByConversation[conversationId];
        await route.fulfill(json({ success: true }));
        return;
      }

      await route.fallback();
    }),
    page.route('**/api/orchestration/chat', async (route) => {
      const request = route.request().postDataJSON() as {
        conversationId?: string;
        message?: string;
      };
      executionRequests.push(request);
      if (options?.chatFailure) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: 'Synthetic provider failure',
          }),
        });
        return;
      }

      const conversationId = request.conversationId ?? 'conv-default-1';
      state.conversations = [
        {
          id: conversationId,
          resourceId: 'default',
          userId: 'brian',
          title: 'Station Chat',
          createdAt: '2026-04-12T00:00:00Z',
          updatedAt: '2026-04-12T00:00:10Z',
        },
      ];
      state.messagesByConversation[conversationId] = [
        {
          role: 'user',
          parts: [{ type: 'text', text: 'say hi in 3 words' }],
          metadata: { timestamp: '2026-04-12T00:00:01Z' },
        },
        {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Hi from Station!' }],
          metadata: { timestamp: '2026-04-12T00:00:02Z' },
        },
      ];

      await route.fulfill(
        json(
          foregroundMessageReceiptEnvelope({
            conversationId,
            providerTurnId: `provider-turn-${executionRequests.length}`,
            agent: 'station',
          }),
        ),
      );
    }),
    page.route('**/events', (route) => route.abort()),
  ]);

  return { executionRequests };
}

async function openDefaultAgentSession(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'station-connect-connections',
      JSON.stringify([
        {
          id: 'c1',
          name: 'Dev Server',
          url: window.location.origin,
          lastConnected: Date.now(),
        },
      ]),
    );
    localStorage.setItem('station-connect-connections-active', 'c1');
    localStorage.setItem('lastProject', 'default');
    localStorage.removeItem('recentAgents');
  });
  await page.goto('/?dock=open');
  await dismissSetupLauncher(page);
  await expect(
    page.locator('.chat-dock__tab-actions .chat-dock__new').nth(1),
  ).toBeVisible({ timeout: 15_000 });
  await page
    .locator('.chat-dock__tab-actions .chat-dock__new')
    .nth(1)
    .dispatchEvent('click');
  // archive#3309 (`components/agent-selection-policy.ts:129-141`,
  // `ChatDock.tsx:1005-1016`): with exactly one chat-ready agent — which is
  // all this fixture seeds — the dock's New button opens that chat DIRECTLY
  // and no picker ever mounts. The picker was incidental setup here; the
  // outcome it was implicitly guaranteeing, that the right agent opened, is
  // asserted instead. Picker coverage lives in
  // `tests/new-chat-provider-managed.spec.ts`.
  await expect(
    page.getByRole('button', { name: /^Model: Station — llama3\.2/ }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator('textarea[placeholder*="Type a message"]'),
  ).toBeVisible({
    timeout: 10_000,
  });
  await waitForMockOrchestrationSse(page);
}

async function emitDefaultReply(
  page: import('@playwright/test').Page,
  threadId: string,
) {
  const turnId = 'turn-default-1';
  const event = (suffix: string, method: string, extra = {}) =>
    emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        eventId: `${turnId}-${suffix}`,
        provider: 'ollama',
        threadId,
        turnId,
        createdAt: '2026-04-12T00:00:00Z',
        method,
        ...extra,
      },
    });

  await event('started', 'turn.started', { prompt: 'say hi in 3 words' });
  await event('delta', 'content.text-delta', {
    itemId: 'item-default-1',
    delta: 'Hi from Station!',
  });
  await event('completed', 'turn.completed');
}

test.describe('Default agent workflow', () => {
  test('supports key slash commands and persists sent chats to history', async ({
    page,
  }) => {
    const { executionRequests } = await seedDefaultAgentRoutes(page);
    await openDefaultAgentSession(page);

    const textarea = page.locator('textarea[placeholder*="Type a message"]');
    const sendButton = page.getByRole('button', { name: 'Send' });

    for (const [command, matcher] of [
      ['/mcp', /MCP servers are unavailable for this binding/],
      ['/tools', /Tool inventory is unavailable for this binding/],
      // Playbooks merged into Skills: `/prompts` is no longer a command at all
      // (the composer answers "Unknown command: /prompts"). The command that
      // lists the commands is `/commands`
      // (`src-ui/src/slashCommands/builtins.ts:70-115`), and with no custom
      // commands and no command skills seeded it says so.
      ['/commands', /No commands defined/],
      ['/stats', /No conversation ID available/],
    ] as const) {
      await textarea.fill(command);
      await sendButton.click();
      await expect(page.locator('body')).toContainText(matcher);
    }

    await textarea.fill('say hi in 3 words');
    await sendButton.click();
    await expect
      .poll(() =>
        executionRequests.some(
          (request) => request.message === 'say hi in 3 words',
        ),
      )
      .toBe(true);
    const threadId = executionRequests.find(
      (request) => request.message === 'say hi in 3 words',
    )?.conversationId;
    expect(threadId).toBeTruthy();
    await emitDefaultReply(page, threadId!);
    await expect(page.locator('body')).toContainText('Hi from Station!');

    await textarea.fill('/stats');
    await sendButton.click();
    await expect(page.locator('body')).toContainText('Conversation Statistics');

    await textarea.fill('/clear');
    await sendButton.click();
    await expect(page.locator('body')).toContainText('Conversation cleared');

    await textarea.fill('/new');
    await sendButton.click();
    await expect(page.locator('body')).toContainText('Conversation cleared');

    await page.getByRole('button', { name: 'Conversation history' }).click();
    await expect(page.locator('.conversation-history')).toContainText(
      'History (1)',
    );
    await expect(page.locator('.conversation-history')).toContainText(
      'Station Chat',
    );
  });

  test('surfaces provider errors ephemerally instead of silently no-oping', async ({
    page,
  }) => {
    await seedDefaultAgentRoutes(page, { chatFailure: true });
    await openDefaultAgentSession(page);

    const textarea = page.locator('textarea[placeholder*="Type a message"]');
    await textarea.fill('trigger failure');
    await page.getByRole('button', { name: 'Send' }).click();

    // archive#191 R1: the SDK client now parses the server's JSON error body
    // instead of discarding it behind a bare 'HTTP ${status}' string, so the
    // ephemeral bubble shows the real failure reason.
    await expect(page.locator('body')).toContainText(
      'Error: Synthetic provider failure',
    );
  });

  test('renders a persisted [SYSTEM_EVENT][CHAT_ERROR] marker with the same translated copy shown live (#191 R2 persistence-gap fix)', async ({
    page,
  }) => {
    await seedDefaultAgentRoutes(page, {
      initialConversations: [
        {
          id: 'conv-failed',
          resourceId: 'default',
          userId: 'brian',
          title: 'Failed Chat',
          createdAt: '2026-04-12T00:00:00Z',
          updatedAt: '2026-04-12T00:00:10Z',
        },
      ],
      initialMessagesByConversation: {
        'conv-failed': [
          {
            role: 'user',
            parts: [{ type: 'text', text: 'trigger failure' }],
          },
          {
            role: 'user',
            parts: [
              {
                type: 'text',
                text:
                  '[SYSTEM_EVENT] [CHAT_ERROR] AccessDeniedException: ' +
                  'User is not authorized to perform: bedrock:InvokeModel',
              },
            ],
          },
        ],
      },
    });
    await page.addInitScript(() => {
      localStorage.setItem(
        'station-connect-connections',
        JSON.stringify([
          {
            id: 'c1',
            name: 'Dev Server',
            url: window.location.origin,
            lastConnected: Date.now(),
          },
        ]),
      );
      localStorage.setItem('station-connect-connections-active', 'c1');
      localStorage.setItem('lastProject', 'default');
      localStorage.removeItem('recentAgents');
    });
    await page.goto('/?dock=open');
    await dismissSetupLauncher(page);
    await expect(
      page.getByRole('button', { name: 'Conversation history' }),
    ).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: 'Conversation history' }).click();
    await expect(page.locator('.conversation-history')).toContainText(
      'Failed Chat',
    );
    await page
      .locator('.session-item__content', { hasText: 'Failed Chat' })
      .click();

    // A reload/reopen of a conversation whose turn failed with zero output
    // shows the same translated copy the live SSE path would have shown —
    // never the raw exception text, and never a silent swallow of the
    // failure (the plan's persistence-gap Stop-short risk).
    await expect(page.locator('body')).toContainText(
      'Model is not enabled for this account/region',
    );
    await expect(page.locator('body')).toContainText('AWS Bedrock console');
    await expect(page.locator('body')).not.toContainText(
      'AccessDeniedException',
    );
  });

  test('supports history rename, delete, and clear-all flows', async ({
    page,
  }) => {
    await seedDefaultAgentRoutes(page, {
      initialConversations: [
        {
          id: 'conv-a',
          resourceId: 'default',
          userId: 'brian',
          title: 'Alpha Chat',
          createdAt: '2026-04-12T00:00:00Z',
          updatedAt: '2026-04-12T00:00:10Z',
        },
        {
          id: 'conv-b',
          resourceId: 'default',
          userId: 'brian',
          title: 'Beta Chat',
          createdAt: '2026-04-12T00:00:00Z',
          updatedAt: '2026-04-12T00:00:05Z',
        },
      ],
    });
    await page.addInitScript(() => {
      localStorage.setItem(
        'station-connect-connections',
        JSON.stringify([
          {
            id: 'c1',
            name: 'Dev Server',
            url: window.location.origin,
            lastConnected: Date.now(),
          },
        ]),
      );
      localStorage.setItem('station-connect-connections-active', 'c1');
      localStorage.setItem('lastProject', 'default');
      localStorage.removeItem('recentAgents');
    });
    await page.goto('/?dock=open');
    await dismissSetupLauncher(page);
    await expect(
      page.getByRole('button', { name: 'Conversation history' }),
    ).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: 'Conversation history' }).click();
    const history = page.locator('.conversation-history');
    await expect(history).toContainText('Alpha Chat');
    await expect(history).toContainText('Beta Chat');

    const alphaItem = page
      .locator('.session-item')
      .filter({ hasText: 'Alpha Chat' });
    await alphaItem.getByTitle('Rename').click();
    await page.locator('.session-item__rename-input').fill('Renamed Chat');
    await page.locator('.session-item__rename-input').press('Enter');
    await expect(history).toContainText('Renamed Chat');

    const betaItem = page
      .locator('.session-item')
      .filter({ hasText: 'Beta Chat' });
    await betaItem.getByTitle('Delete').click();
    await page.getByRole('button', { name: 'Delete' }).last().click();
    await expect(history).not.toContainText('Beta Chat');

    await page.getByRole('button', { name: 'Clear All' }).click();
    await page.getByRole('button', { name: 'Clear All' }).last().click();
    await expect(history).toContainText('No conversations yet');
  });
});
