import type { Page } from '@playwright/test';
import {
  E2E_STATION_COMPATIBILITY,
  installE2EWorkspacePaneCatalog,
} from './current-station-contract';

const E2E_ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const emittedOrchestrationEvents = new WeakMap<
  Page,
  Array<Record<string, unknown>>
>();
const historicalOrchestrationEvents = new WeakMap<
  Page,
  Record<string, Record<string, unknown>[]>
>();

export const STATUS_READY = JSON.stringify({
  ready: true,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
  providers: {
    configuredChatReady: true,
    configured: [
      {
        id: 'codex-runtime',
        type: 'codex',
        enabled: true,
        capabilities: ['llm'],
      },
    ],
    detected: { ollama: false, bedrock: false },
  },
  capabilities: {
    chat: {
      ready: true,
      source: 'codex-runtime',
    },
  },
});

export const TEST_PROJECTS = [
  {
    id: 'p1',
    slug: 'dev',
    name: 'Dev',
    icon: '💻',
    description: 'Dev project',
    hasWorkingDirectory: true,
    layoutCount: 1,
    hasKnowledge: false,
  },
];

export const DEV_LAYOUTS = [
  {
    id: 'l1',
    slug: 'code',
    projectSlug: 'dev',
    type: 'coding',
    name: 'Code',
    icon: '🖥️',
  },
];

export const DEV_CONFIG = {
  id: 'p1',
  slug: 'dev',
  name: 'Dev',
  icon: '💻',
  description: 'Dev project',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

export const CODING_LAYOUT = {
  id: 'l1',
  slug: 'code',
  projectSlug: 'dev',
  type: 'coding',
  name: 'Code',
  icon: '🖥️',
  config: { workingDirectory: '/tmp/test', tabs: [], globalSkills: [] },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

export const DEFAULT_PROVIDER_SUMMARIES = [
  { provider: 'bedrock', activeSessions: 0, prerequisites: [] },
  {
    provider: 'claude',
    activeSessions: 0,
    prerequisites: [{ name: 'ANTHROPIC_API_KEY', status: 'installed' }],
  },
  {
    provider: 'codex',
    activeSessions: 0,
    prerequisites: [{ name: 'OPENAI_API_KEY', status: 'installed' }],
  },
];

export const DEFAULT_CONVERSATIONS = [
  {
    id: 'conv-1',
    title: 'Dev Agent Chat',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    messageCount: 0,
  },
];

export const DEFAULT_CONVERSATION_LOOKUPS = {
  'conv-1': {
    id: 'conv-1',
    agentSlug: 'dev-agent',
    projectSlug: 'dev',
    title: 'Dev Agent Chat',
  },
} satisfies Record<
  string,
  {
    id: string;
    agentSlug: string;
    projectSlug?: string;
    title?: string;
  }
>;

type StoredChat = {
  sessionId: string;
  conversationId: string;
  agentSlug: string;
  title?: string;
  model?: string;
  provider?: string;
  providerOptions?: Record<string, unknown>;
  projectSlug?: string;
  projectName?: string;
  currentModeId?: string;
  orchestrationSessionStarted?: boolean;
  orchestrationStatus?: string;
  orchestrationTurnOpen?: boolean;
  openTurnId?: string;
  messages?: unknown[];
  ephemeralMessages?: unknown[];
  inputHistory?: string[];
  planArtifact?: unknown;
};

export async function seedActiveChats(
  page: Page,
  chats: StoredChat[],
): Promise<void> {
  await page.addInitScript((items) => {
    sessionStorage.setItem('activeChats', JSON.stringify(items));
  }, chats);
}

export async function installMockOrchestrationSse(page: Page): Promise<void> {
  emittedOrchestrationEvents.set(page, []);
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();

    class MockSseConnection {
      static instances: MockSseConnection[] = [];
      url: string;
      private controller: ReadableStreamDefaultController<Uint8Array>;

      constructor(
        url: string,
        controller: ReadableStreamDefaultController<Uint8Array>,
      ) {
        this.url = url;
        this.controller = controller;
        MockSseConnection.instances.push(this);
      }

      close() {
        MockSseConnection.instances = MockSseConnection.instances.filter(
          (instance) => instance !== this,
        );
      }

      dispatch(type: string, payload: unknown) {
        this.controller.enqueue(
          encoder.encode(
            `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`,
          ),
        );
      }
    }

    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!url.includes('/api/orchestration/events')) {
        return realFetch(input, init);
      }

      let connection: MockSseConnection | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          connection = new MockSseConnection(url, controller);
        },
        cancel() {
          connection?.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    (window as any).__mockOrchestrationSse = {
      emit(type: string, payload: unknown) {
        for (const instance of MockSseConnection.instances) {
          instance.dispatch(type, payload);
        }
      },
      count() {
        return MockSseConnection.instances.length;
      },
      hasUrl(fragment: string) {
        return MockSseConnection.instances.some((instance) =>
          instance.url.includes(fragment),
        );
      },
    };
  });
}

