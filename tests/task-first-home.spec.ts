import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import { PROJECT_IDENTITY_NOT_PREPARED_CODE } from '@kontourai/station-contracts/project-identity';
import type { SkillExperienceInventoryV1 } from '@kontourai/station-contracts/skill-experience';
import type {
  BrowserPaneAccessView,
  BrowserSessionView,
} from '@kontourai/station-contracts/workspace-browser-pane';
import type {
  WorkspaceFileChanges,
  WorkspaceFilePreview,
} from '@kontourai/station-contracts/workspace-file-preview';
import type { WorkspacePaneHostActionCatalog } from '@kontourai/station-contracts/workspace-pane-host-contribution';
import { devices, expect, type Locator, type Page } from '@playwright/test';
import type { PluginPublishInspection } from '../src-ui/src/views/project-page/pluginPublishClient';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import {
  E2E_STATION_CAPABILITIES,
  E2E_STATION_COMPATIBILITY,
  installE2EWorkspacePaneCatalog,
} from './helpers/current-station-contract';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  installJourneyProfile,
  profileJourney,
} from './helpers/journey-profile';
import {
  emitMockOrchestrationEvent,
  installMockOrchestrationSse,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';
import { fulfillStationShellRead } from './helpers/station-shell-fixtures';
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

/** A body that is already a complete API envelope. */
function rawJson(body: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

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
    historyCount?: number;
    commands?: Array<Record<string, unknown>>;
    workflowTasks?: Array<Record<string, unknown>>;
    /**
     * The project's own default Model, a second model the Codex runtime
     * catalog also lists. Absent, the project names none and the agent
     * default (`gpt-5.3-codex`) applies.
     */
    projectDefaultModel?: string;
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
    if (
      route.request().method() === 'GET' &&
      path === '/api/browser/projects/station/access'
    ) {
      const access: BrowserPaneAccessView = {
        projectId: project.id,
        role: 'operator',
        principalKey: 'operator',
        operator: true,
        browser: 'not-ready',
      };
      await route.fulfill(json(access));
      return;
    }
    if (
      route.request().method() === 'GET' &&
      path === '/api/browser/sessions' &&
      new URL(route.request().url()).searchParams.get('projectSlug') ===
        project.slug
    ) {
      const sessions: BrowserSessionView[] = [];
      await route.fulfill(json(sessions));
      return;
    }
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
    if (
      path === '/api/projects/station/plugin-publish' &&
      route.request().method() === 'GET'
    ) {
      const inspection: PluginPublishInspection = {
        plugin: null,
        reason: 'not-a-plugin',
      };
      await route.fulfill(json(inspection));
      return;
    }
    if (path === '/api/projects/station') {
      await route.fulfill(
        json(
          options.projectDefaultModel
            ? { ...project, defaultModel: options.projectDefaultModel }
            : project,
        ),
      );
      return;
    }
    // The project-scoped launcher reads the portable identity. This fixture's
    // Project never prepared one, which the real route answers with its
    // discriminated not-prepared 404 (`project-identity-routes.ts`).
    if (
      path === '/api/projects/station/identity' &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error:
            'This Project has no prepared portable identity. Prepare it explicitly before placing it elsewhere.',
          code: PROJECT_IDENTITY_NOT_PREPARED_CODE,
        }),
      });
      return;
    }
    // The New chat draft reads the skill-experience inventory (#3201). This
    // fixture installs none, which the route answers with an empty inventory.
    if (
      path === '/api/skills/experiences' &&
      route.request().method() === 'GET'
    ) {
      const inventory: SkillExperienceInventoryV1 = {
        experiences: [],
        diagnostics: [],
      };
      await route.fulfill(json(inventory));
      return;
    }
    // Opening a changed file from the active-work panel mounts the project
    // file-preview pane, which reads the bounded preview route.
    if (
      path === '/api/projects/station/file-preview' &&
      route.request().method() === 'POST'
    ) {
      const preview: WorkspaceFilePreview = {
        path: 'src-ui/src/App.tsx',
        status: 'ready',
        renderKind: 'text',
        content: 'export function App() {}\n',
      };
      await route.fulfill(json(preview));
      return;
    }
    // The pane then reads that file's changes against HEAD (#3365): the file
    // came from the active-work changed-files list, so it has a patch, in the
    // `{ success, data }` envelope the real route uses
    // (src-server/routes/projects/workspace-pane-previews.ts). Only the
    // previewed file's own read is declared; any other body falls through to
    // the fixture audit and fails the test by name.
    if (
      path === '/api/projects/station/file-preview/changes' &&
      route.request().method() === 'POST' &&
      route.request().postData() ===
        JSON.stringify({ path: 'src-ui/src/App.tsx' })
    ) {
      const changes: WorkspaceFileChanges = {
        state: 'changed',
        base: 'HEAD',
        patch:
          'diff --git a/src-ui/src/App.tsx b/src-ui/src/App.tsx\n' +
          'index e69de29..8b7a6f1 100644\n' +
          '--- a/src-ui/src/App.tsx\n' +
          '+++ b/src-ui/src/App.tsx\n' +
          '@@ -0,0 +1 @@\n' +
          '+export function App() {}\n',
      };
      await route.fulfill(json(changes));
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
      await route.fulfill(
        json(
          options.historyCount
            ? Array.from({ length: options.historyCount }, (_, index) => ({
                ...taskSession,
                threadId: `history-${index}`,
                conversationId: `conversation-${index}`,
                displayTitle: `History session ${index}`,
                delegation: undefined,
                lifecycleState: 'completed',
                status: 'closed',
                updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
              }))
            : [taskSession],
        ),
      );
      return;
    }
    if (
      path === '/api/conversations/task-first-home/open' &&
      route.request().method() === 'GET'
    ) {
      const resolution: ConversationOpenResolution = {
        status: 'resolved',
        conversation: {
          id: taskSession.threadId,
          title: 'New chat',
          agentSlug: agentId(taskSession.assignedAgentSlug),
          source: 'runtime',
          createdAt: taskSession.createdAt,
          updatedAt: taskSession.updatedAt,
          messageCount: 0,
          mutable: false,
          answerability: { answerable: true },
        },
        currentSessionId: taskSession.threadId,
        execution: {
          sessionId: taskSession.threadId,
          agentId: agentId(taskSession.assignedAgentSlug),
          provider: taskSession.provider,
          engineConnectionId: 'codex',
          model: taskSession.model,
        },
        transcript: { available: true, owner: 'runtime', messageCount: 0 },
        canContinue: true,
        answerability: { answerable: true },
        recoveryActions: [],
      };
      await route.fulfill(json(resolution));
      return;
    }
    if (
      path === '/api/orchestration/pane-host/station/catalog' &&
      route.request().method() === 'GET'
    ) {
      // This project has built-in panes and no installed package actions.
      await route.fulfill(
        json({
          projectSlug: 'station',
          support: 'supported',
          complete: true,
          contributions: [],
        } satisfies WorkspacePaneHostActionCatalog),
      );
      return;
    }
    if (path === '/api/orchestration/sessions/task-first-home') {
      await route.fulfill(
        json({ session: taskSession, events: options.sessionEvents ?? [] }),
      );
      return;
    }
    if (
      path === '/api/orchestration/sessions/task-first-home/event-window' ||
      path === '/api/orchestration/conversations/task-first-home/event-window'
    ) {
      await route.fulfill(
        json({
          protocolVersion: 1,
          ...(path.includes('/conversations/')
            ? {
                conversationId: 'task-first-home',
                currentSessionId: 'task-first-home',
                handoffs: [],
              }
            : { session: taskSession }),
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
    if (
      path === '/api/orchestration/sessions/task-first-home/flow-run' ||
      path === '/api/orchestration/sessions/task-first-home/builder-run'
    ) {
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
      // The receipt envelope is already `{success,data}`: wrapping it in
      // `json()` again hides `providerTurnId` and sends every Send down the
      // "may have started" indeterminate branch.
      await route.fulfill(
        rawJson(
          foregroundMessageReceiptEnvelope({
            conversationId: 'task-first-home',
            providerTurnId: 'task-first-home-start',
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
        rawJson(
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
    if (
      path === '/api/knowledge/status' &&
      route.request().method() === 'GET'
    ) {
      await route.fulfill(
        json({
          vectorDb: null,
          embedding: null,
          stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
        }),
      );
      return;
    }
    if (
      path === '/api/connections/agents' ||
      (path === '/api/connections' && route.request().method() === 'GET')
    ) {
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
                ...(options.projectDefaultModel
                  ? [
                      {
                        id: options.projectDefaultModel,
                        name: options.projectDefaultModel,
                        originalId: options.projectDefaultModel,
                      },
                    ]
                  : []),
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
    if (
      route.request().method() === 'GET' &&
      /^\/api\/orchestration\/(?:sessions|conversations)\/codex-agent%3A\d+\/(?:checkpoints|event-window)$/.test(
        path,
      )
    ) {
      await route.fulfill({
        status: 404,
        json: {
          success: false,
          error: 'This draft has not started an execution Session',
        },
      });
      return;
    }
    if (
      route.request().method() === 'GET' &&
      path === '/api/projects/station/layouts/coding'
    ) {
      await route.fulfill(
        json({
          id: 'l1',
          slug: 'coding',
          name: 'Coding',
          type: 'coding',
          config: {},
        }),
      );
      return;
    }
    if (
      route.request().method() === 'GET' &&
      path === '/api/projects/station/conversations'
    ) {
      await route.fulfill(json([]));
      return;
    }
    if (
      route.request().method() === 'GET' &&
      [
        '/api/coding/git/log',
        '/api/projects/station/knowledge',
        '/api/projects/station/knowledge/namespaces',
        '/api/projects/station/knowledge/status',
        '/api/projects/station/operating-state/availability',
        '/api/projects/station/work-items',
        '/api/projects/station/flow/definitions',
        '/api/projects/station/readiness',
        '/api/projects/station/trust-bundles',
        '/api/tasks/task%3Atask-first-home/room',
        '/api/tasks/task%3Atask-first-home/room/events',
      ].includes(path)
    ) {
      await route.fulfill({
        status: 503,
        json: {
          success: false,
          error: 'Optional project source unavailable in this Home fixture',
        },
      });
      return;
    }
    if (
      route.request().method() === 'GET' &&
      [
        '/api/orchestration/sessions/task-first-home/checkpoints',
        '/api/projects/layouts/available',
      ].includes(path)
    ) {
      await route.fulfill(json([]));
      return;
    }
    if (await fulfillStationShellRead(route)) return;
    await rejectUnexpectedFixtureRequest(route);
  });
  await installE2EWorkspacePaneCatalog(page, {
    projectId: project.id,
    projectSlug: project.slug,
    layoutSlug: 'coding',
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

/**
 * Opens the dock's start composer through the dock's own New chat action
 * (the collapsed bar's icon, the open dock's New, or a phone header's): the
 * same composer Home renders inline. It opens on the remembered Agent and
 * project; choosing an Agent, Model or project never starts an engine, only
 * Start does.
 */
async function openNewChatDraft(page: Page) {
  await page
    .locator(
      '.chat-dock__header, .chat-dock__tab-actions, .chat-dock__no-chat, .chat-dock__mobile-header',
    )
    .getByRole('button', { name: 'New chat', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'New chat', exact: true });
  await expect(dialog).toBeVisible();
  return {
    dialog,
    draft: dialog.getByRole('form', { name: 'Start work' }),
  };
}

/** Chooses a project through a composer's project chip. */
async function chooseProject(page: Page, composer: Locator, slug: string) {
  await composer.getByRole('button', { name: /^Project: / }).click();
  const menu = page.getByRole('dialog', { name: 'Choose project' });
  await expect(menu).toBeVisible();
  await menu.locator(`[data-context-value="${slug}"]`).click();
  await expect(menu).toHaveCount(0);
}

/** Opens the draft and scopes it to the Station project (not yet sent). */
async function openProjectDraft(page: Page) {
  const opened = await openNewChatDraft(page);
  await expect(
    opened.draft.getByRole('button', { name: 'Project: No project' }),
  ).toBeVisible();
  await chooseProject(page, opened.draft, 'station');
  await expect(
    opened.draft.getByRole('button', { name: 'Project: Station' }),
  ).toBeVisible();
  return opened;
}

/** Starts the draft's message; the dialog closes into the dock's chat. */
async function sendDraft(
  { dialog, draft }: Awaited<ReturnType<typeof openNewChatDraft>>,
  message: string,
) {
  await draft
    .getByRole('textbox', { name: 'What would you like done?', exact: true })
    .fill(message);
  await draft.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Opens the Model picker the way a person reaches it in a start composer:
 * the Agent chip's list, then that Agent row's Model control.
 */
async function openComposerModelPicker(page: Page, composer: Locator) {
  await composer.getByRole('button', { name: /^Agent: / }).click();
  const agents = page.getByRole('dialog', { name: 'Choose agent' });
  await expect(agents).toBeVisible();
  await agents
    .getByRole('button', { name: /^Model: / })
    .first()
    .click();
  const picker = page.getByRole('dialog', { name: 'Choose model' });
  await expect(picker).toBeVisible();
  return picker;
}

/**
 * Completes the turn Send started so the dock's chat is idle. A started turn
 * keeps the chat "sending" (no command launcher, queued follow-ups) until the
 * engine reports it finished; the fixture's engine does that here. Needs
 * `installMockOrchestrationSse(page)` before the page loads.
 */
async function completeStartedTurn(page: Page, prompt: string) {
  await waitForMockOrchestrationSse(page);
  const event = (suffix: string, method: string, extra = {}) =>
    emitMockOrchestrationEvent(page, 'orchestration:event', {
      event: {
        eventId: `task-first-home-start-${suffix}`,
        provider: 'codex',
        threadId: 'task-first-home',
        turnId: 'task-first-home-start',
        createdAt: '2026-07-13T00:00:02Z',
        method,
        ...extra,
      },
    });
  await event('started', 'turn.started', { prompt });
  await event('completed', 'turn.completed', {
    outputText: 'Ready.',
    finishReason: 'stop',
  });
  await expect(page.locator('.chat-dock textarea')).toHaveAttribute(
    'placeholder',
    /^Type a message/,
  );
}

async function startProjectTask(
  page: Page,
  options: { settle?: boolean } = {},
) {
  const prompt = 'Start the project task.';
  const sent = page.waitForResponse(
    (response) =>
      response.url().includes('/api/orchestration/chat') &&
      response.request().method() === 'POST',
  );
  await sendDraft(await openProjectDraft(page), prompt);
  await sent;
  // Desktop keeps the standalone project-context row; a phone folds the project
  // into the one-row header's eyebrow above the chat title.
  const projectContext = page.locator('.chat-dock__project-context');
  const mobileEyebrow = page.locator('.chat-dock__mobile-eyebrow');
  await expect(projectContext.or(mobileEyebrow).first()).toBeVisible();
  if (options.settle) await completeStartedTurn(page, prompt);
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

/**
 * The chat Start opened, in the dock, runs on `agent` and `model`: its own
 * Agent and Model controls name them. The composer qualifies each ("Agent:
 * Codex. Wait for…", "Model: Codex Runtime — gpt-5.4 (project default)"), so
 * each is matched as a whole name segment, not a substring, and only inside
 * the dock holding the started chat's transcript.
 */
async function expectStartedChatRuns(
  page: Page,
  prompt: string,
  agent: string | undefined,
  model: string | undefined,
) {
  const literal = (text = '') => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const chat = page
    .getByRole('region', { name: 'Chat dock', exact: true })
    .filter({
      has: page.getByRole('log', { name: 'Conversation transcript' }),
    });
  await expect(
    chat.getByRole('log', { name: 'Conversation transcript' }),
  ).toContainText(prompt);
  await expect(
    chat.getByRole('button', {
      name: new RegExp(`^Agent: ${literal(agent)}(?:\\.|$)`),
    }),
  ).toBeVisible();
  await expect(
    chat.getByRole('button', {
      name: new RegExp(`^Model: (?:.+ — )?${literal(model)}(?: \\(|$)`),
    }),
  ).toBeVisible();
}

test.describe('Task-first Home (#332, mocked)', () => {
  test('starts a written goal with working defaults and no configuration choices', async ({
    page,
  }) => {
    const commands: Record<string, unknown>[] = [];
    await mockTaskFirstHome(page, { commands });
    await page.goto('/');
    const prompt = 'Reply exactly GOAL READY. Use no tools.';
    // With work on the page Home's start composer is the compact one, and
    // its Agent chip names the Agent and Model Start will run on. What it
    // advertises is what the started chat runs on, read back below.
    const form = page.getByRole('form', { name: 'Start work' });
    await expect(form).toHaveClass(/start-composer--compact/);
    const start = form.getByRole('button', { name: 'Start', exact: true });
    const advertised = form.getByRole('button', {
      name: 'Agent: Codex · gpt-5.3-codex',
      exact: true,
    });
    await expect(advertised).toBeVisible();
    // The composer is Home's only start: no second "New chat" beside it.
    await expect(
      form.getByRole('button', { name: 'New chat', exact: true }),
    ).toHaveCount(0);
    const [advertisedAgent, advertisedModel] = (
      (await advertised.getAttribute('aria-label')) ?? ''
    )
      .replace(/^Agent: /, '')
      .split(' · ');
    await page
      .getByRole('textbox', { name: 'What would you like done?' })
      .fill(prompt);
    await start.click();
    await expect
      .poll(() =>
        commands.some((command) => command.type === 'sendExecutionMessage'),
      )
      .toBe(true);
    const sent = commands.find(
      (command) => command.type === 'sendExecutionMessage',
    );
    expect(sent?.input).toMatchObject({
      message: prompt,
      target: { agent: 'codex-agent' },
    });
    await expect(
      page.getByRole('dialog', { name: 'New chat', exact: true }),
    ).toHaveCount(0);
    // The started chat's own Agent and Model controls name the advertised
    // ones.
    await expectStartedChatRuns(page, prompt, advertisedAgent, advertisedModel);
    // No project is bound to the dock, so the chat names no workspace: the
    // global context the advertised identity was resolved in.
    expect(
      (sent?.input as { target?: { workspace?: unknown } } | undefined)?.target
        ?.workspace,
    ).toBeUndefined();
  });

  // #3312 review HIGH: once the user has opened a project, the dock is bound
  // to it and Start runs in that project's context, so its default Model
  // applies. Home must name that Model, not the global default it would
  // name for an unbound dock (`gpt-5.3-codex`, the agent default).
  test('names the project default Start runs on when the dock is bound to a project', async ({
    page,
  }) => {
    const commands: Record<string, unknown>[] = [];
    await mockTaskFirstHome(page, { commands, projectDefaultModel: 'gpt-5.4' });
    await page.addInitScript(() => {
      localStorage.setItem(
        'station-device-settings-v1',
        JSON.stringify({
          version: 2,
          values: { chatDockProjectSlug: 'station' },
        }),
      );
    });
    await page.goto('/');
    const prompt = 'Reply exactly PROJECT READY. Use no tools.';
    const form = page.getByRole('form', { name: 'Start work' });
    const start = form.getByRole('button', { name: 'Start', exact: true });
    // Both chips name what Start uses: the bound project and its default.
    await expect(
      form.getByRole('button', { name: 'Project: Station', exact: true }),
    ).toBeVisible();
    await expect(
      form.getByRole('button', {
        name: 'Agent: Codex · gpt-5.4',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: 'What would you like done?' })
      .fill(prompt);
    await start.click();
    await expect
      .poll(() =>
        commands.some((command) => command.type === 'sendExecutionMessage'),
      )
      .toBe(true);
    const sent = commands.find(
      (command) => command.type === 'sendExecutionMessage',
    );
    expect(sent?.input).toMatchObject({
      message: prompt,
      target: {
        agent: 'codex-agent',
        model: { override: 'gpt-5.4' },
        workspace: { kind: 'project', projectSlug: 'station' },
      },
    });
    await expectStartedChatRuns(page, prompt, 'Codex', 'gpt-5.4');
  });

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
    // event stays wired, and the project page's "New here?" CTA is now its
    // caller (`requestProjectChat`), but nothing on THIS route dispatches
    // it. Reroute through the dock's "New chat" action, which opens the
    // start composer in its intentionally task-free "No project" state, then drive
    // the dock's own Maximize control explicitly — proving the maximize
    // transition through its real affordance instead of as a residual side
    // effect of the removed dispatch. Every downstream assertion below is
    // unchanged; only the entry step and the order of the first maximize
    // assertion (now after an explicit click, not implicit) moved.
    const { dialog: newChat } = await openNewChatDraft(page);
    await expect(
      newChat.getByRole('button', { name: 'Project: No project' }),
    ).toBeVisible();
    await newChat.press('Escape');
    await expect(newChat).toHaveCount(0);

    // "Maximize chat dock" / "Restore chat dock" left the UI in 6ff89e600
    // (#928 step 2, PR #992) — `git log -S` puts that well before this lane, and
    // both names are absent at its base — so this timed out ten lines before the
    // help-menu line #1552 D1 had to retarget, and that retarget could not be
    // verified until this was current. The control is the same one; only its
    // name moved to the region vocabulary.
    const maximize = page.getByRole('button', {
      name: 'Expand dock region to workspace',
    });
    const restore = page.getByRole('button', {
      name: 'Restore dock region size',
    });
    await maximize.click();
    await expect(page.locator('.chat-dock')).toHaveClass(/is-maximized/);
    expect(new URL(page.url()).searchParams.get('maximize')).toBe('true');
    await restore.click();
    await expect(page.locator('.chat-dock')).not.toHaveClass(/is-maximized/);
    await maximize.click();
    await expect(page.locator('.chat-dock')).toHaveClass(/is-maximized/);
    await restore.click();

    await page.goto('/projects/station');
    // #1552 D1: "Ask Station for help" is a row of the avatar's menu now, not a
    // toolbar button. The prompt list it opens is unchanged.
    await page.getByRole('button', { name: 'Profile and settings' }).click();
    await page.getByRole('menuitem', { name: 'Ask Station for help' }).click();
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

  test('carries a provider/model chosen in the draft through Send', async ({
    page,
  }) => {
    const commands: Array<Record<string, unknown>> = [];
    await mockTaskFirstHome(page, { commands });
    await mockStationModelProviders(page);
    await page.goto('/');
    // Choosing a Model in the New chat draft never starts an engine (#3201):
    // the choice rides along with Send.
    const opened = await openProjectDraft(page);
    const { draft } = opened;

    // The draft's Agent chip names the Agent and Model; the provider is read
    // in the picker's selection and, after Start, on the dock's qualified
    // chip. The picker is the Agent list's Model control for that Agent.
    const agentChip = draft.getByRole('button', {
      name: 'Agent: Station Agent · Shared model',
      exact: true,
    });
    await expect(agentChip).toBeVisible();
    const openPicker = async () => {
      const picker = await openComposerModelPicker(page, draft);
      // The provider filter persists across openings; press it only once.
      const filter = picker.getByRole('button', {
        name: 'Bedrock · Prod',
        exact: true,
      });
      if ((await filter.getAttribute('aria-pressed')) !== 'true')
        await filter.click();
      return picker;
    };
    // Choosing or resetting a Model closes the draft's picker, as the dock's
    // in-chat picker does, and focus returns to the Agent chip (the Agent
    // list closed for the picker; the first opening also loads the picker
    // chunk behind a loading frame, which must not take the return target
    // with it).
    const expectPickerClosed = async (picker: Locator) => {
      await expect(picker).toHaveCount(0);
      await expect(
        draft.getByRole('button', { name: /^Agent: / }),
      ).toBeFocused();
    };
    const bedrockOption = (picker: Locator) =>
      picker.getByRole('option', { name: /Bedrock · Prod · shared-model/ });

    const picker = await openPicker();
    // The draft offers only providers this Agent can use; the provider the
    // dock's in-chat picker lists as disabled is not offered at all.
    await expect(
      picker.getByRole('button', { name: 'LiteLLM · Local' }),
    ).toHaveCount(0);
    await expect(bedrockOption(picker)).toHaveAttribute(
      'aria-selected',
      'false',
    );
    await bedrockOption(picker).click();
    await expectPickerClosed(picker);
    expect(commands).toEqual([]);

    const chosen = await openPicker();
    await expect(bedrockOption(chosen)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The reset names the default it restores, never the choice it clears
    // ("Use session override"): here, the Agent's default.
    await chosen
      .getByRole('button', { name: 'Use agent default', exact: true })
      .click();
    await expectPickerClosed(chosen);

    const cleared = await openPicker();
    await expect(bedrockOption(cleared)).toHaveAttribute(
      'aria-selected',
      'false',
    );
    await bedrockOption(cleared).click();
    await expectPickerClosed(cleared);

    // A Model chosen on the chip is remembered (owner decision): the chip
    // still names it after the picker closed.
    await expect(agentChip).toBeVisible();
    // Start: the chosen provider/model is what the engine is asked to use,
    // and the dock's chat carries it under its provider-qualified name.
    await sendDraft(opened, 'Send with the chosen model.');
    await expect
      .poll(() =>
        commands.some((command) => command.type === 'sendExecutionMessage'),
      )
      .toBe(true);
    expect(
      commands.find((command) => command.type === 'sendExecutionMessage')
        ?.input,
    ).toMatchObject({
      message: 'Send with the chosen model.',
      target: {
        agent: 'codex-agent',
        model: { override: 'shared-model' },
        workspace: { kind: 'project', projectSlug: 'station' },
      },
    });
    await expect(
      page.getByRole('button', {
        name: /Model: Bedrock · Prod — Shared model/,
      }),
    ).toBeVisible();
  });

  test('switches an exact provider/model from the composer and restores focus', async ({
    page,
  }) => {
    await installMockOrchestrationSse(page);
    await mockTaskFirstHome(page);
    await mockStationModelProviders(page);
    await page.goto('/');
    await startProjectTask(page, { settle: true });

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
    // With work on the page Home leads with the start form and the work; the
    // "What's next?" heading is an empty Station's (design round 2026-10, V1).
    await expect(page.getByRole('form', { name: 'Start work' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: "What's next?" }),
    ).toHaveCount(0);
    // The card is labelled exactly "Continue", and it is the work row itself,
    // reading like the inbox's: the work's agent and project (owner, 2026-10).
    const continueCard = page.getByRole('region', {
      name: 'Continue',
      exact: true,
    });
    const continuation = continueCard.getByRole('button', {
      name: 'Worker task · task first home, station',
      exact: true,
    });
    await expect(continuation).toBeVisible();
    await expect(continueCard).toContainText('Codex · station');
    // With work on the page the start composer is the compact one: no
    // "Using …" caption (design round 2026-10, V1); the Agent chip names
    // what Start will use. It is the one the dock's draft opens with,
    // asserted below. Home has no second "New chat" start.
    const homeComposer = page.getByRole('form', { name: 'Start work' });
    await expect(homeComposer).toHaveClass(/start-composer--compact/);
    const advertised = homeComposer.getByRole('button', {
      name: 'Agent: Codex · gpt-5.3-codex',
      exact: true,
    });
    await expect(advertised).toBeVisible();
    await expect(page.getByText(/^Using /)).toHaveCount(0);
    await expect(
      page
        .locator('.home-view')
        .getByRole('button', { name: 'New chat', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Open local project/i }),
    ).toBeVisible();
    await expect(page.getByText('Default Model')).toHaveCount(0);

    // A desktop continuation of project work opens the chat where it lives,
    // the project's Coding layout, with that chat active (design round
    // 2026-10, U1); only project-less work stays in the dock.
    await continuation.click();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe('/projects/station/layouts/coding');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('chat'))
      .toBe('task-first-home');
    // And the Coding layout's Chat shows that chat: its inbox row is the
    // current one, not merely named in the URL.
    const codingChat = page.getByRole('region', { name: 'Chat', exact: true });
    await expect(
      codingChat.getByRole('button', {
        name: 'Worker task · task first home, station',
        exact: true,
      }),
    ).toHaveAttribute('aria-current', 'true');

    // Back on Home with the dock open and no chat in it.
    await page.goto('/?dock=open');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('chat'))
      .toBeNull();
    await expect(page.getByText('No chat open')).toBeVisible();

    // The selection Home's chips name is the one the dock's draft opens
    // with: the same chips, the same words. Opening the project's work bound
    // the dock to it, so both now open on Station.
    await expect(advertised).toBeVisible();
    await expect(
      homeComposer.getByRole('button', {
        name: 'Project: Station',
        exact: true,
      }),
    ).toBeVisible();
    const { dialog, draft } = await openNewChatDraft(page);
    await expect(
      draft.getByRole('button', {
        name: 'Agent: Codex · gpt-5.3-codex',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      draft.getByRole('button', { name: 'Project: Station', exact: true }),
    ).toBeVisible();
    await dialog.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: /Open local project/i }).click();
    await expect(
      page.getByRole('heading', { name: 'New Project' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Close new project', exact: true })
      .click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('chat'))
      .toBeNull();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('dock'))
      .toBe('open');

    // station#settings-revamp slice 5: the dead `/providers` alias is
    // removed — use the canonical connections/models deep link instead.
    //
    // #2059: Connections left the panel for Settings' Manage group, so the
    // panel no longer highlights it — the panel lists places, and the row
    // that used to wear `sidebar__nav-btn--active` here is gone. What this
    // still proves is the round trip: the canonical deep link resolves, and
    // the advertised control reaches the same route from a cold start.
    await page.goto('/connections/providers');
    await expect(page).toHaveURL(/\/connections\/models/);
    await expect(
      page
        .getByRole('navigation', { name: 'Primary navigation' })
        .getByRole('button', { name: 'Connections', exact: true }),
    ).toHaveCount(0);
    // The advertised path from here is the footer's gear into Settings'
    // Manage group. It is proven by pressing it in the two suites whose
    // fixtures model the Settings page — project-architecture.spec.ts
    // ("connections view renders") and registry.spec.ts — rather than here:
    // `mockTaskFirstHome` models Home, and routing this test through Settings
    // made it issue five API reads the fixture has no shape for, which is the
    // audit failure this comment replaces rather than papers over.
    await page.goto('/');
    await expect(
      page
        .getByRole('navigation', { name: 'Primary navigation' })
        .getByRole('button', { name: 'Settings', exact: true }),
    ).toBeVisible();
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

    const opened = await openNewChatDraft(page);
    await expect(
      opened.draft.getByRole('button', { name: 'Project: No project' }),
    ).toBeVisible();
    await sendDraft(opened, 'Start a direct chat.');
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
    await installMockOrchestrationSse(page);
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
            providerTurnId: 'task-first-home-start',
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
    const stageId = 'stage_task-first-home-launcher-context';
    let prepared: Record<string, unknown> | undefined;
    await page.route(
      /\/api\/orchestration\/attachment-staging(?:\/.*)?$/u,
      async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/capability'))
          return route.fulfill(
            rawJson({
              state: 'supported',
              version: 1,
              maxConcurrentUploads: 3,
            }),
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
    await startProjectTask(page, { settle: true });

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
    await expect(page.locator('.chat-dock textarea')).toHaveValue('');
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
    await installMockOrchestrationSse(page);
    await mockTaskFirstHome(page);
    await page.goto('/');
    await startProjectTask(page, { settle: true });

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
    await expect(page.locator('.chat-dock textarea')).toBeVisible();

    // Task context replaces the files panel beside the same usable chat.
    await actionsMenuTrigger.click();
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitemcheckbox', { name: 'Task context' }).click();
    const context = page.getByRole('complementary', { name: 'Task context' });
    await expect(context).toContainText('feat/contextual-active-work');
    await expect(context).toContainText('Checks');
    await expect(context).toContainText('Unavailable');
    await expect(page.locator('.chat-dock textarea')).toBeVisible();

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

    // A changed file opens in the editor route, where the same chat's
    // composer is still the usable surface.
    await actionsMenuTrigger.click();
    await expect(menu).toBeVisible();
    await filesTrigger.click();
    // The opened file's pane reads its changes against HEAD (#3365). Wait
    // for that read so the test, not teardown timing, decides it ran.
    const changesRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          '/api/projects/station/file-preview/changes' &&
        response.request().method() === 'POST',
    );
    await page
      .getByRole('button', { name: 'Open src-ui/src/App.tsx in editor' })
      .click();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe('/projects/station/layouts/coding');
    expect(new URL(page.url()).searchParams.get('previewPath')).toBe(
      'src-ui/src/App.tsx',
    );
    const changes = await changesRead;
    expect(changes.status()).toBe(200);
    // The pane asked for the file it opened.
    expect(changes.request().postDataJSON()).toMatchObject({
      path: 'src-ui/src/App.tsx',
    });
    // The opened preview shows the file and consumed the read: the Changes
    // toggle counts the declared patch's one changed line.
    await expect(page.getByText('export function App() {}')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Changes vs HEAD, 1 changed line' }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: /^Type a message/ }),
    ).toBeVisible();
  });

  // #1180: the Activity surface is one of the places where `SplitPaneLayout`'s
  // mobile detail sheet marks the frame around it `inert` (PageFrame.tsx:155)
  // while it is open. (station#928 retired the `/activity` route; the surface
  // is reached by its canonical deep link, which is what this navigates to.) `DelegationLauncher` is a hand-rolled overlay (no
  // `ResponsiveDialogSurface`), rendered as a plain sibling of
  // `SplitPaneLayout` in `SessionsView`. Its own trigger ("Delegate subtask")
  // lives in the list pane, which a phone hides the instant a session's
  // mobile detail sheet is showing — so opening it AFTER a session is already
  // selected on a phone is not reachable through the UI at all. The
  // realistic ordering is the other way around: select the session and open
  // the launcher while both panes are still visible (desktop — `SessionsView`
  // selection is local state, not a URL/route change, so nothing here
  // replays the route's entrance), then cross the mobile breakpoint
  // underneath both of them — a window resize, a foldable rotation, or a
  // narrowed split view all flip `useIsMobile()` the same way. The launcher's
  // own state survives that (nothing about routing changed); `PageFrame`
  // marking the frame `inert` is what used to trap it.
  test('the delegation launcher survives crossing the mobile breakpoint underneath it', async ({
    page,
  }) => {
    await installVisualViewportFixture(page);
    await mockTaskFirstHome(page);
    await page.goto('/?surface=activity');
    await page
      .getByRole('region', { name: 'Activity', exact: true })
      .getByRole('button', { name: 'Expand dock region to workspace' })
      .click();

    const row = page.locator('.split-pane__item-row').filter({
      has: page.getByRole('button', { name: /^Worker task · task first home/ }),
    });
    // A delegated row's "Delegate subtask…" lives in its row menu, opened
    // from the list (in a maximized dock, selecting the row swaps the list
    // for its detail).
    await row.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Delegate subtask…' }).click();
    const launcher = page.getByRole('dialog', { name: 'Delegate a task' });
    await expect(launcher).toBeVisible();
    await expect(launcher.getByLabel('Task')).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(launcher).toBeVisible();

    // `SplitPaneLayout` deliberately moves focus to its own "Back to list"
    // button the instant its mobile sheet opens (a11y for the newly shown
    // surface) — so focus right after the resize tells us nothing about this
    // dialog. The real question is whether the ALREADY-OPEN launcher can
    // still take focus back: unlike `ResponsiveDialogSurface`, this hand-rolled
    // overlay has no effect that re-asserts focus when `isMobile` flips, so an
    // explicit `.focus()` call is what proves (or disproves) reachability —
    // `.focus()` on an element inside an `inert` ancestor is called and
    // silently does nothing, exactly the symptom #1131's investigation named.
    await launcher.getByLabel('Task').focus();
    await expect(launcher.getByLabel('Task')).toBeFocused();
    await launcher.getByRole('button', { name: 'Cancel' }).click();
    await expect(launcher).toHaveCount(0);
  });

  test.describe('Pixel 7', () => {
    const { defaultBrowserType: _defaultBrowserType, ...pixel7 } =
      devices['Pixel 7'];
    test.use(pixel7);

    test('keeps provider/model selection contained and touch-friendly', async ({
      page,
    }) => {
      const expectContainedAndTouchFriendly = async (picker: Locator) => {
        await expect(
          picker.getByRole('button', { name: 'Close model picker' }),
        ).toBeFocused();
        for (const name of ['★ Favorites', 'All', 'Bedrock · Prod']) {
          const bounds = await picker
            .getByRole('button', { name })
            .boundingBox();
          expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(
            MIN_TOUCH_TARGET_PX,
          );
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
      };

      await installMockOrchestrationSse(page);
      await mockTaskFirstHome(page);
      await mockStationModelProviders(page);
      await page.goto('/');

      // The picker is first reached from the draft's Agent list, that
      // Agent's Model control.
      const opened = await openProjectDraft(page);
      const draftPicker = await openComposerModelPicker(page, opened.draft);
      await expectContainedAndTouchFriendly(draftPicker);
      await draftPicker
        .getByRole('button', { name: 'Close model picker' })
        .click();
      await expect(draftPicker).toHaveCount(0);

      // After Send it is reached from the dock composer's Model control, and
      // closing it returns focus there.
      await sendDraft(opened, 'Start the project task.');
      await completeStartedTurn(page, 'Start the project task.');
      const modelButton = page.getByRole('button', {
        name: /Model: Codex · Work — Shared model/,
      });
      await modelButton.click();
      const picker = page.getByRole('dialog', { name: 'Choose model' });
      await expect(picker).toBeVisible();
      await expectContainedAndTouchFriendly(picker);
      await picker.getByRole('button', { name: 'Close model picker' }).click();
      await expect(modelButton).toBeFocused();
    });

    // #2059 (design record D3): the mobile drawer lists PLACES, and the
    // configuration destinations it used to group under `Customize`/`System`
    // are behind the footer's gear. This is the same accessibility contract as
    // before — every advertised navigation control a thumb must hit clears the
    // 44px floor, and nothing overflows the viewport horizontally — re-aimed
    // at the surfaces that carry it now rather than deleted with the groups.
    test('lists places in the mobile drawer and reaches configuration through a touch-safe footer', async ({
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

      // The panel's rows: Home and Activity, both at the touch floor.
      // `exact` because the drawer header's own control is "Station home",
      // which a substring match also resolves.
      for (const label of ['Home', 'Activity', 'Schedule', 'Customize']) {
        const item = navigation.getByRole('button', {
          name: label,
          exact: true,
        });
        await expect(item).toBeVisible();
        expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(
          MIN_TOUCH_TARGET_PX,
        );
      }

      // Neither group header survives, and neither do the rows they held.
      for (const gone of [
        'System',
        'Agents',
        'Connections',
        'Skills',
        'Registry',
        'Plugins',
        'Developer',
      ]) {
        await expect(
          navigation.getByRole('button', { name: gone, exact: true }),
        ).toHaveCount(0);
      }

      // The footer's two navigation controls are the drawer's only remaining
      // destination affordances, so they carry the floor the rows used to.
      for (const label of ['Schedule', 'Customize', 'Settings']) {
        const control = navigation.getByRole('button', { name: label });
        await expect(control).toBeVisible();
        const box = (await control.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(box.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      }

      // The Manage group the gear lands on carries the other half of this
      // contract — its entries are thumb-sized too — and it is asserted in
      // settings.spec.ts, whose fixture models the Settings page. This one
      // owns the drawer.

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
        page.getByRole('button', { name: 'Personalize Station' }),
      ).toBeVisible();
      await expect(page.locator('.sidebar')).not.toBeVisible();
      await page.getByRole('button', { name: 'Toggle menu' }).click();
      await expect(page.locator('.sidebar--expanded')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Home', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Home', exact: true }).click();

      await sendDraft(await openNewChatDraft(page), 'Start from a phone.');
      await expect(page.locator('.chat-dock')).toBeVisible();
      await page.getByRole('button', { name: 'Chat actions' }).click();
      await page
        .getByRole('menu', { name: 'Chat actions' })
        .getByRole('menuitem', { name: 'Full screen', exact: true })
        .click();
      await expect(page.locator('.chat-dock')).toHaveClass(/is-maximized/);
      await expect(page.locator('.chat-dock textarea')).toBeVisible();
      await page.evaluate(() =>
        (window as any).__setTaskFirstViewport(520, 260),
      );
      await expect(page.locator('.chat-dock')).toBeVisible();
      await page.getByRole('button', { name: 'Chat actions' }).click();
      await page
        .getByRole('menu', { name: 'Chat actions' })
        .getByRole('menuitem', { name: 'Exit full screen', exact: true })
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
      await page.goto('/?surface=activity&session=task-first-home');

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
      const continueButton = page
        .getByTestId('session-detail')
        .getByRole('button', { name: 'Send', exact: true });
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
      await page.goto('/?surface=activity&session=task-first-home');

      // Project workflows are evidence: they live in the detail's collapsed
      // Details disclosure, which the reader opens.
      const detail = page.getByTestId('session-detail');
      await detail.locator('summary', { hasText: /^Details$/ }).click();
      const statusLine = detail
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

    test('offers Delegate subtask from the mobile row menu with touch-sized targets, then opens detail', async ({
      page,
    }) => {
      await mockTaskFirstHome(page);
      await page.goto('/?surface=activity');

      // The delegated row's own controls: the row itself and its one "⋯"
      // menu, whose items include "Delegate subtask…".
      const rowButton = page.getByRole('button', {
        name: /^Worker task · task first home/,
      });
      await expect(rowButton).toBeVisible();
      await expect(rowButton).toContainText('Delegated worker');
      const menuTrigger = page
        .locator('.split-pane__item-row')
        .filter({ has: rowButton })
        .getByRole('button', { name: 'More actions' });
      await menuTrigger.click();
      const delegate = page.getByRole('menuitem', {
        name: 'Delegate subtask…',
      });
      for (const control of [menuTrigger, delegate]) {
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
        expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      }

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
      await expect(menuTrigger).toBeFocused();

      await rowButton.click();
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
      await installMockOrchestrationSse(page);
      await mockTaskFirstHome(page);
      await page.goto('/');
      await startProjectTask(page, { settle: true });

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
      // `.active-work-frame__sheet` opts into the shared
      // `responsive-surface-panel-enter` entrance keyframe (index.css) —
      // opacity 0->1 and `translateY(4px)->translateY(0)` over
      // `--motion-base` (200ms, not reduced here). `translateY` shifts the
      // rendered box without touching layout, so a rect read mid-animation
      // reports up to 4px more than the sheet's settled position — measured
      // live: bottom landed ~2.5-3.6px past the visual-viewport edge this
      // assertion checks, purely from catching the animation in flight, and
      // exactly 0px past it once settled (3/3 clean runs). Wait on the real
      // `Animation.finished` promises rather than a fixed sleep, so this
      // holds regardless of `--motion-base`'s value and never trips the E2E
      // audit's fixed-sleep pattern (see the identical wait in
      // banner-stack-bound.spec.ts).
      await dialog.evaluate((element) =>
        Promise.all(element.getAnimations().map((a) => a.finished)).catch(
          () => undefined,
        ),
      );
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
      await expect(page.locator('.chat-dock textarea')).toBeVisible();

      await page.getByRole('button', { name: 'Chat actions' }).click();
      await page
        .getByRole('menu', { name: 'Chat actions' })
        .getByRole('menuitem', { name: 'Full screen', exact: true })
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
      // archive#869/#939: a maximized dock is opaque and full-height, so navigating
      // used to change the view *underneath* it and nothing moved. A real
      // pathname change now returns the dock to its docked size, which drops
      // `maximize` from the URL. On a phone, leaving Chat for another route
      // then collapses the dock entirely (`shouldCollapseDockOnMobileNavigation`:
      // a half-open sheet over the next route is the desktop overlay leaking
      // onto a destination), so the destination is reached with the dock
      // collapsed rather than open — this spec asserted `dock=open` here.
      expect(projectUrl.searchParams.get('maximize')).toBeNull();
      await expect(page.locator('.chat-dock')).not.toHaveClass(/is-maximized/);
      await expect(page.locator('.chat-dock')).toHaveClass(/is-collapsed/);
      // Collapse and expand live on the header's toggle (the actions sheet
      // keeps only the named, reversible Full screen entry).
      await page.getByRole('button', { name: 'Expand chat' }).click();
      await expect(page.locator('.chat-dock')).not.toHaveClass(/is-collapsed/);
      await page.getByRole('button', { name: 'Chat actions' }).click();
      const dockMenu = page.getByRole('menu', { name: 'Chat actions' });
      await expect(
        dockMenu.getByRole('menuitem', { name: 'Full screen', exact: true }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Collapse chat' }).click();
      await expect(page.locator('.chat-dock')).toHaveClass(/is-collapsed/);
      await page.getByRole('button', { name: 'Chat actions' }).click();
      await page
        .getByRole('menu', { name: 'Chat actions' })
        .getByRole('menuitem', { name: 'Full screen', exact: true })
        .click();
      await expect(page.locator('.chat-dock')).not.toHaveClass(/is-collapsed/);
      await expect(page.locator('.chat-dock')).toHaveClass(/is-maximized/);
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

test('profiles Home with substantial session history', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installJourneyProfile(page);
  await mockTaskFirstHome(page, { historyCount: 1000 });
  await profileJourney(
    page,
    testInfo,
    'home-history',
    { sessions: 1000 },
    async () => {
      const response = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          '/api/orchestration/sessions/read-model',
      );
      await page.goto('/');
      expect((await (await response).json()).data).toHaveLength(1000);
      await expect(
        page.getByRole('form', { name: 'Start work' }),
      ).toBeVisible();
      await expect(
        page.getByText('History session 0', { exact: true }).first(),
      ).toBeVisible();
    },
  );
});
