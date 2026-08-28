import { writeFileSync } from 'node:fs';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { createDailyDriverUiObservation } from '../scripts/lib/daily-driver-ui-observation.mjs';
import { monitorBrowserHealth } from './helpers/browser-health';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import {
  emitMockOrchestrationEvent,
  installMockOrchestrationConversationEventWindow,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';

type ExecutionRequest = {
  target?: {
    environment?: { kind?: string };
    agent?: string;
    model?: { override?: string; options?: Record<string, unknown> };
    workspace?: { kind?: string; projectSlug?: string };
  };
  message?: string;
  conversationId?: string;
  clientTurnId?: string;
};

const PROJECTS = [
  {
    id: 'p-alpha',
    slug: 'alpha',
    name: 'Alpha Project',
    icon: '🅰️',
    description: 'Managed, connected Claude, and ACP chat project.',
    hasWorkingDirectory: true,
    workingDirectory: '/work/alpha',
    layoutCount: 0,
    hasKnowledge: false,
  },
  {
    id: 'p-beta',
    slug: 'beta',
    name: 'Beta Project',
    icon: '🅱️',
    description: 'Connected Codex-only chat project.',
    hasWorkingDirectory: true,
    workingDirectory: '/work/beta',
    layoutCount: 0,
    hasKnowledge: false,
  },
];

const PROJECT_CONFIGS = {
  alpha: {
    ...PROJECTS[0],
    agents: ['station', 'claude', 'kiro', 'other-acp'],
    defaultProviderId: 'ollama-local',
    defaultModel: 'llama3.2',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  },
  beta: {
    ...PROJECTS[1],
    agents: ['codex'],
    defaultProviderId: 'ollama-local',
    defaultModel: 'llama3.2',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  },
} as const;

const AGENTS = [
  {
    slug: 'station',
    name: 'Station',
    description: 'Provider-managed fallback agent.',
    source: 'local',
    toolsConfig: { mcpServers: [], autoApprove: [] },
  },
  {
    slug: 'claude',
    name: 'Claude Runtime',
    description: 'Connected Claude runtime.',
    source: 'local',
    execution: {
      agentConnectionId: 'claude-runtime',
      modelId: 'claude-sonnet-4-20250514',
    },
  },
  {
    slug: 'codex',
    name: 'Codex Runtime',
    description: 'Connected Codex runtime.',
    source: 'local',
    execution: {
      agentConnectionId: 'codex-runtime',
      modelId: 'gpt-5-codex',
    },
  },
  {
    slug: 'kiro',
    name: 'kiro-cli',
    description: 'ACP chat mode.',
    source: 'acp',
    engineConnectionType: 'acp',
    connectionName: 'kiro-cli',
    execution: { agentConnectionId: 'kiro' },
  },
  {
    slug: 'other-acp',
    name: 'other-cli',
    description: 'ACP chat mode (unavailable connection).',
    source: 'acp',
    engineConnectionType: 'acp',
    connectionName: 'other-cli',
    execution: { agentConnectionId: 'other-acp' },
  },
];

const RUNTIME_CONNECTIONS = [
  agentConnectionFixture({
    id: 'bedrock-runtime',
    kind: 'agent',
    type: 'bedrock-runtime',
    name: 'Managed Runtime',
    enabled: true,
    capabilities: ['agent-runtime'],
    config: { executionClass: 'managed', defaultModel: 'llama3.2' },
    status: 'ready',
    prerequisites: [],
  }),
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
    id: 'kiro',
    kind: 'agent',
    type: 'acp',
    name: 'kiro-cli',
    enabled: true,
    capabilities: ['agent-runtime'],
    config: { executionClass: 'external', defaultModel: 'kiro-chat' },
    status: 'ready',
    prerequisites: [],
  }),
  agentConnectionFixture({
    id: 'other-acp',
    kind: 'agent',
    type: 'acp',
    name: 'other-cli',
    enabled: true,
    capabilities: ['agent-runtime'],
    config: { executionClass: 'external' },
    status: 'degraded',
    prerequisites: [],
  }),
  agentConnectionFixture({
    id: 'codex-runtime',
    kind: 'agent',
    type: 'codex-runtime',
    name: 'Codex Runtime',
    enabled: true,
    capabilities: ['agent-runtime'],
    config: { executionClass: 'connected', defaultModel: 'gpt-5-codex' },
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
];

const MODEL_CONNECTIONS = [
  {
    id: 'ollama-local',
    kind: 'model',
    type: 'ollama',
    name: 'Local Ollama',
    enabled: true,
    capabilities: ['llm'],
    config: {
      baseUrl: 'http://localhost:11434',
      defaultModel: 'llama3.2',
      modelOptions: [{ id: 'llama3.2', name: 'Llama 3.2' }],
    },
    status: 'ready',
    prerequisites: [],
  },
];

const CONVERSATIONS = {
  station: [
    {
      id: 'conv-managed-alpha',
      title: 'Station Chat',
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:03:00Z',
      messageCount: 2,
      projectSlug: 'alpha',
    },
  ],
  claude: [
    {
      id: 'conv-claude-alpha',
      title: 'Claude Alpha Chat',
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:02:00Z',
      messageCount: 2,
      projectSlug: 'alpha',
    },
  ],
  codex: [
    {
      id: 'conv-codex-beta',
      title: 'Codex Beta Chat',
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:01:00Z',
      messageCount: 2,
      projectSlug: 'beta',
    },
  ],
  kiro: [
    {
      id: 'conv-acp-alpha',
      title: 'ACP Alpha Chat',
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:30Z',
      messageCount: 2,
      projectSlug: 'alpha',
    },
  ],
} as Record<string, Array<Record<string, unknown>>>;

const CONVERSATION_INVENTORY = Object.entries(CONVERSATIONS).flatMap(
  ([agentSlug, conversations]) =>
    conversations.map((conversation) => ({
      ...conversation,
      source: agentSlug === 'station' ? 'store' : 'runtime',
      agentSlug,
      projectSlug: conversation.projectSlug,
      mutable: agentSlug === 'station',
      answerability: { answerable: true },
    })),
);

const MESSAGES = {
  'conv-managed-alpha': [
    message('user', 'Use the managed fallback for Alpha.'),
    message('assistant', 'Managed Alpha transcript loaded.'),
  ],
  'conv-claude-alpha': [
    message('user', 'Ask connected Claude about Alpha.'),
    message('assistant', 'Claude Alpha transcript loaded.'),
  ],
  'conv-codex-beta': [
    message('user', 'Ask connected Codex about Beta.'),
    message('assistant', 'Codex Beta transcript loaded.'),
  ],
  'conv-acp-alpha': [
    message('user', 'Ask the ACP agent about Alpha.'),
    message('assistant', 'ACP Alpha transcript loaded.'),
  ],
} as Record<string, Array<Record<string, unknown>>>;

const PRODUCT_PATHS = [
  {
    profile: 'claude-default',
    provider: 'claude',
    agentSlug: 'claude',
    runtimeName: 'Claude Runtime',
    project: 'Alpha Project',
    projectSlug: 'alpha',
    sessionId: 'conv-claude-alpha',
    conversationId: 'conv-claude-alpha',
    prompt: 'Run the deterministic Claude smoke confirmation.',
  },
  {
    profile: 'codex-default',
    provider: 'codex',
    agentSlug: 'codex',
    runtimeName: 'Codex Runtime',
    project: 'Beta Project',
    projectSlug: 'beta',
    sessionId: 'conv-codex-beta',
    conversationId: 'conv-codex-beta',
    prompt: 'Run the deterministic Codex smoke confirmation.',
  },
] as const;

type ProductPath = (typeof PRODUCT_PATHS)[number];
type UiObservation = {
  profile: ProductPath['profile'];
  surface: 'ui';
  scenario: 'exact-confirmation';
  capability: 'exact-confirmation';
  repetition: 1;
  assistantMessageCount: number;
  terminal: boolean;
  workingCleared: boolean;
  workingStable: boolean;
  commandBinding: boolean;
  identityBinding: boolean;
  projectBinding: boolean;
  classification: 'exact_match' | 'rejected';
};

const SMOKE_REPLY = 'STATION_SMOKE_OK';
const SETTLEMENT_DEADLINE_MS = 1_000;
const SETTLEMENT_STABILITY_MS = 150;
const LONG_HOME_TITLE =
  'Remember the exact token CEDAR-82. Reply only: CODEX_CONTEXT_OK';

function remainingSettlementBudget(deadline: number) {
  const remainingMs = Math.floor(deadline - performance.now());
  expect(
    remainingMs,
    'settlement exceeded its one-second deadline',
  ).toBeGreaterThan(0);
  return remainingMs;
}

async function expectSettled(page: Page, timeout: number) {
  await expect(page.locator('.streaming-message')).toHaveCount(0, {
    timeout,
  });
  await expect(
    page.locator('.streaming-activity__label', { hasText: /^Working/ }),
  ).toHaveCount(0, { timeout });
}

async function expectSettledStability(page: Page, durationMs: number) {
  await page.evaluate(async (minimumDurationMs) => {
    const isSettled = () =>
      !document.querySelector('.streaming-message, .streaming-activity__label');
    if (!isSettled())
      throw new Error('streaming presentation was visible before stability');

    await new Promise<void>((resolve, reject) => {
      const startedAt = performance.now();
      let frame = 0;
      const observer = new MutationObserver(check);
      const cleanup = () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
      };
      const fail = () => {
        cleanup();
        reject(new Error('streaming presentation regressed during stability'));
      };
      function check() {
        if (!isSettled()) return fail();
        if (performance.now() - startedAt >= minimumDurationMs) {
          cleanup();
          resolve();
          return;
        }
        frame = requestAnimationFrame(check);
      }
      observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      frame = requestAnimationFrame(check);
    });
  }, durationMs);
}