export async function installMockOrchestrationEventWindow(
  page: Page,
  provider = 'codex',
  historicalEventsByThread: Record<string, Record<string, unknown>[]> = {},
): Promise<void> {
  historicalOrchestrationEvents.set(page, historicalEventsByThread);
  await page.route(
    '**/api/orchestration/sessions/*/event-window**',
    (route) => {
      const parts = new URL(route.request().url()).pathname.split('/');
      const threadId = decodeURIComponent(parts.at(-2) ?? '');
      const events = [
        ...(historicalEventsByThread[threadId] ?? []),
        ...(emittedOrchestrationEvents.get(page) ?? []).filter(
          (event) => event.threadId === threadId,
        ),
      ];
      return route.fulfill({
        json: {
          success: true,
          data: {
            protocolVersion: 1,
            session: {
              threadId,
              provider: events.at(-1)?.provider ?? provider,
              status: 'idle',
            },
            events: events.map((event, index) => ({
              sequence: index + 1,
              event: {
                eventId: `e2e-orchestration-${index + 1}`,
                ...event,
              },
            })),
            hasMore: false,
            watermark: 0,
          },
        },
      });
    },
  );
}

/**
 * Conversation-owned lineage window for deterministic multi-Session browser
 * scenarios. A known one-Session Conversation still has a real lineage window:
 * current clients may carry distinct Conversation and Session identities, so a
 * synthetic 404 cannot safely fall back to the Session route.
 */
export async function installMockOrchestrationConversationEventWindow(
  page: Page,
  readSessionIds: (conversationId: string) => string[],
): Promise<void> {
  await page.route(
    '**/api/orchestration/conversations/*/event-window**',
    (route) => {
      const parts = new URL(route.request().url()).pathname.split('/');
      const conversationId = decodeURIComponent(parts.at(-2) ?? '');
      const sessionIds = readSessionIds(conversationId);
      if (sessionIds.length === 0)
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: 'Conversation not found',
          }),
        });
      const sessionSet = new Set(sessionIds);
      const historical = historicalOrchestrationEvents.get(page) ?? {};
      const events = [
        ...sessionIds.flatMap((sessionId) => historical[sessionId] ?? []),
        ...(emittedOrchestrationEvents.get(page) ?? []).filter(
          (event) =>
            typeof event.threadId === 'string' &&
            (sessionSet.has(event.threadId) ||
              event.threadId === conversationId),
        ),
      ];
      return route.fulfill({
        json: {
          success: true,
          data: {
            protocolVersion: 1,
            conversationId,
            currentSessionId: sessionIds.at(-1),
            handoffs: [],
            events: events.map((event, index) => ({
              sequence: index + 1,
              event: {
                eventId: `e2e-orchestration-conversation-${index + 1}`,
                ...event,
              },
            })),
            hasMore: false,
            watermark: events.length,
          },
        },
      });
    },
  );
}

export async function waitForMockOrchestrationSse(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as any).__mockOrchestrationSse?.hasUrl?.(
        '/api/orchestration/events',
      ) === true,
  );
}

export async function emitMockOrchestrationEvent(
  page: Page,
  type: string,
  payload: unknown,
): Promise<void> {
  if (
    type === 'orchestration:event' &&
    typeof payload === 'object' &&
    payload !== null &&
    'event' in payload &&
    typeof payload.event === 'object' &&
    payload.event !== null
  ) {
    const events = emittedOrchestrationEvents.get(page) ?? [];
    events.push(payload.event as Record<string, unknown>);
    emittedOrchestrationEvents.set(page, events);
  }
  await page.evaluate(
    ([eventType, eventPayload]) => {
      (window as any).__mockOrchestrationSse.emit(eventType, eventPayload);
    },
    [type, payload],
  );
}

export async function dismissSetupLauncher(page: Page): Promise<void> {
  const continueButton = page.getByRole('button', {
    name: 'Continue Without Setup',
  });
  await continueButton.click({ timeout: 1000 }).catch(async () => {
    await page.evaluate(() => {
      document.querySelector('[data-testid="setup-launcher"]')?.remove();
    });
  });
  await page.getByTestId('setup-launcher').waitFor({
    state: 'detached',
    timeout: 3000,
  });
}

