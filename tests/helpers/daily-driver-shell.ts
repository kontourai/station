import { ENGINE_CAPABILITY_MATRICES } from '@kontourai/station-contracts/engine-capability-matrix';
import { expect, type Page, type Route } from '@playwright/test';
import { E2E_STATION_COMPATIBILITY } from './current-station-contract';
import { foregroundMessageReceiptEnvelope } from './execution-receipt';
import {
  emitMockOrchestrationEvent,
  installMockOrchestrationConversationEventWindow,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
} from './orchestration';

/**
 * Shared browser shell for the daily-driver scenario and switching specs
 * (archive#3307): a deterministic engine-shaped backend behind the real UI
 * product path (composer → `POST /api/orchestration/chat` dispatch →
 * orchestration SSE → transcript). The dispatch handler accumulates
 * per-conversation history so a reply function can prove context carry-over,
 * and captured requests let a test bind emitted event metadata (for example
 * the effective model) to what the UI actually dispatched.
 */

export type ExecutionRequest = {
  route: 'start' | 'continue';
  conversationId?: string;
  message?: string;
  clientTurnId?: string;
  target?: {
    agent?: string;
    model?: { override?: string; options?: Record<string, unknown> };
  };
};

export interface ShellConversation {
  id: string;
  title: string;
  agentSlug: string;
}

export interface ShellAgentPath {
  agentSlug: string;
  provider: string;
  runtimeName: string;
  connectionId: string;
  models: Array<{ id: string; name: string }>;
  defaultModel: string;
}

export interface DailyDriverShellOptions {
  agents: ShellAgentPath[];
  conversations: ShellConversation[];
  messagesByConversation?: Record<string, Array<Record<string, unknown>>>;
  /**
   * `/api/conversations` inventory payload, recomputed per request so a test
   * can flip state (for example fork provenance) mid-run. Defaults to the
   * declared `conversations` — the app prunes any restored chat the inventory
   * does not know about, so an empty default would silently drop every
   * seeded chat and leave one app-created session behind.
   */
  inventory?: () => Array<Record<string, unknown>>;
  /**
   * Extra spec-owned endpoints. Return true when the route was handled;
   * otherwise the shared shell continues its own dispatch table.
   */
  extraRoutes?: (path: string, route: Route, url: URL) => Promise<boolean>;
  /**
   * Disable only when a scenario supplies its own conversation event-window
   * projection (the explicit handoff journey does). Ordinary multi-Session
   * scenarios use the shared lineage-aware window.
   */
  conversationLineageWindow?: boolean;
}

export interface DailyDriverShell {
  executionRequests: ExecutionRequest[];
  historyByConversation: Map<string, string[]>;
  sessionIds(conversationId: string): string[];
  markCurrentSessionTerminal(conversationId: string): Promise<void>;
  restorePersistedLineage(conversationId: string): Promise<boolean>;
  terminalPredecessorCount(conversationId: string): number;
  attemptTerminalSessionReuse(conversationId: string): Promise<boolean>;
}

function engineIdFor(provider: string): string {
  const matrix = ENGINE_CAPABILITY_MATRICES[provider];
  if (!matrix)
    throw new Error(
      `daily-driver shell has no engine capability matrix for provider '${provider}'`,
    );
  return matrix.engineId;
}

function defaultInventory(conversations: ShellConversation[]) {
  return conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    agentSlug: conversation.agentSlug,
    source: 'store',
    mutable: true,
    createdAt: '2026-07-19T10:00:00Z',
    updatedAt: '2026-07-19T10:00:00Z',
    messageCount: 0,
    answerability: { answerable: true },
  }));
}

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