function message(role: 'user' | 'assistant', text: string) {
  return {
    role,
    parts: [{ type: 'text', text }],
    metadata: { timestamp: '2026-05-01T00:00:00Z' },
  };
}

function historicalWindowEvents(
  threadId: string,
  messages: Array<Record<string, unknown>>,
) {
  const turnId = `turn-${threadId}`;
  const provider = threadId.includes('claude')
    ? 'claude'
    : threadId.includes('codex')
      ? 'codex'
      : threadId.includes('acp')
        ? 'kiro'
        : 'bedrock';
  const text = (index: number) =>
    (messages[index]?.parts as Array<{ text?: string }> | undefined)?.[0]
      ?.text ?? '';
  const base = {
    provider,
    threadId,
    turnId,
    createdAt: '2026-05-01T00:00:00Z',
  };
  return [
    {
      ...base,
      eventId: `${turnId}-started`,
      method: 'turn.started',
      prompt: text(0),
    },
    {
      ...base,
      eventId: `${turnId}-delta`,
      method: 'content.text-delta',
      itemId: `${turnId}-item`,
      delta: text(1),
    },
    { ...base, eventId: `${turnId}-completed`, method: 'turn.completed' },
  ];
}

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

async function seedCrossRuntimeRoutes(
  page: Page,
  executionRequests: ExecutionRequest[] = [],
) {
  const sessionIdsByConversation = {
    'conv-managed-alpha': ['session-managed-alpha'],
    'conv-claude-alpha': ['conv-claude-alpha'],
    'conv-codex-beta': ['conv-codex-beta'],
    'conv-acp-alpha': ['session-acp-alpha'],
  } as const;
  const historicalBySession = Object.fromEntries(
    Object.entries(MESSAGES).map(([conversationId, messages]) => [
      sessionIdsByConversation[
        conversationId as keyof typeof sessionIdsByConversation
      ][0],
      historicalWindowEvents(conversationId, messages),
    ]),
  );
  await installMockOrchestrationEventWindow(page, 'codex', historicalBySession);
  await installMockOrchestrationConversationEventWindow(
    page,
    (conversationId) => [
      ...(sessionIdsByConversation[
        conversationId as keyof typeof sessionIdsByConversation
      ] ?? []),
    ],
  );
  await page.addInitScript(() => {
    localStorage.setItem('lastProject', 'alpha');
    localStorage.setItem('station:onboarding-setup-dismissed', '1');
    localStorage.setItem(
      'station-device-settings-v1',
      JSON.stringify({
        version: 2,
        values: { chatDockProjectSlug: 'alpha' },
      }),
    );
    localStorage.removeItem('recentAgents');
    sessionStorage.setItem(
      'activeChats',
      JSON.stringify([
        {
          sessionId: 'session-managed-alpha',
          conversationId: 'conv-managed-alpha',
          agentSlug: 'station',
          model: 'llama3.2',
          projectSlug: 'alpha',
          projectName: 'Alpha Project',
          executionMode: 'station',
          executionScope: 'project',
          providerId: 'ollama-local',
          provider: 'ollama',
          providerOptions: {},
          orchestrationSessionStarted: false,
          ephemeralMessages: [],
          inputHistory: [],
        },
        {
          sessionId: 'conv-claude-alpha',
          conversationId: 'conv-claude-alpha',
          agentSlug: 'claude',
          model: 'claude-sonnet-4-20250514',
          projectSlug: 'alpha',
          projectName: 'Alpha Project',
          executionMode: 'external',
          agentConnectionId: 'claude-runtime',
          provider: 'claude',
          providerOptions: { thinking: true, effort: 'medium' },
          orchestrationSessionStarted: false,
          ephemeralMessages: [],
          inputHistory: [],
        },
        {
          sessionId: 'conv-codex-beta',
          conversationId: 'conv-codex-beta',
          agentSlug: 'codex',
          model: 'gpt-5-codex',
          projectSlug: 'beta',
          projectName: 'Beta Project',
          executionMode: 'external',
          agentConnectionId: 'codex-runtime',
          provider: 'codex',
          providerOptions: { reasoningEffort: 'medium', fastMode: false },
          orchestrationSessionStarted: false,
          ephemeralMessages: [],
          inputHistory: [],
        },
        {
          sessionId: 'session-acp-alpha',
          conversationId: 'conv-acp-alpha',
          agentSlug: 'kiro',
          projectSlug: 'alpha',
          projectName: 'Alpha Project',
          executionMode: 'external',
          agentConnectionId: 'acp',
          provider: 'acp',
          providerOptions: {},
          orchestrationSessionStarted: false,
          ephemeralMessages: [],
          inputHistory: [],
        },
      ]),
    );
  });

  await page.route('**/api/system/status', (route) =>
    route.fulfill(
      json({
        ready: true,
        acp: {
          connected: true,
          connections: [{ id: 'kiro', status: 'available' }],
        },
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
          runtime: { ready: true, source: 'codex-runtime' },
          knowledge: { ready: false, source: null },
          acp: { ready: true, source: 'kiro-cli' },
        },
        recommendation: null,
        prerequisites: [],
        clis: { codex: true, claude: true, 'kiro-cli': true },
      }),
    ),
  );
  await page.route('**/api/system/capabilities', (route) =>
    route.fulfill(
      json({ voice: { stt: [], tts: [] }, context: { providers: [] } }),
    ),
  );
  await page.route('**/api/agents', (route) =>
    route.fulfill(json({ success: true, data: AGENTS })),
  );
  await page.route('**/api/connections/agents', (route) =>
    route.fulfill(json({ success: true, data: RUNTIME_CONNECTIONS })),
  );
  await page.route('**/api/connections/models', (route) =>
    route.fulfill(json({ success: true, data: MODEL_CONNECTIONS })),
  );
  await page.route('**/api/models/**', (route) =>
    route.fulfill(json({ success: true, data: [] })),
  );
  await page.route('**/config/app', (route) =>
    route.fulfill(
      json({
        success: true,
        data: { defaultLLMProvider: 'ollama-local', defaultModel: 'llama3.2' },
      }),
    ),
  );
  await page.route('**/api/config/app', (route) =>
    route.fulfill(
      json({
        success: true,
        data: { defaultLLMProvider: 'ollama-local', defaultModel: 'llama3.2' },
      }),
    ),
  );
  await page.route('**/acp/connections', (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          {
            id: 'kiro',
            name: 'kiro-cli',
            command: 'kiro-cli',
            args: ['acp'],
            enabled: true,
            status: 'available',
            modes: [{ id: 'chat', name: 'Chat' }],
            sessionId: 'sess-kiro',
          },
        ],
      }),
    ),
  );
  await page.route('**/api/orchestration/providers', (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          { provider: 'claude', activeSessions: 0, prerequisites: [] },
          { provider: 'codex', activeSessions: 0, prerequisites: [] },
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
            threadId: 'conv-claude-alpha',
            displayTitle: 'Claude Alpha Chat',
            status: 'completed',
            controlMode: 'station-owned',
            model: 'claude-sonnet-4-20250514',
            projectSlug: 'alpha',
            cwd: '/work/alpha',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:02:00.000Z',
            isLoaded: true,
            isPersisted: true,
            eventCount: 2,
            lastEventAt: '2026-05-01T00:02:00.000Z',
            lastEventMethod: 'turn.completed',
          },
          {
            provider: 'codex',
            threadId: 'conv-codex-beta',
            displayTitle: 'Codex Beta Chat',
            status: 'completed',
            controlMode: 'station-owned',
            model: 'gpt-5-codex',
            projectSlug: 'beta',
            cwd: '/work/beta',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:01:00.000Z',
            isLoaded: true,
            isPersisted: true,
            eventCount: 2,
            lastEventAt: '2026-05-01T00:01:00.000Z',
            lastEventMethod: 'turn.completed',
          },
          {
            provider: 'codex',
            threadId: 'daily-driver-mobile-home',
            displayTitle: LONG_HOME_TITLE,
            status: 'completed',
            controlMode: 'station-owned',
            model: 'gpt-5-codex',
            cwd: '/Users/brian/dev/github/kontourai/station',
            createdAt: '2026-08-02T15:00:00.000Z',
            updatedAt: '2026-08-02T15:01:00.000Z',
            isLoaded: false,
            isPersisted: true,
            eventCount: 2,
            lastEventAt: '2026-08-02T15:01:00.000Z',
            lastEventMethod: 'turn.completed',
          },
        ],
      }),
    ),
  );
  await page.route('**/api/orchestration/commands', async (route) => {
    await route.fulfill(json({ success: true, data: { ok: true } }));
  });
  await page.route('**/api/orchestration/chat', async (route) => {
    const payload = route.request().postDataJSON() as ExecutionRequest;
    executionRequests.push(payload);
    const conversationId = payload.conversationId ?? 'conversation:mock';
    const agent = payload.target?.agent ?? 'station';
    const projectSlug = payload.target?.workspace?.projectSlug ?? 'station';
    await route.fulfill(
      json(
        foregroundMessageReceiptEnvelope({
          conversationId,
          agent,
          resolution: {
            engine: {
              kind: 'connection',
              connectionId: engineConnectionId(`${agent}-runtime`),
            },
            workspace: {
              kind: 'project',
              projectSlug,
              cwd: `/work/${projectSlug}`,
              workspaceIsolation: { mode: 'shared' },
            },
          },
        }),
      ),
    );
  });
  await page.route('**/api/projects**', (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/api/projects') {
      return route.fulfill(json({ success: true, data: PROJECTS }));
    }
    const slug = parts[2];
    if (parts.length === 3 && slug in PROJECT_CONFIGS) {
      return route.fulfill(
        json({
          success: true,
          data: PROJECT_CONFIGS[slug as keyof typeof PROJECT_CONFIGS],
        }),
      );
    }
    if (
      parts.length === 4 &&
      parts[3] === 'layouts' &&
      slug in PROJECT_CONFIGS
    ) {
      return route.fulfill(json({ success: true, data: [] }));
    }
    return route.fulfill(json({ success: false, error: 'Not found' }, 404));
  });
  await page.route(/\/agents\/[^/]+\/conversations(?:\?.*)?$/, (route) => {
    const match = new URL(route.request().url()).pathname.match(
      /\/agents\/([^/]+)\/conversations$/,
    );
    const slug = match?.[1] ? decodeURIComponent(match[1]) : '';
    return route.fulfill(
      json({ success: true, data: CONVERSATIONS[slug] || [] }),
    );
  });
  await page.route('**/agents/*/conversations/*/messages', (route) => {
    const match = route
      .request()
      .url()
      .match(/conversations\/([^/]+)\/messages/);
    const conversationId = match?.[1] ? decodeURIComponent(match[1]) : '';
    return route.fulfill(
      json({ success: true, data: MESSAGES[conversationId] || [] }),
    );
  });
  await page.route('**/api/conversations**', (route) => {
    const url = new URL(route.request().url());
    const conversationId = url.pathname.split('/').filter(Boolean).pop();
    if (url.pathname === '/api/conversations') {
      return route.fulfill(
        json({
          success: true,
          data: { items: CONVERSATION_INVENTORY, hasMore: false },
        }),
      );
    }
    const entry = Object.entries(CONVERSATIONS).find(([, conversations]) =>
      conversations.some((conversation) => conversation.id === conversationId),
    );
    if (!entry || !conversationId) {
      return route.fulfill(json({ success: false, error: 'Not found' }, 404));
    }
    return route.fulfill(
      json({
        success: true,
        data: {
          id: conversationId,
          agentSlug: entry[0],
          projectSlug: conversationId.includes('beta') ? 'beta' : 'alpha',
          title:
            (entry[1].find((conversation) => conversation.id === conversationId)
              ?.title as string) || conversationId,
        },
      }),
    );
  });
  await page.route('**/api/git/status**', (route) =>
    route.fulfill(
      json({ success: true, data: { branch: 'main', clean: true } }),
    ),
  );
  await page.route('**/api/feedback/ratings', (route) =>
    route.fulfill(json({ success: true, data: [] })),
  );
  await page.route('**/api/branding', (route) =>
    route.fulfill(json({ success: true, data: {} })),
  );
  // LocalUiSessionGate now proves the browser session through the protected
  // identity endpoint before mounting the app tree (archive#2093).
  await page.route('**/api/system/identity', (route) =>
    route.fulfill(
      json({
        environmentId: '11111111-1111-4111-8111-111111111111',
        bootId: 'cross-runtime-test-boot',
      }),
    ),
  );
  await page.route('**/api/auth/status', (route) =>
    route.fulfill(json({ authenticated: true })),
  );
  await page.route('**/events', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: ': connected\n\n',
    }),
  );
  await page.route('**/api/events', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: 'data: {"event":"connected"}\n\n',
    }),
  );
}