export async function seedOrchestrationRoutes(
  page: Page,
  options?: {
    providerSummaries?: Array<{
      provider: string;
      activeSessions: number;
      prerequisites: Array<{ name: string; status: string }>;
    }>;
    conversations?: Array<{
      id: string;
      title?: string;
      createdAt: string;
      updatedAt: string;
      messageCount?: number;
    }>;
    conversationLookups?: Record<
      string,
      {
        id: string;
        agentSlug: string;
        projectSlug?: string;
        title?: string;
      }
    >;
  },
): Promise<void> {
  await installMockOrchestrationEventWindow(page);
  await installE2EWorkspacePaneCatalog(page, {
    projectSlug: 'dev',
    projectId: DEV_CONFIG.id,
    layoutSlug: CODING_LAYOUT.slug,
  });
  await page.addInitScript(() => {
    if (localStorage.getItem('station-connect-connections-active')) return;
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
  });

  const providerSummaries =
    options?.providerSummaries ?? DEFAULT_PROVIDER_SUMMARIES;
  const conversations = options?.conversations ?? DEFAULT_CONVERSATIONS;
  const conversationLookups =
    options?.conversationLookups ?? DEFAULT_CONVERSATION_LOOKUPS;

  await Promise.all([
    page.route('**/.well-known/station/v1', (r) =>
      r.fulfill({
        json: {
          schemaVersion: 1,
          environmentId: E2E_ENVIRONMENT_ID,
          authentication: { scheme: 'bearer', protocolVersion: 1 },
          transports: { http: 1, sse: 1, websocket: 1 },
          compatibility: E2E_STATION_COMPATIBILITY,
          capabilities: { sessionEventWindow: true },
        },
      }),
    ),
    page.route('**/api/system/identity', (r) =>
      r.fulfill({
        json: {
          environmentId: E2E_ENVIRONMENT_ID,
          instanceId: 'orchestration-fixture',
          bootId: 'orchestration-fixture-boot',
          sha: '1111111111111111111111111111111111111111',
        },
      }),
    ),
    page.route('**/api/system/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: STATUS_READY,
      }),
    ),
    page.route('**/api/projects', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: TEST_PROJECTS }),
      }),
    ),
    page.route('**/api/projects/dev', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: DEV_CONFIG }),
      }),
    ),
    page.route('**/api/projects/dev/layouts', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: DEV_LAYOUTS }),
      }),
    ),
    page.route('**/api/projects/dev/layouts/code', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: CODING_LAYOUT }),
      }),
    ),
    page.route('**/api/coding/repos?**', (r) =>
      r.fulfill({
        json: {
          success: true,
          data: {
            workspace: '/tmp/test',
            workspaceIsRepo: false,
            repos: [],
          },
        },
      }),
    ),
    page.route('**/api/coding/files?**', (r) =>
      r.fulfill({ json: { success: true, data: [] } }),
    ),
    page.route('**/api/coding/git/diff?**', (r) =>
      r.fulfill({ json: { success: true, data: { diff: '' } } }),
    ),
    page.route('**/api/projects/dev/diff-comments', (r) =>
      r.fulfill({ json: { success: true, data: [] } }),
    ),
    page.route('**/api/projects/dev/flow/definitions', (r) =>
      r.fulfill({
        json: {
          success: true,
          data: { initialized: false, definitions: [] },
        },
      }),
    ),
    page.route('**/api/projects/dev/trust-bundles', (r) =>
      r.fulfill({ json: { success: true, data: [] } }),
    ),
    page.route('**/api/agents', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            {
              slug: 'dev-agent',
              name: 'Dev Agent',
              description: 'Test agent',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      }),
    ),
    page.route(/\/agents\/[^/]+\/conversations(?:\?.*)?$/, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: conversations }),
      }),
    ),
    page.route('**/agents/**/conversations/**/messages', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/conversations/*', (r) => {
      const url = new URL(r.request().url());
      const conversationId =
        url.pathname.split('/').filter(Boolean).pop() ?? '';
      const conversation = (
        conversationLookups as Record<
          string,
          {
            id: string;
            agentSlug: string;
            projectSlug?: string;
            title?: string;
          }
        >
      )[conversationId];
      return r.fulfill({
        status: conversation ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(
          conversation
            ? { success: true, data: conversation }
            : { success: false, error: 'Conversation not found' },
        ),
      });
    }),
    page.route('**/api/feedback/ratings', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/branding', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {} }),
      }),
    ),
    page.route('**/api/auth/status', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true }),
      }),
    ),
    page.route('**/api/config/app', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { defaultModel: 'claude-sonnet', region: 'us-east-1' },
        }),
      }),
    ),
    page.route('**/api/models/**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    ),
    page.route('**/api/orchestration/providers', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: providerSummaries,
        }),
      }),
    ),
    page.route('**/api/events', (r) =>
      r.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {"event":"connected"}\n\n',
      }),
    ),
  ]);
}