export async function seedDailyDriverShell(
  page: Page,
  options: DailyDriverShellOptions,
): Promise<DailyDriverShell> {
  const executionRequests: ExecutionRequest[] = [];
  const historyByConversation = new Map<string, string[]>();
  const sessionIdsByConversation = new Map<string, string[]>();
  const terminalSessions = new Set<string>();
  const { agents, conversations } = options;

  const agentRecords = agents.map((path) => ({
    slug: path.agentSlug,
    name: path.runtimeName,
    description: `Connected ${path.runtimeName} test agent.`,
    source: 'local',
    execution: {
      agentConnectionId: path.connectionId,
      modelId: path.defaultModel,
    },
  }));
  const runtimeConnections = agents.map((path) => ({
    id: path.connectionId,
    kind: 'agent',
    type: `${path.provider}-runtime`,
    // The canonical engine identity a server `RuntimeConnectionSummary`
    // carries, read from the product's own matrix rather than transcribed:
    // without it `resolveEngineCapabilityMatrix` cannot match a
    // `<engine>-runtime` type to its engine and returns the unknown-external
    // matrix, whose `modelSelection: unsupported` disables the composer's
    // model picker — the switch journey would then be unreachable.
    engineId: engineIdFor(path.provider),
    name: path.runtimeName,
    enabled: true,
    capabilities: ['agent-runtime'],
    config: {
      executionClass: 'connected',
      defaultModel: path.defaultModel,
      // Also nested: the SDK's credential-free connection projection keeps
      // only `config.engineId`, dropping the top-level field.
      engineId: engineIdFor(path.provider),
    },
    setup: { state: 'ready', detected: true, configured: true },
    runtimeCatalog: {
      source: 'live',
      models: path.models.map((model) => ({
        id: model.id,
        name: model.name,
        originalId: model.id,
      })),
      builtInModels: [],
    },
    status: 'ready',
    prerequisites: [],
  }));

  await page.addInitScript(() => {
    localStorage.setItem('station-connect-connections-active', 'dd');
    localStorage.setItem(
      'station-connect-connections',
      JSON.stringify([{ id: 'dd', name: 'DD', url: location.origin }]),
    );
    localStorage.setItem('station:onboarding-setup-dismissed', '1');
    localStorage.removeItem('recentAgents');
    localStorage.removeItem('lastProject');
  });

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

  // Two patterns, one handler: the SDK reaches some conversation endpoints
  // through an api-prefixed base and others (fork, per-conversation messages)
  // directly off the connection origin, so a `**/api/**`-only route lets those
  // fall through to the real dev server as 401/404s.
  const handle = async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.startsWith('/api/')
      ? url.pathname
      : `/api${url.pathname}`;
    if (options.extraRoutes && (await options.extraRoutes(path, route, url)))
      return;
    if (path === '/api/system/status')
      return route.fulfill(
        json({
          ready: true,
          acp: { connected: false, connections: [] },
          providers: {
            configuredChatReady: true,
            configured: [],
            detected: { ollama: false, bedrock: false },
          },
          capabilities: {
            chat: { ready: true, source: agents[0]?.connectionId },
            runtime: { ready: true, source: agents[0]?.connectionId },
            knowledge: { ready: false, source: null },
            acp: { ready: false, source: null },
          },
          recommendation: null,
          prerequisites: [],
          clis: { codex: true, claude: true },
        }),
      );
    if (path === '/api/system/identity')
      return route.fulfill(
        json({
          environmentId: '11111111-1111-4111-8111-111111111111',
          bootId: 'daily-driver-scenario-boot',
        }),
      );
    if (path === '/api/system/capabilities')
      return route.fulfill(
        json({ voice: { stt: [], tts: [] }, context: { providers: [] } }),
      );
    if (path === '/api/auth/status')
      return route.fulfill(json({ authenticated: true }));
    if (path === '/api/attention')
      return route.fulfill(
        json({ success: true, data: { items: [], pendingCount: 0 } }),
      );
    if (path === '/api/agents')
      return route.fulfill(json({ success: true, data: agentRecords }));
    if (path === '/api/connections/agents')
      return route.fulfill(json({ success: true, data: runtimeConnections }));
    if (path === '/api/connections/models')
      return route.fulfill(json({ success: true, data: [] }));
    if (path === '/api/projects')
      return route.fulfill(json({ success: true, data: [] }));
    if (path === '/api/models/capabilities' || path === '/api/models')
      return route.fulfill(json({ success: true, data: [] }));
    if (path === '/api/config/app')
      return route.fulfill(
        json({
          success: true,
          data: { defaultModel: agents[0]?.defaultModel },
        }),
      );
    if (path === '/api/branding')
      return route.fulfill(json({ success: true, data: {} }));
    if (path === '/api/feedback/ratings')
      return route.fulfill(json({ success: true, data: [] }));
    if (path === '/api/orchestration/providers')
      return route.fulfill(
        json({
          success: true,
          data: agents.map((agentPath) => ({
            provider: agentPath.provider,
            activeSessions: 0,
            prerequisites: [],
          })),
        }),
      );
    if (path === '/api/orchestration/sessions/read-model')
      return route.fulfill(
        json({
          success: true,
          data: [...sessionIdsByConversation.entries()].flatMap(
            ([conversationId, sessionIds]) => {
              const agentSlug = conversations.find(
                (conversation) => conversation.id === conversationId,
              )?.agentSlug;
              const provider =
                agents.find((candidate) => candidate.agentSlug === agentSlug)
                  ?.provider ?? 'claude';
              return sessionIds.map((threadId) => {
                const terminal = terminalSessions.has(threadId);
                return {
                  threadId,
                  provider,
                  lifecycleState: terminal ? 'completed' : 'running',
                  status: terminal ? 'completed' : 'running',
                  controlMode: 'station-owned',
                  answerability: { answerable: !terminal },
                  isLoaded: true,
                  isPersisted: true,
                  eventCount: 1,
                  createdAt: '2026-08-18T12:00:00.000Z',
                  updatedAt: '2026-08-18T12:00:01.000Z',
                };
              });
            },
          ),
        }),
      );
    if (path === '/api/orchestration/commands')
      return route.fulfill(json({ success: true, data: { ok: true } }));
    const rawSessionTurn =
      /^\/api\/orchestration\/sessions\/([^/]+)\/send-turn$/.exec(path);
    if (rawSessionTurn) {
      const sessionId = decodeURIComponent(rawSessionTurn[1]!);
      if (terminalSessions.has(sessionId))
        return route.fulfill(
          json(
            {
              success: false,
              code: 'terminal_state',
              error: 'Execution Session is terminal',
            },
            409,
          ),
        );
      return route.fulfill(
        json({ success: false, code: 'session_not_terminal' }, 400),
      );
    }
    const continuationMatch =
      /^\/api\/orchestration\/chat\/([^/]+)\/continue$/.exec(path);
    if (path === '/api/orchestration/chat' || continuationMatch) {
      const body = route.request().postDataJSON() as Omit<
        ExecutionRequest,
        'route'
      >;
      const conversationId = continuationMatch
        ? decodeURIComponent(continuationMatch[1]!)
        : (body.conversationId ?? 'conversation:unbound');
      const existing = sessionIdsByConversation.get(conversationId) ?? [];
      const predecessor = existing.at(-1);
      if (predecessor && !terminalSessions.has(predecessor))
        return route.fulfill(
          json(
            { success: false, error: 'Current Session is not terminal' },
            409,
          ),
        );
      // Both canonical HTTP spellings reach the same durable Conversation
      // resolver in product wiring. The semantic route is continuation when
      // the request carries an existing conversationId; URL spelling is not
      // the capability (archive#3912 review).
      const routeKind = predecessor ? 'continue' : 'start';
      const sessionId = predecessor
        ? `${conversationId}:session:${existing.length}`
        : conversationId;
      const sessions = [...existing, sessionId];
      sessionIdsByConversation.set(conversationId, sessions);
      const request: ExecutionRequest = {
        ...body,
        route: routeKind,
        conversationId,
      };
      executionRequests.push(request);
      if (typeof request.message === 'string') {
        const history = historyByConversation.get(conversationId) ?? [];
        history.push(request.message);
        historyByConversation.set(conversationId, history);
      }
      const agent = request.target?.agent ?? agents[0]?.agentSlug ?? 'claude';
      return route.fulfill(
        json(
          foregroundMessageReceiptEnvelope({
            conversationId,
            sessionId,
            agent,
          }),
        ),
      );
    }
    const conversationOpenMatch =
      /^\/api\/conversations\/([^/]+)\/open$/.exec(path);
    if (conversationOpenMatch) {
      // A restored/resumed chat mounts `ConversationOpenRevalidator`
      // (`conversationOpenPending` from `hydrateActiveChats`), and the
      // conversation-history picker's row-select goes through
      // `openConversationForDock` — both authoritatively re-resolve a
      // conversation through this exact seam before trusting it as writable.
      // Leaving it unmocked doesn't skip that check; it fails it, which
      // reads as a real "could not prove a writable continuation" recovery
      // state instead of the transcript the test expects.
      const conversationId = decodeURIComponent(conversationOpenMatch[1]!);
      const conversation = conversations.find(
        (entry) => entry.id === conversationId,
      );
      if (!conversation)
        return route.fulfill(
          json({ success: false, error: 'Conversation not found' }, 404),
        );
      // A conversation the dispatch table never saw yet (for example a
      // fixture seeded straight through its own `event-window` route, as the
      // 10k-transcript scenarios do) is still its OWN first session — the
      // same invariant the dispatch handler above uses when assigning a
      // fresh conversationId as `sessionId` for the very first turn.
      const currentSessionId =
        sessionIdsByConversation.get(conversationId)?.at(-1) ?? conversationId;
      return route.fulfill(
        json({
          success: true,
          data: {
            status: 'resolved',
            conversation: {
              id: conversation.id,
              title: conversation.title,
              agentSlug: conversation.agentSlug,
            },
            currentSessionId,
            transcript: {
              available: true,
              owner: 'runtime',
              messageCount: historyByConversation.get(conversationId)
                ?.length ?? 0,
            },
            canContinue: !terminalSessions.has(currentSessionId),
            answerability: { answerable: true },
            recoveryActions: [],
          },
        }),
      );
    }
    if (/^\/api\/conversations\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.split('/').at(-1) ?? '');
      const conversation = conversations.find((entry) => entry.id === id);
      return route.fulfill(
        conversation
          ? json({ success: true, data: conversation })
          : json({ success: false, error: 'Not found' }, 404),
      );
    }
    if (path === '/api/conversations')
      return route.fulfill(
        json({
          success: true,
          data: {
            items: options.inventory?.() ?? defaultInventory(conversations),
            hasMore: false,
          },
        }),
      );
    if (/\/agents\/[^/]+\/conversations\/[^/]+\/messages$/.test(path)) {
      const id = decodeURIComponent(path.split('/').at(-2) ?? '');
      return route.fulfill(
        json({
          success: true,
          data: options.messagesByConversation?.[id] ?? [],
        }),
      );
    }
    if (/\/agents\/[^/]+\/conversations$/.test(path)) {
      const slug = decodeURIComponent(
        /\/agents\/([^/]+)\/conversations$/.exec(path)?.[1] ?? '',
      );
      return route.fulfill(
        json({
          success: true,
          data: conversations
            .filter((entry) => entry.agentSlug === slug)
            .map((entry) => ({
              id: entry.id,
              title: entry.title,
              agentSlug: entry.agentSlug,
              updatedAt: '2026-07-19T10:00:00Z',
            })),
        }),
      );
    }
    if (path === '/api/events')
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {"event":"connected"}\n\n',
      });
    return route.fulfill(
      json({ success: false, error: `Unmocked ${path}` }, 404),
    );
  };
  await page.route('**/api/**', handle);
  await page.route('**/agents/**', handle);
  await page.route('**/conversations/**', handle);

  await installMockOrchestrationSse(page);
  await installMockOrchestrationEventWindow(page);
  if (options.conversationLineageWindow !== false)
    await installMockOrchestrationConversationEventWindow(
      page,
      (conversationId) => [
        ...(sessionIdsByConversation.get(conversationId) ?? []),
      ],
    );
  return {
    executionRequests,
    historyByConversation,
    sessionIds: (conversationId) => [
      ...(sessionIdsByConversation.get(conversationId) ?? []),
    ],
    async markCurrentSessionTerminal(conversationId) {
      const sessionId = sessionIdsByConversation.get(conversationId)?.at(-1);
      if (!sessionId)
        throw new Error(`no daily-driver Session for '${conversationId}'`);
      terminalSessions.add(sessionId);
      await page.evaluate(
        ({ key, value }) => localStorage.setItem(key, value),
        {
          key: `station-dd-lineage:${conversationId}`,
          value: JSON.stringify({
            sessionIds: sessionIdsByConversation.get(conversationId),
            terminalSessionIds: [
              ...(sessionIdsByConversation.get(conversationId) ?? []),
            ].filter((id) => terminalSessions.has(id)),
          }),
        },
      );
    },
    async restorePersistedLineage(conversationId) {
      // A process reload loses both maps. Only the browser-owned durable
      // snapshot may rebuild them; without it this returns false rather than
      // re-reading the same in-memory object and calling that persistence.
      for (const id of sessionIdsByConversation.get(conversationId) ?? [])
        terminalSessions.delete(id);
      sessionIdsByConversation.delete(conversationId);
      const snapshot = await page.evaluate(
        (key) => localStorage.getItem(key),
        `station-dd-lineage:${conversationId}`,
      );
      if (!snapshot) return false;
      const parsed = JSON.parse(snapshot) as {
        sessionIds?: unknown;
        terminalSessionIds?: unknown;
      };
      if (
        !Array.isArray(parsed.sessionIds) ||
        parsed.sessionIds.some((id) => typeof id !== 'string') ||
        !Array.isArray(parsed.terminalSessionIds) ||
        parsed.terminalSessionIds.some((id) => typeof id !== 'string')
      )
        return false;
      sessionIdsByConversation.set(
        conversationId,
        parsed.sessionIds as string[],
      );
      for (const id of parsed.terminalSessionIds as string[])
        terminalSessions.add(id);
      return true;
    },
    terminalPredecessorCount: (conversationId) =>
      (sessionIdsByConversation.get(conversationId) ?? [])
        .slice(0, -1)
        .filter((sessionId) => terminalSessions.has(sessionId)).length,
    async attemptTerminalSessionReuse(conversationId) {
      const terminalSession = sessionIdsByConversation
        .get(conversationId)
        ?.at(-1);
      // This bypasses Conversation resolution deliberately: raw sendTurn on
      // the terminal execution Session must be refused, while another turn
      // addressed to the Conversation creates a child above.
      if (!terminalSession) return false;
      const requestsBefore = executionRequests.length;
      const sessionsBefore = JSON.stringify(
        sessionIdsByConversation.get(conversationId),
      );
      const historyBefore = JSON.stringify(
        historyByConversation.get(conversationId),
      );
      const result = await page.evaluate(async (sessionId) => {
        const response = await fetch(
          `/api/orchestration/sessions/${encodeURIComponent(sessionId)}/send-turn`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ input: 'raw terminal reuse probe' }),
          },
        );
        return { status: response.status, body: await response.json() };
      }, terminalSession);
      return (
        result.status === 409 &&
        result.body?.code === 'terminal_state' &&
        executionRequests.length === requestsBefore &&
        JSON.stringify(sessionIdsByConversation.get(conversationId)) ===
          sessionsBefore &&
        JSON.stringify(historyByConversation.get(conversationId)) ===
          historyBefore
      );
    },
  };
}

