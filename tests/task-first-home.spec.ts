import { devices, expect, type Page, test } from '@playwright/test';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import {
  E2E_STATION_CAPABILITIES,
  E2E_STATION_COMPATIBILITY,
} from './helpers/current-station-contract';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';
import { installVisualViewportFixture } from './helpers/visual-viewport';

const project = {
  id: 'p1',
  slug: 'station',
  name: 'Station',
  hasWorkingDirectory: true,
  workingDirectory: '/workspace/station',
  layoutCount: 1,
  hasKnowledge: false,
  agents: ['codex-agent'],
  createdAt: '2026-07-12T00:00:00Z',
  updatedAt: '2026-07-13T00:00:00Z',
};

/** The app config both config routes answer with — one object, one truth. */
const APP_CONFIG = {
  builtinAgentEngineConnectionId: null,
  firstRun: { status: 'skipped' },
};

function json(data: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  };
}

async function mockTaskFirstHome(
  page: Page,
  options: {
    sessionEvents?: Array<Record<string, unknown>>;
    commands?: Array<Record<string, unknown>>;
    workflowTasks?: Array<Record<string, unknown>>;
  } = {},
) {
  const taskSession = {
    threadId: 'task-first-home',
    provider: 'codex',
    model: 'gpt-5.3-codex',
    projectSlug: 'station',
    assignedAgentSlug: 'codex-agent',
    status: 'ready',
    lifecycleState: 'ready',
    createdAt: '2026-07-12T00:00:00Z',
    updatedAt: '2026-07-13T00:00:00Z',
    isLoaded: true,
    isPersisted: true,
    eventCount: options.sessionEvents?.length ?? 8,
    delegation: {
      taskId: 'task:task-first-home',
      environmentId: 'environment-current',
      environmentName: 'Current environment',
      connectionId: 'codex',
      targetKind: 'agent-app',
      targetId: 'codex',
      projectSlug: 'station',
      mode: 'isolated-child',
    },
  };
  await installVisualViewportFixture(page);
  await page.addInitScript(() => {
    localStorage.setItem('recentAgents', JSON.stringify(['codex-agent']));
    localStorage.setItem('station:onboarding-setup-dismissed', '1');
  });
  await page.route('**/events', (route) => route.abort());
  await page.route(
    '**/agents/codex-agent/conversations/task-first-home/messages',
    (route) => route.fulfill(json([])),
  );
  await page.route('**/.well-known/station/v1', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        environmentId: '11111111-1111-4111-8111-111111111111',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
        transports: { http: 1, sse: 1, websocket: 1 },
        compatibility: E2E_STATION_COMPATIBILITY,
        capabilities: E2E_STATION_CAPABILITIES,
      }),
    }),
  );
  /*
   * archive#3783: `firstRun.status` decides whether Home renders the first-run
   * setup CARD (`resolveFirstRunOffer`: 'pending'|'skipped' → offered).
   * Without the key the chapter returns null, so the card's
   * `.editor-btn--primary "Set up Station"` — 121x34 on a live instance at
   * 390x844 — was never in the DOM this fixture's geometry assertion scans.
   *
   * 'skipped', not 'pending': 'pending' also sets `autoOpen`, which would pop
   * the chapter DIALOG over the surface the rest of this test measures. The
   * launcher suppression above is orthogonal — it feeds `launcherWouldShow`,
   * which gates auto-open, not the card.
   *
   * Routed by its OWN pattern rather than only inside the `/api/` handler:
   * `useConfigQuery` requests `${apiBase}/config/app`, and when
   * `apiBase` is same-origin that path never enters the `/api/` handler at
   * all — which is why the existing branch there had no observable effect.
   * A glob ending in `config/app` matches both spellings (written without the
   * leading wildcards here because they would close this comment), and
   * Playwright prefers the last-registered route.
   */
  await page.route('**/config/app', (route) => route.fulfill(json(APP_CONFIG)));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    // `PluginRegistry.ts:207-212` destructures `{ plugins }` off the RAW body
    // and iterates it; the `{success,data}` envelope this handler falls back to
    // makes it throw, degrade, and present the non-dismissible "Extensions
    // unavailable" chrome banner — which then sits over the header menus at
    // `--layer-notice` (9000) and swallowed the Help menu's first item.
    if (path === '/api/plugins') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ plugins: [] }),
      });
      return;
    }
    if (path === '/api/system/identity') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ bootId: 'task-first-home-fixture' }),
      });
      return;
    }
    if (path === '/api/system/status') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: true,
          acp: { connected: false, connections: [] },
          clis: {},
          prerequisites: [],
          providers: {
            configuredChatReady: true,
            configured: [],
            detected: {},
          },
          capabilities: { chat: { ready: true, source: 'codex' } },
        }),
      });
      return;
    }
    if (path === '/api/config/app') {
      await route.fulfill(json(APP_CONFIG));
      return;
    }
    if (path === '/api/projects') {
      await route.fulfill(json([project]));
      return;
    }
    if (path === '/api/projects/station') {
      await route.fulfill(json(project));
      return;
    }
    if (path === '/api/projects/station/layouts') {
      await route.fulfill(
        json([{ id: 'l1', slug: 'coding', name: 'Coding', type: 'coding' }]),
      );
      return;
    }
    if (path === '/api/projects/station/workflow/tasks') {
      await route.fulfill(json(options.workflowTasks ?? []));
      return;
    }
    if (path === '/api/orchestration/sessions/read-model') {
      await route.fulfill(json([taskSession]));
      return;
    }
    if (path === '/api/orchestration/sessions/task-first-home') {
      await route.fulfill(
        json({ session: taskSession, events: options.sessionEvents ?? [] }),
      );
      return;
    }
    if (path === '/api/orchestration/sessions/task-first-home/event-window') {
      await route.fulfill(
        json({
          protocolVersion: 1,
          session: taskSession,
          events: (options.sessionEvents ?? []).map((event, index) => ({
            sequence: index + 1,
            event,
          })),
          hasMore: false,
          watermark: options.sessionEvents?.length ?? 0,
        }),
      );
      return;
    }
    if (path === '/api/orchestration/sessions/task-first-home/flow-run') {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: 'No Flow run bound to session',
        }),
      });
      return;
    }
    if (path === '/api/orchestration/delegations/options') {
      await route.fulfill(
        json({
          environment: {
            id: 'environment-current',
            name: 'Current environment',
            kind: 'current',
          },
          project: { slug: 'station' },
          targets: [
            {
              id: 'codex',
              kind: 'agent-app',
              name: 'Codex',
              ready: true,
              defaultModel: 'gpt-5.3-codex',
              models: [],
              capabilities: {
                resume: true,
                interrupt: true,
                approvals: true,
                modelSelection: true,
              },
            },
          ],
        }),
      );
      return;
    }
    if (
      path === '/api/orchestration/commands' &&
      route.request().method() === 'POST'
    ) {
      options.commands?.push(
        route.request().postDataJSON() as Record<string, unknown>,
      );
      await route.fulfill(json({ dispatched: true }));
      return;
    }
    if (
      path === '/api/orchestration/chat' &&
      route.request().method() === 'POST'
    ) {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      options.commands?.push({ type: 'sendExecutionMessage', input });
      await route.fulfill(
        json(
          foregroundMessageReceiptEnvelope({
            conversationId: 'task-first-home',
            agent:
              typeof (input.target as { agent?: unknown } | undefined)
                ?.agent === 'string'
                ? (input.target as { agent: string }).agent
                : 'codex-agent',
          }),
        ),
      );
      return;
    }
    const continueMatch = path.match(
      /^\/api\/orchestration\/chat\/([^/]+)\/continue$/,
    );
    if (continueMatch && route.request().method() === 'POST') {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      options.commands?.push({
        type: 'continueExecutionMessage',
        threadId: decodeURIComponent(continueMatch[1]),
        input,
      });
      await route.fulfill(
        json(
          foregroundMessageReceiptEnvelope({
            conversationId: decodeURIComponent(continueMatch[1]),
            agent: 'codex-agent',
          }),
        ),
      );
      return;
    }
    if (path === '/api/agents') {
      await route.fulfill(
        json([
          {
            slug: 'codex-agent',
            name: 'Codex',
            model: 'gpt-5.3-codex',
            execution: { agentConnectionId: 'codex' },
          },
        ]),
      );
      return;
    }
    if (path === '/api/connections/agents') {
      await route.fulfill(
        json([
          agentConnectionFixture({
            id: 'codex',
            kind: 'agent',
            type: 'codex',
            name: 'Codex Runtime',
            enabled: true,
            capabilities: ['agent-runtime', 'file-input'],
            config: { executionClass: 'external' },
            status: 'ready',
            runtimeCatalog: {
              source: 'live',
              models: [
                {
                  id: 'gpt-5.3-codex',
                  name: 'gpt-5.3-codex',
                  originalId: 'gpt-5.3-codex',
                },
              ],
              builtInModels: [],
            },
            prerequisites: [],
          }),
        ]),
      );
      return;
    }
    if (path === '/api/models') {
      await route.fulfill(
        json([
          {
            modelId: 'gpt-5.3-codex',
            modelName: 'GPT-5.3 Codex',
            outputModalities: ['TEXT'],
          },
        ]),
      );
      return;
    }
    await route.fulfill(json([]));
  });
  await page.route('**/api/coding/git/status**', (route) => {
    expect(new URL(route.request().url()).searchParams.get('path')).toBe(
      project.workingDirectory,
    );
    return route.fulfill(
      json({
        isRepo: true,
        repoRoot: project.workingDirectory,
        branch: 'feat/contextual-active-work',
        changes: [' M src-ui/src/App.tsx'],
        staged: 0,
        unstaged: 1,
        untracked: 0,
        lastCommit: null,
        ahead: 0,
        behind: 0,
      }),
    );
  });
}