async function openNewChatModal(page: Page) {
  const newChatButton = page
    .locator('.chat-dock__tab-actions .chat-dock__new')
    .nth(1);
  await expect(newChatButton).toBeVisible({ timeout: 10_000 });
  await newChatButton.dispatchEvent('click');
  await expect(page.locator('.new-chat-modal')).toBeVisible({ timeout: 5_000 });
}

function assistantRows(page: Page) {
  return page.locator('.chat-messages .message.assistant');
}

async function selectProductPath(page: Page, path: ProductPath) {
  await selectInventoryConversation(page, {
    title:
      path.agentSlug === 'claude' ? 'Claude Alpha Chat' : 'Codex Beta Chat',
    runtimeName: path.runtimeName,
    project: path.project,
  });
  const chatList = page.getByRole('complementary', { name: 'Inbox chats' });
  const projectContext = page.locator('.chat-dock__project-context');
  const activeChat = chatList.locator('button[aria-current="true"]');
  await expect(activeChat).toBeVisible();
  await expect(activeChat).toContainText(path.runtimeName);
  return { activeChat, projectContext };
}

async function selectInventoryConversation(
  page: Page,
  {
    title,
    runtimeName,
    project,
  }: { title: string; runtimeName: string; project: string },
) {
  const chatList = page.getByRole('complementary', { name: 'Inbox chats' });
  await chatList.getByRole('button', { name: 'Conversation history' }).click();
  await page
    .locator('.conversation-history .session-item__content', {
      hasText: title,
    })
    .click();
  await expect(chatList.locator('button[aria-current="true"]')).toContainText(
    runtimeName,
  );
  await expect(page.locator('.chat-dock__project-context')).toContainText(
    project,
  );
}

