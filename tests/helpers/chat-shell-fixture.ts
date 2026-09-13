import type { Page } from '@playwright/test';
import { buildLongSessionTurns } from '../fixtures/long-session';
import { agentConnectionFixture } from './connection-fixtures';
import { E2E_STATION_COMPATIBILITY } from './current-station-contract';
import { rejectUnexpectedFixtureRequest } from './fixture-audit';
import { seedActiveChats } from './orchestration';
import { mockRuntimeConversation } from './runtime-conversation-fixture';
import { fulfillStationShellRead } from './station-shell-fixtures';
import { installVisualViewportFixture } from './visual-viewport';

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});
export async function mockChatShell(
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
  await page.route('**/api/**', async (route) => {
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
                engineId: 'claude',
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
    if (
      route.request().method() === 'GET' &&
      path === '/api/projects/default/layouts'
    )
      return route.fulfill(json({ success: true, data: [] }));
    if (route.request().method() === 'GET' && path === '/api/projects/default')
      return route.fulfill(
        json({
          success: true,
          data: {
            id: 'default',
            slug: 'default',
            name: 'Default',
            hasWorkingDirectory: false,
          },
        }),
      );
    if (await fulfillStationShellRead(route)) return;
    return rejectUnexpectedFixtureRequest(route);
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
  for (const [id, reply] of [
    ['conv-running', 'Working through the current task.'],
    ['conv-review', 'Review needed before continuing.'],
    ['delegated-review', 'Delegated review is ready.'],
  ]) {
    const turns = buildLongSessionTurns({
      threadId: id,
      provider: 'codex',
      turnCount: 1,
      replyText: () => reply,
    });
    await mockRuntimeConversation(page, {
      id,
      agentSlug: 'station',
      title:
        id === 'delegated-review'
          ? 'Worker task · delegated review'
          : 'Station Chat',
      provider: 'codex',
      model: 'model-selected',
      projectSlug: 'default',
      canContinue: true,
      turns: () => turns,
    });
  }

  return () => providerCalls;
}

export async function seedMobileTaskSwitcher(page: Page, overflow = false) {
  await mockChatShell(page);
  if (overflow) {
    await page.route(/\/agents\/station\/conversations(?:\?.*)?$/, (route) =>
      route.fulfill(
        json({
          success: true,
          data: [
            'conv-running',
            'conv-review',
            ...Array.from(
              { length: 4 },
              (_, index) => `conv-overflow-${index}`,
            ),
          ].map((id) => ({
            id,
            title: id,
            agentSlug: 'station',
            updatedAt: '2026-07-19T10:05:00Z',
          })),
        }),
      ),
    );
    for (let index = 0; index < 4; index++) {
      const id = `conv-overflow-${index}`;
      const turns = buildLongSessionTurns({
        threadId: id,
        provider: 'codex',
        turnCount: 1,
        replyText: () => `Overflow conversation ${index}`,
      });
      await mockRuntimeConversation(page, {
        id,
        agentSlug: 'station',
        title: `Overflow conversation ${index}`,
        provider: 'codex',
        model: 'model-selected',
        projectSlug: 'default',
        canContinue: true,
        turns: () => turns,
      });
    }
  }
  for (const id of ['chat-running', 'chat-review'])
    await page.route(
      new RegExp(`/api/orchestration/sessions/${id}/checkpoints(?:\\?.*)?$`),
      (route) => route.fulfill(json({ success: true, data: [] })),
    );
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
    ...(overflow
      ? Array.from({ length: 4 }, (_, index) => ({
          sessionId: `chat-overflow-${index}`,
          conversationId: `conv-overflow-${index}`,
          title: `Overflow conversation ${index}`,
          agentSlug: 'station',
          projectSlug: 'default',
          projectName: 'Default',
          model: 'model-selected',
          ephemeralMessages: [
            {
              role: 'assistant' as const,
              content: `Overflow conversation ${index}`,
              timestamp: Date.parse('2026-07-19T09:00:00Z') + index,
            },
          ],
        }))
      : []),
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