async function startProjectTask(page: Page) {
  await page.getByRole('button', { name: /Start direct chat/i }).click();
  const dialog = page.getByRole('dialog', { name: 'New Chat' });
  await dialog.getByRole('button', { name: 'Workspace: No workspace' }).click();
  await dialog.locator('[data-context-value="station"]').click();
  await expect(
    dialog.getByRole('button', { name: 'Workspace: Station' }),
  ).toBeVisible();
  await page.locator('.new-chat-modal__agent--selected').click();
  // Desktop keeps the standalone project-context row; a phone folds the project
  // into the one-row header's eyebrow above the chat title.
  const projectContext = page.locator('.chat-dock__project-context');
  const mobileEyebrow = page.locator('.chat-dock__mobile-eyebrow');
  await expect(projectContext.or(mobileEyebrow).first()).toBeVisible();
}

async function selectNoWorkspace(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'New Chat' });
  await expect(
    dialog.getByRole('button', { name: 'Workspace: No workspace' }),
  ).toBeVisible();
}

async function mockStationModelProviders(page: Page) {
  await page.route('**/api/agents', (route) =>
    route.fulfill(
      json([
        {
          slug: 'codex-agent',
          name: 'Station Agent',
          model: 'shared-model',
          execution: {
            agentConnectionId: 'station-runtime',
            runtimeOptions: {
              executionMode: 'station',
              providerId: 'codex-work',
              providerKind: 'codex',
              displayModel: 'shared-model',
            },
          },
        },
      ]),
    ),
  );
  await page.route('**/api/connections/agents', (route) =>
    route.fulfill(
      json([
        agentConnectionFixture({
          id: 'station-runtime',
          kind: 'agent',
          type: 'station',
          name: 'Station',
          enabled: true,
          capabilities: ['agent-runtime'],
          config: { engineId: 'station' },
          status: 'ready',
          prerequisites: [],
        }),
      ]),
    ),
  );
  await page.route('**/api/connections/models', (route) =>
    route.fulfill(
      json([
        {
          id: 'codex-work',
          kind: 'model',
          type: 'codex',
          name: 'Codex · Work',
          enabled: true,
          capabilities: ['llm'],
          config: {
            defaultModel: 'shared-model',
            modelOptions: [
              {
                id: 'shared-model',
                name: 'Shared model',
                capabilities: {
                  supportsEffort: true,
                  supportedEffortLevels: ['low', 'high'],
                },
              },
            ],
          },
          status: 'ready',
          prerequisites: [],
        },
        {
          id: 'bedrock-prod',
          kind: 'model',
          type: 'bedrock',
          name: 'Bedrock · Prod',
          enabled: true,
          capabilities: ['llm'],
          config: {
            defaultModel: 'shared-model',
            modelOptions: [
              { id: 'shared-model', name: 'Shared model' },
              { id: 'sonnet', name: 'Claude Sonnet' },
            ],
          },
          status: 'ready',
          prerequisites: [],
        },
        {
          id: 'litellm-local',
          kind: 'model',
          type: 'openai-compat',
          name: 'LiteLLM · Local',
          enabled: false,
          capabilities: ['llm'],
          config: {},
          status: 'missing_prerequisites',
          prerequisites: [],
        },
      ]),
    ),
  );
}