export async function seedDailyDriverChats(
  page: Page,
  chats: Array<{
    conversationId: string;
    agentSlug: string;
    title: string;
    model?: string;
    provider?: string;
  }>,
) {
  await page.addInitScript((items) => {
    sessionStorage.setItem(
      'activeChats',
      JSON.stringify(
        items.map((item) => ({
          sessionId: item.conversationId,
          conversationId: item.conversationId,
          agentSlug: item.agentSlug,
          title: item.title,
          executionMode: 'external',
          provider: item.provider ?? item.agentSlug,
          ...(item.model ? { model: item.model } : {}),
          providerOptions: {},
          orchestrationSessionStarted: true,
          ephemeralMessages: [],
          inputHistory: [],
        })),
      ),
    );
  }, chats);
}

export function transcriptLocator(page: Page) {
  return page.locator('.chat-messages');
}

export async function expectSettled(page: Page, timeout = 1_000) {
  await expect(page.locator('.streaming-message')).toHaveCount(0, { timeout });
  await expect(
    page.locator('.streaming-activity__label', { hasText: /^Working/ }),
  ).toHaveCount(0, { timeout });
}

/**
 * The same two surfaces `expectSettled` asserts on, READ rather than asserted,
 * so an observation can record whether the turn settled instead of stamping a
 * literal beside an assertion that ran earlier.
 */