async function submitExactTurn({
  textarea,
  send,
  path,
  executionRequests,
}: {
  textarea: ReturnType<Page['locator']>;
  send: ReturnType<Page['getByRole']>;
  path: ProductPath;
  executionRequests: ExecutionRequest[];
}) {
  const requestsBeforeSubmit = executionRequests.length;
  await textarea.fill(path.prompt);
  await send.click();
  await expect
    .poll(() => executionRequests.slice(requestsBeforeSubmit).length)
    .toBe(1);
  const submitted = executionRequests.slice(requestsBeforeSubmit);
  assertExactExecutionRequest(submitted, path);
  return hasExactExecutionBinding(submitted, path);
}

/**
 * What a browser proves about the dispatch: the right agent, in the right
 * project, for the right conversation, exactly once.
 *
 * The `target`'s WIRE SHAPE moved down to
 * `src-ui/src/__tests__/foregroundMessageDispatch.test.ts`. Two of its fields
 * are conditional and this assertion had drifted from both: it demanded
 * `environment: { kind: 'current' }`, which `foregroundMessageDispatch.ts:40-42`
 * makes exclusive with `workspace` (a project-bound turn never sends it), and a
 * `model.override` for a turn whose own mocked receipt reports
 * `modelLaunchPlan.kind: 'engine-selected'` — a model the engine chose, which
 * `:44-51` deliberately omits. The leak guard moved with it.
 */