test.describe('Task-first Home (#332, mocked)', () => {
  test('keeps sidebar, project-chat, help launch, and explicit maximize transitions connected', async ({
    page,
  }) => {
    const commands: Array<Record<string, unknown>> = [];
    await mockTaskFirstHome(page, { commands });
    await page.goto('/');
    // No chrome banner belongs in this fixture: `BannerHost` renders nothing
    // when its stack is empty, so a regressed fixture (or an unrouted endpoint
    // reaching the live host) fails HERE rather than silently covering a header
    // menu forty lines later.
    await expect(page.getByTestId('banner-host')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Dismiss engine picker' }),
    ).toHaveCount(0);

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.locator('.sidebar')).toHaveClass(/sidebar--collapsed/);
    await expect(
      page.getByRole('button', { name: 'Expand sidebar' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Open chats' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Expand sidebar' }).click();

    // archive#1629 removed the sidebar's "Project chats" pill (and its
    // `station:open-project-chats` dispatch) — ChatDock's listener for that
    // event stays wired for other future callers, but nothing in the UI
    // dispatches it anymore. Reroute through the still-existing "Start
    // direct chat" home action, which reaches the same New Chat dialog in its
    // intentionally task-free "No workspace" state, then drive
    // the dock's own Maximize control explicitly — proving the maximize
    // transition through its real affordance instead of as a residual side
    // effect of the removed dispatch. Every downstream assertion below is
    // unchanged; only the entry step and the order of the first maximize
    // assertion (now after an explicit click, not implicit) moved.
    await page.getByRole('button', { name: /Start direct chat/i }).click();
    const newChat = page.getByRole('dialog', { name: 'New Chat' });
    await expect(newChat).toBeVisible();
    await expect(
      newChat.getByRole('button', { name: 'Workspace: No workspace' }),
    ).toBeVisible();
    await newChat.press('Escape');

    await page.getByRole('button', { name: 'Maximize chat dock' }).click();
    await expect(page.locator('.chat-dock')).toHaveClass(/is-maximized/);
    expect(new URL(page.url()).searchParams.get('maximize')).toBe('true');
    await page.getByRole('button', { name: 'Restore chat dock' }).click();
    await expect(page.locator('.chat-dock')).not.toHaveClass(/is-maximized/);
    await page.getByRole('button', { name: 'Maximize chat dock' }).click();
    await expect(page.locator('.chat-dock')).toHaveClass(/is-maximized/);
    await page.getByRole('button', { name: 'Restore chat dock' }).click();

    await page.goto('/projects/station');
    await page.getByRole('button', { name: 'Ask Station for help' }).click();
    await page.getByRole('button', { name: 'What can you do?' }).click();

    await expect
      .poll(() => commands.map((command) => command.type))
      .toEqual(['sendExecutionMessage']);
    await expect(page.locator('.chat-messages .message.user')).toContainText(
      'What can you help me with? List your capabilities.',
    );
    expect(new URL(page.url()).searchParams.get('dock')).toBe('open');
    expect(new URL(page.url()).searchParams.get('chat')).toBeTruthy();
  });

  test('switches an exact provider/model from the composer and restores focus', async ({
    page,
  }) => {
    await mockTaskFirstHome(page);
    await mockStationModelProviders(page);
    await page.goto('/');
    await startProjectTask(page);

    const modelButton = page.getByRole('button', {
      name: /Model: Codex · Work — Shared model/,
    });
    await modelButton.click();
    const picker = page.getByRole('dialog', { name: 'Choose model' });
    await expect(picker).toBeVisible();
    await expect(
      picker.getByRole('button', { name: 'LiteLLM · Local' }),
    ).toBeDisabled();
    await picker.getByRole('button', { name: 'Bedrock · Prod' }).click();
    await picker
      .getByRole('option', {
        name: /Bedrock · Prod · shared-model/,
      })
      .click();

    await expect(
      page.getByRole('button', {
        name: /Model: Bedrock · Prod — Shared model/,
      }),
    ).toBeFocused();
    await page
      .getByRole('button', { name: /Model: Bedrock · Prod — Shared model/ })
      .click();
    await page
      .getByRole('dialog', { name: 'Choose model' })
      .getByRole('button', { name: 'Use agent default' })
      .click();
    await expect(
      page.getByRole('button', {
        name: /Model: Codex · Work — Shared model/,
      }),
    ).toBeVisible();
  });

  test('desktop prioritizes continuation, guided actions, concrete identity, and customization deep links', async ({
    page,
  }) => {
    await mockTaskFirstHome(page);
    await page.goto('/');

    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole('heading', { name: 'What do you want to work on?' }),
    ).toBeVisible();
    const continuation = page.getByRole('button', {
      name: /Continue most recent work/i,
    });
    await expect(continuation).toContainText('Codex · gpt-5.3-codex');
    await expect(
      page.getByRole('button', { name: /Start direct chat/i }),
    ).toContainText('Codex · gpt-5.3-codex');
    await expect(
      page.getByRole('button', { name: /Open local project/i }),
    ).toBeVisible();
    await expect(page.getByText('Default Model')).toHaveCount(0);

    await continuation.click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('chat'))
      .toBe('task-first-home');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('dock'))
      .toBe('open');
    await expect(
      page.locator('.chat-dock__active-identity').getByText('New chat'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Collapse chat dock' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close chat' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('chat'))
      .toBeNull();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('dock'))
      .toBe('open');
    await expect(page.getByText('No active session')).toBeVisible();

    const advertisedIdentity = await page
      .getByRole('button', { name: /Start direct chat/i })
      .locator('small')
      .textContent();
    await page.getByRole('button', { name: /Start direct chat/i }).click();
    const selectedAgent = page.locator('.new-chat-modal__agent--selected');
    await expect(selectedAgent).toContainText('Codex');
    await expect(selectedAgent).not.toContainText('gpt-5.3-codex');
    expect(advertisedIdentity).toBe('Codex · gpt-5.3-codex');
    await page.getByRole('dialog', { name: 'New Chat' }).press('Escape');

    await page.getByRole('button', { name: /Open local project/i }).click();
    await expect(
      page.getByRole('heading', { name: 'New Project' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('chat'))
      .toBeNull();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('dock'))
      .toBe('open');

    // station#settings-revamp slice 5: the dead `/providers` alias is
    // removed — use the canonical connections/models deep link instead.
    await page.goto('/connections/providers');
    await expect(
      page.getByRole('button', { name: 'Customize' }),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(
      page.getByRole('button', { name: 'Connections', exact: true }),
    ).toHaveClass(/sidebar__nav-btn--active/);
    await page.goto('/');
    await page.getByRole('button', { name: 'Customize' }).click();
    await page
      .getByRole('button', { name: 'Connections', exact: true })
      .click();
    await expect(page).toHaveURL(/\/connections$/);
  });

  test('keeps direct chat task-free until a project task is active', async ({
    page,
  }) => {
    await mockTaskFirstHome(page);
    await page.goto('/');

    await expect(page.getByRole('button', { name: /^Files/ })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Open command launcher' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Task context' }),
    ).toHaveCount(0);

    await page.getByRole('button', { name: /Start direct chat/i }).click();
    await selectNoWorkspace(page);
    await page.locator('.new-chat-modal__agent--selected').click();
    await expect(page.locator('.chat-dock')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Files/ })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Open command launcher' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Task context' }),
    ).toHaveCount(0);
    await expect(page.getByText('task:task-first-home')).toHaveCount(0);
    await expect(page.getByText('No task selected')).toHaveCount(0);
  });

  test('active project command launcher previews real context and cancels without sending', async ({
    page,
  }) => {
    // archive#3767: "a modal is open" is derived from `[aria-modal="true"]`
    // again rather than claimed by the one surface that remembered to, so the
    // launcher — which hand-rolls its own overlay — suppresses global chords
    // like every other modal.
    const sentIntents: string[] = [];
    await mockTaskFirstHome(page);
    await page.route('**/api/agents', (route) =>
      route.fulfill(
        json([
          {
            slug: 'codex-agent',
            name: 'Codex',
            model: 'gpt-5.3-codex',
            execution: { agentConnectionId: 'bedrock-runtime' },
          },
        ]),
      ),
    );
    await page.route('**/api/connections/agents', (route) =>
      route.fulfill(
        json([
          agentConnectionFixture({
            id: 'bedrock-runtime',
            kind: 'agent',
            type: 'bedrock-runtime',
            name: 'Bedrock Runtime',
            enabled: true,
            capabilities: ['agent-runtime', 'file-input'],
            config: { executionClass: 'managed', provider: 'bedrock' },
            status: 'ready',
            runtimeCatalog: {
              source: 'live',
              models: [
                {
                  id: 'gpt-5.3-codex',
                  name: 'gpt-5.3-codex',
                  originalId: 'gpt-5.3-codex',
                },
              ],
              builtInModels: [],
            },
            prerequisites: [],
          }),
        ]),
      ),
    );
    await page.route('**/api/orchestration/chat', async (route) => {
      const body = route.request().postData() ?? '';
      if (body.includes('Review the current work')) sentIntents.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          foregroundMessageReceiptEnvelope({
            conversationId: 'task-first-home',
            agent: 'codex-agent',
          }),
        ),
      });
    });
    // mockTaskFirstHome's `**/api/**` catch-all answers any path it doesn't
    // know with `json([])` — a 200, not a 404 — so this endpoint never falls
    // into the capability client's 404/legacy-handshake branch and instead
    // parses as an unrecognized shape ({state: 'unknown'}), which the queue
    // treats as a hard failure and refuses to stage the attachment at all.
    // Answer the real capability/prepare/upload seam explicitly (station#890;
    // shape proven by mobile-chat-composer.spec.ts's staged-attachment test)
    // so the attachment actually reaches 'complete' and Send has something to
    // dispatch. Unlike this file's own `json()` helper, these three routes
    // are NOT wrapped in a `{success,data}` envelope — the real server
    // (`createAttachmentStagingRoutes`) answers them raw, and the client
    // (`packages/sdk/src/client/attachment-staging.ts`) reads the body
    // directly with no envelope-unwrapping.
    const rawJson = (data: unknown) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(data),
    });
    const stageId = 'stage_task-first-home-launcher-context';
    let prepared: Record<string, unknown> | undefined;
    await page.route(
      /\/api\/orchestration\/attachment-staging(?:\/.*)?$/u,
      async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/capability'))
          return route.fulfill(
            rawJson({ state: 'supported', version: 1, maxConcurrentUploads: 3 }),
          );
        if (path.endsWith('/prepare')) {
          prepared = request.postDataJSON() as Record<string, unknown>;
          return route.fulfill(
            rawJson({
              ...prepared,
              stageId,
              uploadGrant: 'a'.repeat(43),
              expiresAt: '2030-01-01T00:00:00.000Z',
            }),
          );
        }
        if (path.endsWith(`/${stageId}`) && request.method() === 'PUT')
          return route.fulfill(
            rawJson({
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
    await page.goto('/');
    await startProjectTask(page);

    await page.locator('.chat-input .attachment-input').setInputFiles({
      name: 'launcher-context.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Launcher context'),
    });
    await expect(
      page.getByRole('button', { name: 'Review 1 attachment' }),
    ).toBeVisible();

    // Commands lives inside the composer's grouped "+" menu now
    // (docs/design/chat-composer.md §3.2) — the "+" trigger is the
    // persistent, keyboard-reachable anchor; the launcher itself opens via
    // its keyboard shortcut independent of the menu's own open state.
    const trigger = page.getByRole('button', { name: 'Composer actions' });
    await expect(trigger).toBeVisible();
    expect((await trigger.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      44,
    );

    const launcherShortcut =
      process.platform === 'darwin' ? 'Meta+Shift+L' : 'Control+Shift+L';
    const dockShortcut = process.platform === 'darwin' ? 'Meta+D' : 'Control+D';
    await page.keyboard.press(launcherShortcut);
    const launcher = page.getByRole('dialog', { name: 'Command launcher' });
    await expect(launcher).toBeVisible();
    await page.keyboard.press(launcherShortcut);
    await expect(launcher).toHaveCount(1);
    await expect(
      launcher.getByLabel('What should the agent do?'),
    ).toBeFocused();
    const preview = launcher.getByRole('region', { name: 'Command preview' });
    await expect(preview).toContainText('Station');
    await expect(preview).toContainText('Codex');
    await expect(preview).toContainText('gpt-5.3-codex');
    await expect(preview).toContainText('bottom');
    await expect(preview).toContainText('1: launcher-context.md');

    await launcher.getByRole('button', { name: 'Review current work' }).click();
    const suggestedIntent =
      'Review the current work and report actionable findings.';
    await expect(preview).toContainText(suggestedIntent);
    await launcher
      .getByLabel('What should the agent do?')
      .fill(suggestedIntent);
    await expect(preview).toContainText(suggestedIntent);
    await launcher.getByLabel('What should the agent do?').press(dockShortcut);
    await launcher.getByLabel('What should the agent do?').press('Control+c');
    await expect(launcher).toBeVisible();
    await expect(page.locator('.chat-dock')).not.toHaveClass(/is-collapsed/);
    await launcher.getByRole('button', { name: 'Cancel' }).click();
    await expect(launcher).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.locator('textarea')).toHaveValue('');
    expect(sentIntents).toHaveLength(0);
    await page.keyboard.press(dockShortcut);
    await expect(page.locator('.chat-dock')).toHaveClass(/is-collapsed/);
    await page.keyboard.press(dockShortcut);
    await expect(page.locator('.chat-dock')).not.toHaveClass(/is-collapsed/);

    await page.keyboard.press(launcherShortcut);
    await expect(launcher).toBeVisible();
    await launcher
      .getByLabel('What should the agent do?')
      .fill(suggestedIntent);
    await launcher.getByRole('button', { name: 'Confirm and send' }).click();
    await expect(launcher).toHaveCount(0);
    await expect.poll(() => sentIntents.length).toBe(1);
    // The composer's capability negotiation reports `supported` (the shape a
    // real Station server always advertises — station#890), so completed
    // staging dispatches an opaque `attachmentRefs` entry, never a raw
    // `attachments[].dataUrl` (that shape is `legacy-inline` only, for a peer
    // that predates this endpoint entirely).
    const sentPayload = JSON.parse(sentIntents[0]) as {
      attachmentRefs: Array<{
        stageId: string;
        clientAttachmentId: string;
        source: string;
        kind: string;
        name: string;
        mimeType: string;
        size: number;
        digest: string;
        expiresAt: string;
      }>;
    };
    const sentFile = sentPayload.attachmentRefs.find(
      (attachment) => attachment.kind === 'file',
    );
    expect(sentFile).toEqual({
      stageId: 'stage_task-first-home-launcher-context',
      clientAttachmentId: expect.any(String),
      source: 'current-composer',
      kind: 'file',
      name: 'launcher-context.md',
      mimeType: 'text/markdown',
      size: 18,
      digest: `sha256-${'a'.repeat(64)}`,
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });

  test('desktop active work reveals real files and task context beside usable chat', async ({
    page,
  }) => {
    await mockTaskFirstHome(page);
    await page.goto('/');
    await startProjectTask(page);

    // Delegate/Commands/Files/Task-context collapse into one grouped "+"
    // menu next to attach + mic (docs/design/chat-composer.md §3.2) — open
    // it to reach the Files/Task-context toggles.
    const actionsMenuTrigger = page.getByRole('button', {
      name: 'Composer actions',
    });
    await expect(actionsMenuTrigger).toBeVisible();

    await actionsMenuTrigger.click();
    const menu = page.getByRole('menu', { name: 'Composer actions' });
    await expect(menu).toBeVisible();
    const filesTrigger = menu.getByRole('menuitemcheckbox', {
      name: 'Files (1)',
    });
    await expect(filesTrigger).toBeVisible();
    await filesTrigger.click();
    await expect(
      page.getByRole('complementary', { name: 'Active work files' }),
    ).toBeVisible();
    await expect(page.locator('textarea')).toBeVisible();
    await page
      .getByRole('button', { name: 'Open src-ui/src/App.tsx in editor' })
      .click();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe('/projects/station/layouts/coding');
    expect(new URL(page.url()).searchParams.get('previewPath')).toBe(
      'src-ui/src/App.tsx',
    );

    await actionsMenuTrigger.click();
    await expect(menu).toBeVisible();
    const contextTrigger = menu.getByRole('menuitemcheckbox', {
      name: 'Task context',
    });
    await contextTrigger.click();
    const context = page.getByRole('complementary', { name: 'Task context' });
    await expect(context).toContainText('feat/contextual-active-work');
    await expect(context).toContainText('Checks');
    await expect(context).toContainText('Unavailable');

    const geometry = await page
      .locator('.chat-dock__workspace')
      .evaluate((el) => ({
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.scrollHeight).toBeLessThanOrEqual(
      geometry.clientHeight + 1,
    );
  });

  test.describe('Pixel 7', () => {
    const { defaultBrowserType: _defaultBrowserType, ...pixel7 } =
      devices['Pixel 7'];
    test.use(pixel7);

    test('keeps provider/model selection contained and touch-friendly', async ({
      page,
    }) => {
      await mockTaskFirstHome(page);
      await mockStationModelProviders(page);
      await page.goto('/');
      await startProjectTask(page);

      const modelButton = page.getByRole('button', {
        name: /Model: Codex · Work — Shared model/,
      });
      await modelButton.click();
      const picker = page.getByRole('dialog', { name: 'Choose model' });
      await expect(picker).toBeVisible();
      await expect(
        picker.getByRole('button', { name: 'Close model picker' }),
      ).toBeFocused();
      for (const name of ['★ Favorites', 'All', 'Bedrock · Prod']) {
        const bounds = await picker.getByRole('button', { name }).boundingBox();
        expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      }
      const geometry = await picker.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          viewportWidth: window.innerWidth,
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      await picker.getByRole('button', { name: 'Close model picker' }).click();
      await expect(modelButton).toBeFocused();
    });

    test('groups mobile customization and system navigation without Advanced overflow', async ({
      page,
    }) => {
      await mockTaskFirstHome(page);
      await page.goto('/');
      await page.getByRole('button', { name: 'Toggle menu' }).click();
      const navigation = page.getByRole('navigation', {
        name: 'Mobile navigation',
      });
      await expect(
        navigation.getByRole('button', { name: 'Advanced' }),
      ).toHaveCount(0);

      // RT-13 (`app-shell/surface-registry.ts`): Agents, Connections and
      // Activity are a flat, always-visible band now, not members of a
      // disclosure group — the loop below used to prove "Agents" visible for a
      // reason it no longer holds. (origin/main renamed the retired
      // "Playbooks & skills" label to Guidance in this same loop; Guidance is
      // asserted in the Customize loop further down, where it belongs.)
      for (const label of ['Agents', 'Connections', 'Activity']) {
        const item = navigation.getByRole('button', { name: label });
        await expect(item).toBeVisible();
        expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET_PX,
        );
      }

      // SHELL-15 (`components/project-sidebar/ProjectSidebarNav.tsx:40-50`):
      // both groups start EXPANDED and their open state is the user's own, so
      // clicking a group toggle now COLLAPSES it — they are no longer
      // route-driven, mutually exclusive accordions.
      const customize = navigation.getByRole('button', { name: 'Customize' });
      const system = navigation.getByRole('button', { name: 'System' });
      await expect(customize).toHaveAttribute('aria-expanded', 'true');
      await expect(system).toHaveAttribute('aria-expanded', 'true');

      // "Playbooks & skills" is retired to a search keyword; the surface is
      // Guidance (`surface-registry.ts` `customize(20)`).
      for (const label of ['Guidance', 'Registry', 'Settings']) {
        const item = navigation.getByRole('button', { name: label });
        await expect(item).toBeVisible();
        expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET_PX,
        );
      }

      // Independent, not exclusive: collapsing one hides only its own items and
      // leaves the other group and the primary band alone.
      await customize.click();
      await expect(customize).toHaveAttribute('aria-expanded', 'false');
      await expect(
        navigation.getByRole('button', { name: 'Guidance' }),
      ).toBeHidden();
      await expect(system).toHaveAttribute('aria-expanded', 'true');
      await expect(
        navigation.getByRole('button', { name: 'Agents' }),
      ).toBeVisible();
      // archive#3313 (Settings IA, option A): Settings holds the System slot;
      // Developer is settings-gated and hidden until enabled on this device.
      await expect(
        navigation.getByRole('button', { name: 'Settings' }),
      ).toBeVisible();
      await expect(
        navigation.getByRole('button', { name: 'Developer' }),
      ).toHaveCount(0);
      expect(
        await page.evaluate(() =>
          Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
          ),
        ),
      ).toBeLessThanOrEqual(page.viewportSize()!.width);
    });

    test('shows one task surface with composer, dock controls, reachable navigation, and safe geometry', async ({
      page,
    }) => {
      // archive#3768: the pulse-count links carry the same 44px floor every
      // other Home control does, and the twelve-column activity chart — which
      // cannot hold twelve 44px targets in a phone-width row — renders as a
      // picture on a coarse pointer instead of as twelve unhittable buttons.
      // The assertion NAMES any offender so the failure text is diagnosable.
      await mockTaskFirstHome(page);
      await page.goto('/');

      await expect(page.locator('.home-view')).toBeVisible();
      // archive#3783: the setup card must be ON SCREEN for the geometry scan
      // below to have seen it. Asserting its presence is what keeps this
      // coverage from silently reverting to the shape that missed a 121x34
      // control — a fixture that stops rendering the card would otherwise pass
      // by scanning one button fewer.
      await expect(page.getByTestId('first-run-home-card')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Set up Station' }),
      ).toBeVisible();
      await expect(page.locator('.sidebar')).not.toBeVisible();
      await page.getByRole('button', { name: 'Toggle menu' }).click();
      await expect(page.locator('.sidebar--expanded')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Home', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Home', exact: true }).click();

      await page.getByRole('button', { name: /Start direct chat/i }).click();
      await page.locator('.new-chat-modal__agent--selected').click();
      await expect(page.locator('.chat-dock')).toBeVisible();
      await page.getByRole('button', { name: 'Chat actions' }).click();
      await page
        .getByRole('menu', { name: 'Chat actions' })
        .getByRole('menuitem', { name: /^Expand chat/ })
        .click();
      await expect(page.locator('.chat-dock')).toHaveClass(/is-maximized/);
      await expect(page.locator('textarea')).toBeVisible();
      await page.evaluate(() =>
        (window as any).__setTaskFirstViewport(520, 260),
      );
      await expect(page.locator('.chat-dock')).toBeVisible();
      await page.getByRole('button', { name: 'Chat actions' }).click();
      await page
        .getByRole('menu', { name: 'Chat actions' })
        .getByRole('menuitem', { name: /^Restore chat/ })
        .click();
      await expect(page.locator('.chat-dock')).not.toHaveClass(/is-maximized/);

      const geometry = await page.evaluate(() => {
        const visibleButtons = Array.from(
          document.querySelectorAll(
            '.home-view button, .sidebar--expanded button',
          ),
        ).filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          // Named, not counted: a bare number tells whoever reads the failure
          // nothing about which control shrank.
          small: visibleButtons
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.width < 44 || rect.height < 44;
            })
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return `${element.className || element.tagName} "${
                element.getAttribute('aria-label') ??
                element.textContent?.trim()
              }" ${Math.round(rect.width)}x${Math.round(rect.height)}`;
            }),
        };
      });
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.small).toEqual([]);
    });

    test('keeps delegated task follow-up and approval controls reachable above the keyboard', async ({
      page,
    }) => {
      const commands: Array<Record<string, unknown>> = [];
      await mockTaskFirstHome(page, {
        commands,
        sessionEvents: [
          {
            eventId: 'request-open-1',
            provider: 'codex',
            threadId: 'task-first-home',
            createdAt: '2026-07-13T00:00:01Z',
            method: 'request.opened',
            requestId: 'request-private-identifier',
            requestType: 'approval',
            title: 'Allow shell command',
          },
        ],
      });
      await page.goto('/activity?session=task-first-home');

      const detail = page.getByTestId('session-detail');
      await expect(detail).toBeVisible();
      const request = page.getByTestId('session-request');
      await expect(request).toContainText('Allow shell command');
      await expect(request).not.toContainText('request-private-identifier');

      const composer = page.getByLabel('Continue delegated task');
      await composer.focus();
      await page.evaluate(() =>
        (window as any).__setTaskFirstViewport(420, 280),
      );
      await expect(detail).toHaveClass(/sessions-detail--viewport-compact/);
      const geometry = await detail.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          bottom: rect.bottom,
          visualBottom:
            (window.visualViewport?.offsetTop ?? 0) +
            (window.visualViewport?.height ?? window.innerHeight),
          overflows: element.scrollWidth > element.clientWidth,
        };
      });
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.visualBottom + 1);
      expect(geometry.overflows).toBe(false);

      await composer.fill('Continue from my phone');
      const continueButton = page.getByRole('button', { name: 'Continue' });
      const approveButton = request.getByRole('button', { name: 'Approve' });
      const declineButton = request.getByRole('button', { name: 'Decline' });
      for (const control of [continueButton, approveButton, declineButton]) {
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      }

      await continueButton.click();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toEqual({
        type: 'continueExecutionMessage',
        threadId: 'task-first-home',
        input: {
          message: 'Continue from my phone',
        },
      });
      await approveButton.click();
      await expect.poll(() => commands.length).toBe(2);
      expect(commands[1]).toEqual({
        type: 'respondToRequest',
        threadId: 'task-first-home',
        requestId: 'request-private-identifier',
        decision: 'accept',
      });
    });

    test('wraps canonical workflow step and long open gate ids without phone overflow', async ({
      page,
    }) => {
      const longGateId =
        'verify-gate-with-a-deliberately-long-provider-scoped-identifier';
      await mockTaskFirstHome(page, {
        workflowTasks: [
          {
            taskSlug: 'kontourai-station-592',
            status: 'in_progress',
            phase: 'verification',
            updatedAt: '2026-07-20T19:00:00Z',
            nextAction: { status: 'continue', summary: 'Verify the work.' },
            workItemRefs: ['kontourai/station#592'],
            flowRun: {
              run_id: 'kontourai-station-592',
              definition_id: 'builder.build',
              definition_version: '1.1',
              status: 'active',
              current_step: 'verify',
              run_ref: '.kontourai/flow/runs/kontourai-station-592',
              open_gate_ids: [longGateId],
            },
            hasHandoff: true,
            path: '.kontourai/flow-agents/kontourai-station-592',
          },
        ],
      });
      await page.goto('/activity?session=task-first-home');

      const statusLine = page
        .getByTestId('session-detail')
        .locator('.workflow-status-line')
        .filter({ hasText: 'kontourai-station-592' });
      await expect(statusLine).toBeVisible();
      await expect(statusLine).toContainText('step: verify');
      await expect(statusLine).toContainText(`gate: ${longGateId}`);
      const geometry = await statusLine.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        gateOverflowWrap: getComputedStyle(
          element.querySelector('.workflow-status-line__gates')!,
        ).overflowWrap,
      }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(
        geometry.clientWidth + 1,
      );
      expect(geometry.gateOverflowWrap).toBe('anywhere');
    });

    test('directs delegated work from the mobile session list before opening detail', async ({
      page,
    }) => {
      const commands: Array<Record<string, unknown>> = [];
      await mockTaskFirstHome(page, { commands });
      await page.goto('/activity');

      const coordinator = page.getByTestId('delegated-task-coordinator');
      await expect(coordinator).toBeVisible();
      await expect(coordinator).toContainText('task first home');
      await expect(coordinator).toContainText('Engine');

      const input = coordinator.getByLabel('Direct worker follow-up');
      const send = coordinator.getByRole('button', { name: 'Send follow-up' });
      const view = coordinator.getByRole('button', { name: 'View task' });
      const delegate = coordinator.getByRole('button', {
        name: 'Delegate subtask',
      });
      for (const control of [input, send, view, delegate]) {
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      }

      await input.fill('Run the focused mobile checks');
      await send.click();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toEqual({
        type: 'continueExecutionMessage',
        threadId: 'task-first-home',
        input: {
          message: 'Run the focused mobile checks',
        },
      });

      await delegate.click();
      const launcher = page.getByRole('dialog', { name: 'Delegate a task' });
      await expect(launcher).toBeVisible();
      await expect(launcher).toContainText('Child worker of');
      await expect(launcher).toContainText('task first home');
      await expect(launcher.getByLabel('Task')).toBeFocused();
      await expect(launcher).toContainText('Codex');
      await expect(launcher).toContainText('gpt-5.3-codex · This Station');
      await expect(launcher.getByLabel('Worker')).toHaveCount(0);
      const changeRouting = launcher.getByRole('button', {
        name: 'Change routing',
      });
      const routingBounds = await changeRouting.boundingBox();
      expect(routingBounds).not.toBeNull();
      expect(routingBounds?.width ?? 0).toBeGreaterThanOrEqual(
        MIN_TOUCH_TARGET_PX,
      );
      expect(routingBounds?.height ?? 0).toBeGreaterThanOrEqual(
        MIN_TOUCH_TARGET_PX,
      );
      await page.evaluate(() =>
        (window as any).__setTaskFirstViewport(420, 280),
      );
      await expect
        .poll(() =>
          launcher.evaluate(
            (element) =>
              element.parentElement?.style.getPropertyValue(
                '--responsive-visual-viewport-height',
              ) ?? '',
          ),
        )
        .toBe('420px');
      const launcherGeometry = await launcher.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          bottom: rect.bottom,
          visualBottom:
            (window.visualViewport?.offsetTop ?? 0) +
            (window.visualViewport?.height ?? window.innerHeight),
          overflows: element.scrollWidth > element.clientWidth,
        };
      });
      expect(launcherGeometry.bottom).toBeLessThanOrEqual(
        launcherGeometry.visualBottom + 1,
      );
      expect(launcherGeometry.overflows).toBe(false);
      const closeDelegation = launcher.getByRole('button', {
        name: 'Close delegation',
      });
      const cancelDelegation = launcher.getByRole('button', { name: 'Cancel' });
      for (const control of [closeDelegation, cancelDelegation]) {
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      }
      await cancelDelegation.click();
      await expect(launcher).toHaveCount(0);
      await expect(delegate).toBeFocused();

      await view.click();
      await expect(page.getByTestId('session-detail')).toBeVisible();
      const back = page.getByRole('button', { name: '← Back to list' });
      await expect(back).toBeVisible();
      await expect(back).toBeFocused();

      const geometry = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      }));
      expect(geometry.overflow).toBeLessThanOrEqual(1);
    });

    test('contains focus and dismisses active-work sheets for navigation across dock states', async ({
      page,
    }) => {
      await mockTaskFirstHome(page);
      await page.goto('/');
      await startProjectTask(page);

      await page.evaluate(() =>
        (window as any).__setTaskFirstViewport(520, 260),
      );
      // Delegate/Commands/Files/Task-context collapse into one grouped "+"
      // menu (docs/design/chat-composer.md §3.2); the "+" trigger is the
      // only persistently mounted anchor, so it — not an individual item —
      // is what launched surfaces restore focus to on close.
      const launcherTrigger = page.getByRole('button', {
        name: 'Composer actions',
      });
      const openActionsMenu = async () => {
        await launcherTrigger.click();
        await expect(
          page.getByRole('menu', { name: 'Composer actions' }),
        ).toBeVisible();
      };

      await expect(launcherTrigger).toBeVisible();
      await openActionsMenu();
      const taskContextTrigger = page.getByRole('menuitemcheckbox', {
        name: 'Task context',
      });
      const mobileFilesTrigger = page.getByRole('menuitemcheckbox', {
        name: 'Files (1)',
      });
      const launcherItem = page.getByRole('menuitem', {
        name: 'Open command launcher',
      });
      for (const trigger of [
        launcherTrigger,
        launcherItem,
        mobileFilesTrigger,
        taskContextTrigger,
      ]) {
        await expect(trigger).toBeVisible();
        const bounds = await trigger.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      }
      await launcherItem.click();
      const launcher = page.getByRole('dialog', { name: 'Command launcher' });
      await expect(launcher).toBeVisible();
      await expect(
        launcher.getByLabel('What should the agent do?'),
      ).toBeFocused();
      const closeLauncher = launcher.getByRole('button', {
        name: 'Close command launcher',
      });
      const suggestion = launcher.getByRole('button', {
        name: 'Review current work',
      });
      const cancelLauncher = launcher.getByRole('button', { name: 'Cancel' });
      const confirmLauncher = launcher.getByRole('button', {
        name: 'Confirm and send',
      });
      for (const control of [
        closeLauncher,
        suggestion,
        cancelLauncher,
        confirmLauncher,
      ]) {
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      }
      await suggestion.click();
      await expect(
        launcher.getByRole('region', { name: 'Command preview' }),
      ).toContainText('Review the current work');
      await confirmLauncher.focus();
      await page.keyboard.press('Tab');
      await expect(closeLauncher).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(confirmLauncher).toBeFocused();
      const launcherGeometry = await launcher.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          bottom: rect.bottom,
          visualBottom:
            (window.visualViewport?.offsetTop ?? 0) +
            (window.visualViewport?.height ?? window.innerHeight),
          overflows: element.scrollWidth > element.clientWidth,
        };
      });
      expect(launcherGeometry.bottom).toBeLessThanOrEqual(
        launcherGeometry.visualBottom + 1,
      );
      expect(launcherGeometry.overflows).toBe(false);
      await cancelLauncher.click();
      await expect(launcher).toHaveCount(0);
      await expect(launcherTrigger).toBeFocused();
      await openActionsMenu();
      await launcherItem.click();
      await expect(closeLauncher).toBeVisible();
      await closeLauncher.click();
      await expect(launcher).toHaveCount(0);
      await expect(launcherTrigger).toBeFocused();
      await openActionsMenu();
      await taskContextTrigger.click();
      const dialog = page.getByRole('dialog', { name: 'Task context' });
      await expect(dialog).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Close task context' }),
      ).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(
        page.getByRole('button', { name: 'Open project context' }),
      ).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(
        page.getByRole('button', { name: 'Close task context' }),
      ).toBeFocused();
      const geometry = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const controls = Array.from(element.querySelectorAll('button')).map(
          (control) => control.getBoundingClientRect(),
        );
        return {
          bottom: rect.bottom,
          visualBottom:
            (window.visualViewport?.offsetTop ?? 0) +
            (window.visualViewport?.height ?? window.innerHeight),
          smallTargets: controls.filter(
            (control) => control.width < 44 || control.height < 44,
          ).length,
          documentOverflows:
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        };
      });
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.visualBottom + 1);
      expect(geometry.smallTargets).toBe(0);
      expect(geometry.documentOverflows).toBe(false);
      await page.getByRole('button', { name: 'Close task context' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(launcherTrigger).toBeFocused();
      await expect(page.locator('textarea')).toBeVisible();

      await page.getByRole('button', { name: 'Chat actions' }).click();
      await page
        .getByRole('menu', { name: 'Chat actions' })
        .getByRole('menuitem', { name: /^Expand chat/ })
        .click();
      await expect(page.locator('.chat-dock')).toHaveClass(/is-maximized/);
      await openActionsMenu();
      await taskContextTrigger.click();
      await page.getByRole('button', { name: 'Open project context' }).click();
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe('/projects/station');
      const projectUrl = new URL(page.url());
      expect(projectUrl.searchParams.get('dock')).toBe('open');
      // archive#869/#939: a maximized dock is opaque and full-height, so navigating
      // used to change the view *underneath* it and nothing moved. A real
      // pathname change now returns the dock to its docked size, which drops
      // `maximize` from the URL — this spec asserted the pre-archive#939 behaviour of
      // carrying `maximize=true` across the navigation, and the dock control
      // it clicked next ('Restore chat dock') only exists while maximized.
      // Assert the restore itself instead: the destination is reached with the
      // dock still open, no longer maximized, and the class agrees with the URL
      // (the `dockSnap` reconcile in `snapAfterNavigationRestore` is what stops
      // the mobile snap-sync effect re-expanding it right back).
      expect(projectUrl.searchParams.get('maximize')).toBeNull();
      await expect(page.locator('.chat-dock')).not.toHaveClass(/is-maximized/);
      // Mobile has no permanent Maximize/Collapse buttons — dock height is the
      // drag gesture, with named entries in the header overflow.
      await page.getByRole('button', { name: 'Chat actions' }).click();
      const dockMenu = page.getByRole('menu', { name: 'Chat actions' });
      await expect(
        dockMenu.getByRole('menuitem', { name: /^Expand chat/ }),
      ).toBeVisible();
      await dockMenu.getByRole('menuitem', { name: 'Collapse chat' }).click();
      await expect(page.locator('.chat-dock')).toHaveClass(/is-collapsed/);
      await page.getByRole('button', { name: 'Chat actions' }).click();
      await page
        .getByRole('menu', { name: 'Chat actions' })
        .getByRole('menuitem', { name: /^Expand chat/ })
        .click();
      await expect(page.locator('.chat-dock')).not.toHaveClass(/is-collapsed/);
      await openActionsMenu();
      await mobileFilesTrigger.click();
      const filesDialog = page.getByRole('dialog', {
        name: 'Active work files',
      });
      await expect(filesDialog).toBeVisible();
      await page
        .getByRole('button', { name: 'Open src-ui/src/App.tsx in editor' })
        .click();
      await expect(filesDialog).toHaveCount(0);
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe('/projects/station/layouts/coding');
      expect(new URL(page.url()).searchParams.get('previewPath')).toBe(
        'src-ui/src/App.tsx',
      );
    });
  });
});