export async function readSettled(page: Page): Promise<boolean> {
  const streaming = await page.locator('.streaming-message').count();
  const working = await page
    .locator('.streaming-activity__label', { hasText: /^Working/ })
    .count();
  return streaming === 0 && working === 0;
}

/**
 * Mounted message rows, counted through the transcript's own per-row anchor
 * (`chatScrollAnchor.ts`'s `MESSAGE_SELECTOR`). Deliberately not
 * `[data-transcript-row]`: that wrapper exists only on the virtualized path,
 * so a transcript below the virtualization threshold would report zero
 * mounted rows while rendering every one of them.
 */
export async function mountedTranscriptRows(page: Page): Promise<number> {
  return transcriptLocator(page).evaluate(
    (element) => element.querySelectorAll('[data-chat-message-key]').length,
  );
}

/**
 * How many rows the transcript model holds, whether or not they are mounted.
 * Only the virtualizer publishes it, so a non-virtualized transcript reports
 * its mounted count — which is then also its loaded count.
 */
export async function loadedTranscriptRows(page: Page): Promise<number> {
  return transcriptLocator(page).evaluate((element) => {
    const spacer = element.querySelector('[data-transcript-row-count]');
    const declared = spacer?.getAttribute('data-transcript-row-count');
    return declared
      ? Number.parseInt(declared, 10)
      : element.querySelectorAll('[data-chat-message-key]').length;
  });
}