function assertExactExecutionRequest(
  submitted: ExecutionRequest[],
  path: ProductPath,
) {
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({
    target: {
      agent: path.agentSlug,
      workspace: { kind: 'project', projectSlug: path.projectSlug },
    },
    message: path.prompt,
    conversationId: path.conversationId,
    clientTurnId: expect.any(String),
  });
}

function hasExactExecutionBinding(
  submitted: ExecutionRequest[],
  path: ProductPath,
) {
  const [request] = submitted;
  return (
    submitted.length === 1 &&
    request?.target?.agent === path.agentSlug &&
    request.target.workspace?.kind === 'project' &&
    request.target.workspace.projectSlug === path.projectSlug &&
    request.conversationId === path.conversationId &&
    request.message === path.prompt
  );
}

async function emitExactTurn(page: Page, path: ProductPath) {
  const turnId = `turn-${path.profile}`;
  const emit = (suffix: string, method: string, extra = {}) =>
    emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        eventId: `${turnId}-${suffix}`,
        provider: path.provider,
        threadId: path.sessionId,
        turnId,
        createdAt: '2026-08-01T12:00:00.000Z',
        method,
        ...extra,
      },
    });
  await emit('started', 'turn.started', { prompt: path.prompt });
  await expect(page.locator('.streaming-message')).toBeVisible();
  await emit('delta-1', 'content.text-delta', {
    itemId: `item-${path.profile}`,
    delta: 'STATION_',
  });
  await emit('delta-2', 'content.text-delta', {
    itemId: `item-${path.profile}`,
    delta: 'SMOKE_OK',
  });
  await settleEmittedTurn(page, emit);
}

async function settleEmittedTurn(
  page: Page,
  emit: (
    suffix: string,
    method: string,
    extra?: Record<string, unknown>,
  ) => Promise<void>,
) {
  const deadline = performance.now() + SETTLEMENT_DEADLINE_MS;
  await emit('completed', 'turn.completed');
  await expectSettled(page, remainingSettlementBudget(deadline));
  expect(remainingSettlementBudget(deadline)).toBeGreaterThanOrEqual(
    SETTLEMENT_STABILITY_MS,
  );
  await expectSettledStability(page, SETTLEMENT_STABILITY_MS);
  expect(performance.now()).toBeLessThanOrEqual(deadline);
}

async function emitExtraAssistantTurn(page: Page, path: ProductPath) {
  const turnId = `turn-${path.profile}-extra`;
  const emit = (suffix: string, method: string, extra = {}) =>
    emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        eventId: `${turnId}-${suffix}`,
        provider: path.provider,
        threadId: path.sessionId,
        turnId,
        createdAt: '2026-08-01T12:00:04.000Z',
        method,
        ...extra,
      },
    });
  await emit('started', 'turn.started', { prompt: 'second reply fixture' });
  await emit('delta', 'content.text-delta', {
    itemId: `item-${path.profile}-extra`,
    delta: 'EXTRA_ASSISTANT_ROW',
  });
  await settleEmittedTurn(page, emit);
}