let emittedEventCounter = 0;

export function nextEmittedEventId(): string {
  emittedEventCounter += 1;
  return `dd-event-${emittedEventCounter}`;
}

export function emittedEventTimestamp(): string {
  return new Date(
    Date.parse('2026-08-18T12:00:00Z') + emittedEventCounter,
  ).toISOString();
}

export async function emitTurnEvent(
  page: Page,
  {
    threadId,
    turnId,
    provider,
    method,
    extra = {},
  }: {
    threadId: string;
    turnId: string;
    provider: string;
    method: string;
    extra?: Record<string, unknown>;
  },
) {
  const eventId = nextEmittedEventId();
  await emitMockOrchestrationEvent(page, 'orchestration:event', {
    event: {
      eventId,
      provider,
      threadId,
      turnId,
      createdAt: emittedEventTimestamp(),
      method,
      ...extra,
    },
  });
}

export async function completeDispatchedTurn(
  page: Page,
  {
    threadId,
    turnId,
    provider,
    userText,
    reply,
    metadata,
  }: {
    threadId: string;
    turnId: string;
    provider: string;
    userText: string;
    reply: string;
    /** Stamped on turn.started and turn.completed, the way adapters report
     * per-turn facts (for example effectiveModel/reportedModel) that the
     * shared provenance fold assembles into the turn's envelope. */
    metadata?: Record<string, unknown>;
  },
) {
  const metadataExtra = metadata ? { metadata } : {};
  await emitTurnEvent(page, {
    threadId,
    turnId,
    provider,
    method: 'turn.started',
    extra: { prompt: userText, ...metadataExtra },
  });
  await emitTurnEvent(page, {
    threadId,
    turnId,
    provider,
    method: 'content.text-delta',
    extra: { itemId: turnId, delta: reply },
  });
  await emitTurnEvent(page, {
    threadId,
    turnId,
    provider,
    method: 'turn.completed',
    extra: { outputText: reply, ...metadataExtra },
  });
}