async function observeSubmittedAssistantTurn(
  page: Page,
  assistantRowsBefore: number,
  expectedNewRows: number,
) {
  const rows = assistantRows(page);
  await expect(rows).toHaveCount(assistantRowsBefore + expectedNewRows);
  const newRows = Array.from({ length: expectedNewRows }, (_, index) =>
    rows.nth(assistantRowsBefore + index),
  );
  const bodies = await Promise.all(
    newRows.map(async (row) => {
      const body = row.locator('p');
      await expect(body).toHaveCount(1);
      return (await body.textContent())?.trim() ?? '';
    }),
  );
  return {
    assistantMessageCount: newRows.length,
    classification:
      newRows.length === 1 && bodies[0] === SMOKE_REPLY
        ? ('exact_match' as const)
        : ('rejected' as const),
    bodies,
  };
}

async function runProductPath({
  page,
  path,
  textarea,
  send,
  executionRequests,
}: {
  page: Page;
  path: ProductPath;
  textarea: ReturnType<Page['locator']>;
  send: ReturnType<Page['getByRole']>;
  executionRequests: ExecutionRequest[];
}): Promise<UiObservation> {
  const { activeChat, projectContext } = await selectProductPath(page, path);
  const assistantRowsBefore = await assistantRows(page).count();
  const commandBinding = await submitExactTurn({
    textarea,
    send,
    path,
    executionRequests,
  });
  await emitExactTurn(page, path);
  const measurement = await observeSubmittedAssistantTurn(
    page,
    assistantRowsBefore,
    1,
  );
  expect(measurement.classification).toBe('exact_match');
  expect(commandBinding).toBe(true);
  return {
    profile: path.profile,
    surface: 'ui',
    scenario: 'exact-confirmation',
    capability: 'exact-confirmation',
    repetition: 1,
    assistantMessageCount: measurement.assistantMessageCount,
    terminal: (await page.locator('.streaming-message').count()) === 0,
    workingCleared:
      (await page.locator('.streaming-activity__label').count()) === 0,
    workingStable: true,
    commandBinding,
    identityBinding: await activeChat.isVisible(),
    projectBinding:
      (await projectContext.textContent())?.includes(path.project) === true,
    classification: measurement.classification,
  };
}

async function attachUiObservation(
  testInfo: TestInfo,
  observations: UiObservation[],
) {
  const artifact = createDailyDriverUiObservation({
    sourceRevision:
      process.env.STATION_DAILY_DRIVER_UI_SOURCE_REVISION ?? 'unverified',
    observations,
  });
  const serialized = JSON.stringify(artifact);
  await testInfo.attach('daily-driver-ui-observation', {
    body: serialized,
    contentType: 'application/json',
  });
  const outputPath = process.env.STATION_DAILY_DRIVER_UI_OBSERVATION_PATH;
  if (
    process.env.STATION_DAILY_DRIVER_UI_OBSERVATION_WRAPPER === '1' &&
    outputPath
  )
    writeFileSync(outputPath, serialized, { encoding: 'utf8', flag: 'wx' });
}

async function assertConversationHistory(
  page: Page,
  chatList: ReturnType<Page['getByRole']>,
) {
  await chatList.getByRole('button', { name: 'Conversation history' }).click();
  const history = page.locator('.conversation-history');
  await expect(history).toContainText('Claude Alpha Chat');
  await expect(history).toContainText('Codex Beta Chat');
  await history
    .locator('.session-item__content', { hasText: 'Claude Alpha Chat' })
    .click();
  await expect(page.locator('.chat-dock__project-context')).toContainText(
    'Alpha Project',
  );
  await expect(chatList.locator('button[aria-current="true"]')).toContainText(
    'Claude Runtime',
  );
  await expect(
    page
      .locator('.chat-messages .message.assistant p')
      .filter({ hasText: SMOKE_REPLY }),
  ).toHaveCount(1);
  await expectSettled(page, SETTLEMENT_DEADLINE_MS);
  await selectInventoryConversation(page, {
    title: 'Codex Beta Chat',
    runtimeName: 'Codex Runtime',
    project: 'Beta Project',
  });
}

test.describe('P1-G5 cross-runtime chat switching proof', () => {
  test('keeps long persisted Home rows inside a 412px phone viewport', async ({
    page,
  }) => {
    const browserHealth = await monitorBrowserHealth(page);
    await page.setViewportSize({ width: 412, height: 915 });
    await seedCrossRuntimeRoutes(page);

    await page.goto('/');
    await expect(
      page
        .getByRole('button', { name: 'Continue most recent work' })
        .getByText(LONG_HOME_TITLE),
    ).toBeVisible();
    const bounds = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      taskRight: document
        .querySelector('.home-view__task-copy')
        ?.getBoundingClientRect().right,
    }));
    expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.innerWidth);
    expect(bounds.bodyWidth).toBeLessThanOrEqual(bounds.innerWidth);
    expect(bounds.taskRight).toBeLessThanOrEqual(bounds.innerWidth);
    browserHealth.assertHealthy();
  });

  test('switches managed, connected, and ACP conversations while preserving project-scoped agent choices', async ({
    page,
  }) => {
    await seedCrossRuntimeRoutes(page);

    await page.goto('/projects/alpha?dock=open&chat=conv-managed-alpha');

    const chatList = page.getByRole('complementary', { name: 'Inbox chats' });
    await chatList.getByRole('button', { name: 'Earlier' }).click();
    await expect(
      chatList
        .getByRole('button', { name: /^Station Chat/ })
        .and(page.locator('[aria-current="true"]')),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('body')).toContainText(
      'Managed Alpha transcript loaded.',
    );

    await selectInventoryConversation(page, {
      title: 'Claude Alpha Chat',
      runtimeName: 'Claude Runtime',
      project: 'Alpha Project',
    });
    await expect(page.locator('body')).toContainText(
      'Claude Alpha transcript loaded.',
    );

    await selectInventoryConversation(page, {
      title: 'Codex Beta Chat',
      runtimeName: 'Codex Runtime',
      project: 'Beta Project',
    });
    await expect(page.locator('body')).toContainText(
      'Codex Beta transcript loaded.',
    );

    await selectInventoryConversation(page, {
      title: 'ACP Alpha Chat',
      runtimeName: 'kiro-cli',
      project: 'Alpha Project',
    });
    await expect(page.locator('body')).toContainText(
      'ACP Alpha transcript loaded.',
    );

    await openNewChatModal(page);
    await expect(page.locator('.new-chat-modal__context-button')).toContainText(
      'Alpha Project',
    );
    await expect(
      page.locator('.new-chat-modal__agent', { hasText: 'Station' }),
    ).toBeVisible();
    await expect(
      page.locator('.new-chat-modal__agent', { hasText: 'Claude Runtime' }),
    ).toBeVisible();
    await expect(
      page.locator('.new-chat-modal__agent', { hasText: 'kiro-cli' }),
    ).toBeVisible();
    await expect(
      page.locator('.new-chat-modal__agent', { hasText: 'Codex Runtime' }),
    ).toHaveCount(0);

    await page.locator('.new-chat-modal__context-button').click();
    await page
      .locator('.new-chat-modal__dropdown')
      .getByRole('button', { name: /Beta Project/ })
      .click();

    await expect(page.locator('.new-chat-modal__context-button')).toContainText(
      'Beta Project',
    );
    await expect(
      page.locator('.new-chat-modal__agent', { hasText: 'Codex Runtime' }),
    ).toBeVisible();
    await expect(
      page.locator('.new-chat-modal__agent', { hasText: 'Station' }),
    ).toHaveCount(0);
    await expect(
      page.locator('.new-chat-modal__agent', { hasText: 'Claude Runtime' }),
    ).toHaveCount(0);
    await expect(
      page.locator('.new-chat-modal__agent', { hasText: 'kiro-cli' }),
    ).toHaveCount(0);

    await page
      .locator('.new-chat-modal__agent', { hasText: 'Codex Runtime' })
      .click();
    await expect(chatList.locator('button[aria-current="true"]')).toContainText(
      'Codex Runtime',
    );
    await expect(page.locator('.chat-dock__project-badge')).toContainText(
      'Beta Project',
    );
  });

  test('keeps deterministic Claude and Codex browser turns exact, settled, and project-bound', async ({
    page,
  }, testInfo) => {
    const executionRequests: ExecutionRequest[] = [];
    await installMockOrchestrationSse(page);
    await seedCrossRuntimeRoutes(page, executionRequests);
    await page.goto('/projects/alpha?dock=open');
    await waitForMockOrchestrationSse(page);
    await selectInventoryConversation(page, {
      title: 'Claude Alpha Chat',
      runtimeName: 'Claude Runtime',
      project: 'Alpha Project',
    });
    const chatList = page.getByRole('complementary', { name: 'Inbox chats' });
    await chatList.getByRole('button', { name: 'Earlier' }).click();
    const textarea = page.locator('textarea[placeholder*="Type a message"]');
    const send = page.getByRole('button', { name: 'Send' });
    const observations: UiObservation[] = [];
    for (const path of PRODUCT_PATHS)
      observations.push(
        await runProductPath({
          page,
          path,
          textarea,
          send,
          executionRequests,
        }),
      );
    await assertConversationHistory(page, chatList);
    await attachUiObservation(testInfo, observations);
  });

  test('rejects a submitted turn when one exact assistant response has an extra assistant row', async ({
    page,
  }) => {
    const executionRequests: ExecutionRequest[] = [];
    const path = PRODUCT_PATHS[0];
    await installMockOrchestrationSse(page);
    await seedCrossRuntimeRoutes(page, executionRequests);
    await page.goto('/projects/alpha?dock=open');
    await waitForMockOrchestrationSse(page);
    await selectInventoryConversation(page, {
      title: 'Claude Alpha Chat',
      runtimeName: 'Claude Runtime',
      project: 'Alpha Project',
    });
    await page
      .getByRole('complementary', { name: 'Inbox chats' })
      .getByRole('button', { name: 'Earlier' })
      .click();
    await selectProductPath(page, path);
    const assistantRowsBefore = await assistantRows(page).count();
    const commandBinding = await submitExactTurn({
      textarea: page.locator('textarea[placeholder*="Type a message"]'),
      send: page.getByRole('button', { name: 'Send' }),
      path,
      executionRequests,
    });
    await emitExactTurn(page, path);
    await emitExtraAssistantTurn(page, path);
    const measurement = await observeSubmittedAssistantTurn(
      page,
      assistantRowsBefore,
      2,
    );
    expect(commandBinding).toBe(true);
    expect(measurement.bodies).toEqual([SMOKE_REPLY, 'EXTRA_ASSISTANT_ROW']);
    expect(measurement.classification).toBe('rejected');
  });

  test('keeps a degraded ACP connection out of the chat-ready list while its sibling stays selectable', async ({
    page,
  }) => {
    await seedCrossRuntimeRoutes(page);

    await page.goto('/projects/alpha?dock=open&chat=conv-managed-alpha');
    await page
      .getByRole('complementary', { name: 'Inbox chats' })
      .getByRole('button', { name: 'Earlier' })
      .click();
    await expect(
      page
        .getByRole('complementary', { name: 'Inbox chats' })
        .getByRole('button', { name: /^Station Chat/ })
        .and(page.locator('[aria-current="true"]')),
    ).toBeVisible({ timeout: 15_000 });

    await openNewChatModal(page);

    await expect(
      page.locator('.new-chat-modal__agent', { hasText: 'kiro-cli' }),
    ).toBeVisible();
    await expect(
      page.locator('.new-chat-modal__agent', { hasText: 'other-cli' }),
    ).toHaveCount(0);
  });
});

/**
 * kontourai/archive#793: the chat-dock's project badge is a real switch
 * affordance now, not a direct-navigate link. These specs are additive to
 * the P1-G5 proof above and reuse its seeding (`seedCrossRuntimeRoutes`,
 * `PROJECTS`/`PROJECT_CONFIGS`) — same Alpha/Beta fixtures, no new mocks.
 *
 * Desktop and mobile share one `ChatDockProjectSwitcherSheet` component; this
 * describe block proves both render sites in a real browser (jsdom component
 * tests cover the same wiring, but `ResponsiveDialogSurface`'s anchor
 * measurement only runs in a real layout — see the plan's stop-short risk).
 */
test.describe('chat-dock project switcher (kontourai/station#793)', () => {
  test('desktop badge opens an anchored popover; Open navigates and Switch rebinds without starting a chat', async ({
    page,
  }) => {
    await seedCrossRuntimeRoutes(page);
    await page.goto('/projects/alpha?dock=open&chat=conv-managed-alpha');

    const chatList = page.getByRole('complementary', { name: 'Inbox chats' });
    await chatList.getByRole('button', { name: 'Earlier' }).click();
    await expect(
      chatList
        .getByRole('button', { name: /^Station Chat/ })
        .and(page.locator('[aria-current="true"]')),
    ).toBeVisible({ timeout: 15_000 });

    await selectInventoryConversation(page, {
      title: 'Claude Alpha Chat',
      runtimeName: 'Claude Runtime',
      project: 'Alpha Project',
    });
    const badge = page.locator('.chat-dock__project-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('Alpha Project');
    await expect(badge).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(badge).toHaveAttribute('aria-expanded', 'false');

    await badge.click();
    await expect(badge).toHaveAttribute('aria-expanded', 'true');
    const dialog = page.getByRole('dialog', { name: 'Switch project' });
    await expect(dialog).toBeVisible();
    // Desktop renders the shared surface as an ANCHORED popover.
    await expect(
      page.locator('.responsive-surface-overlay[data-anchored]'),
    ).toBeVisible();

    await expect(
      dialog.getByRole('button', { name: 'Open Alpha Project' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Switch to Alpha Project' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Open Beta Project' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Switch to Beta Project' }),
    ).toBeVisible();

    await dialog.getByRole('button', { name: 'Open Beta Project' }).click();
    await expect(page).toHaveURL(/\/projects\/beta/);
    await expect(dialog).toBeHidden();
    // archive#3319: opening a project COLLAPSES the dock (never closes it — the
    // session survives on the collapsed bar) so the destination is visible
    // instead of landing behind the dock.
    await expect(page.locator('.chat-dock')).toHaveClass(/is-collapsed/);

    const openChatsSummary = page.getByRole('button', {
      name: /\d+ open chats?/,
    });
    const sessionsBeforeSwitch = await openChatsSummary.textContent();
    const activeChatBeforeSwitch = new URL(page.url()).searchParams.get('chat');
    expect(activeChatBeforeSwitch).toBeTruthy();
    await badge.click();
    await page
      .getByRole('dialog', { name: 'Switch project' })
      .getByRole('button', { name: 'Switch to Beta Project' })
      .click();
    await expect(badge).toContainText('Beta Project');
    await expect(page.locator('.new-chat-modal')).toHaveCount(0);
    await expect(openChatsSummary).toHaveText(sessionsBeforeSwitch ?? '');
    expect(new URL(page.url()).searchParams.get('chat')).toBe(
      activeChatBeforeSwitch,
    );
    await expect(page.locator('.chat-dock__project-context')).toContainText(
      'Beta Project',
    );
  });

  test('mobile trigger opens an un-anchored edge sheet at 390x844 with touch-safe actions', async ({
    page,
  }) => {
    await seedCrossRuntimeRoutes(page);
    await page.goto('/projects/alpha?dock=open');
    // The compact mobile dock intentionally has no desktop inbox/history
    // landmark. Establish the persisted conversation through its desktop
    // discovery surface, then verify the mobile-only project-switcher contract
    // with that real active session.
    await selectInventoryConversation(page, {
      title: 'Claude Alpha Chat',
      runtimeName: 'Claude Runtime',
      project: 'Alpha Project',
    });
    await page.setViewportSize({ width: 390, height: 844 });

    const trigger = page.getByRole('button', {
      name: 'Switch project — Alpha Project',
    });
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    // Match desktop's named project badge: the mobile trigger must expose the
    // project visually, not only through an accessible name on a folder icon.
    await expect(trigger).toContainText('Alpha Project');
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(triggerBox?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    // Distinct from the task switcher — never the buried eyebrow.
    await expect(
      page.getByRole('button', { name: 'Switch task' }),
    ).toBeVisible();

    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Switch project' });
    await expect(dialog).toBeVisible();
    // Mobile renders the shared surface as an edge sheet — no anchor.
    await expect(
      page.locator('.responsive-surface-overlay[data-anchored]'),
    ).toHaveCount(0);

    const controls = dialog.getByRole('button');
    const controlCount = await controls.count();
    expect(controlCount).toBeGreaterThan(0);
    for (let index = 0; index < controlCount; index += 1) {
      const box = await controls.nth(index).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }

    await dialog.getByRole('button', { name: 'Open Beta Project' }).click();
    await expect(page).toHaveURL(/\/projects\/beta/);
    // archive#3319: same collapse contract on the mobile edge sheet — the opened
    // project page must be visible, with the session on the collapsed bar.
    await expect(page.locator('.chat-dock')).toHaveClass(/is-collapsed/);
  });
});
