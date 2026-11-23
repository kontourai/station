import { constants, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { AGENT_NOTIFICATION_CATEGORIES } from '@kontourai/station-contracts/notification';
import {
  defaultNotificationPreferences,
  NOTIFICATION_PREFERENCES_PATH,
} from '@kontourai/station-contracts/notification-preferences';
import {
  expect,
  type Locator,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  DEFAULT_CONVERSATION_LOOKUPS,
  DEFAULT_CONVERSATIONS,
  DEV_CONFIG,
  dismissSetupLauncher,
  installMockOrchestrationConversationEventWindow,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  seedOrchestrationRoutes,
  waitForMockOrchestrationSse,
} from './helpers/orchestration';
import { fulfillStationShellRead } from './helpers/station-shell-fixtures';

/**
 * A conversation opened from the notification panel while the dock shows
 * another: the dock names what is opening and covers the previous one, a
 * refused conversation says why, and an imported conversation keeps its own
 * header and Continue over the pending open.
 */

const PHONE = { width: 390, height: 844 } as const;
const DESKTOP = { width: 1440, height: 900 } as const;
const NOW = '2026-11-16T12:00:00.000Z';
const LATER = '2026-11-16T12:00:01.000Z';
const ATTACHED = 'external:claude:notification-reader';
const IMPORTED_TITLE = 'Imported design notes';

const turn = (
  threadId: string,
  provider: string,
  prompt: string,
  reply: string,
) => [
  {
    method: 'turn.started',
    provider,
    threadId,
    turnId: `${threadId}-turn`,
    createdAt: NOW,
    prompt,
  },
  {
    method: 'turn.completed',
    provider,
    threadId,
    turnId: `${threadId}-turn`,
    createdAt: LATER,
    outputText: reply,
  },
];

const ownedSession = (threadId: string) => ({
  threadId,
  provider: 'codex',
  status: 'ready',
  lifecycleState: 'idle',
  hasActiveTurn: false,
  controlMode: 'station-owned',
  answerability: { answerable: true },
  isLoaded: true,
  isPersisted: true,
  eventCount: 2,
  createdAt: NOW,
  updatedAt: LATER,
});

// The attached-session summary shape conversation-surfaces.spec.ts uses.
const attachedSession = {
  threadId: ATTACHED,
  provider: 'claude',
  displayTitle: IMPORTED_TITLE,
  controlMode: 'read-only-attached',
  status: 'ready',
  lifecycleState: 'idle',
  hasActiveTurn: false,
  answerability: { answerable: true },
  attachedSource: {
    kind: 'claude-transcript',
    externalSessionId: 'notification-reader',
    affinity: { kind: 'fixture-home', ref: 'notification-home' },
  },
  isLoaded: true,
  isPersisted: true,
  eventCount: 2,
  createdAt: NOW,
  updatedAt: LATER,
  projectSlug: 'dev',
};

// The station feed record (notifications-inbox.spec.ts) with the session
// target turn-completion-notifications.ts writes; Open marks its chat.
const notification = (id: string, title: string, sessionId: string) => ({
  id,
  source: 'orchestration',
  category: 'turn-finished',
  title,
  priority: 'normal',
  status: 'delivered',
  createdAt: NOW,
  updatedAt: NOW,
  metadata: {
    envelope: {
      v: 1,
      source: { kind: 'system', subsystem: 'orchestration' },
      audience: { kind: 'owner' },
      urgency: 'done',
      target: { kind: 'session', sessionId },
      interrupt: 'default',
    },
  },
});
const NOTIFICATIONS = [
  notification('n-open', 'Finished: Release notes', 'conv-2'),
  notification('n-refused', 'Finished: Private review', 'conv-3'),
];

// The record AgentNotificationGate writes when notify_user names a link
// (agent-notification-gate.ts): an agent source, a path target, the link.
const AGENT_LINK = '/?chat=conv-3&dock=open';
const AGENT_LINKED = {
  id: 'n-agent-link',
  source: 'agent',
  category: AGENT_NOTIFICATION_CATEGORIES.attention,
  title: 'Review the private notes',
  priority: 'high',
  status: 'delivered',
  createdAt: NOW,
  updatedAt: NOW,
  metadata: {
    projectSlug: 'dev',
    link: AGENT_LINK,
    envelope: {
      v: 1,
      source: {
        kind: 'agent',
        sessionId: 'session-1',
        projectId: DEV_CONFIG.id,
        agent: 'dev-agent',
        conversationId: 'conv-1',
        assurance: 'bound',
      },
      audience: { kind: 'session-readers', sessionId: 'session-1' },
      urgency: 'attention',
      target: { kind: 'path', path: AGENT_LINK },
      interrupt: 'default',
    },
  },
};

const json = (route: Route, data: unknown, status = 200) =>
  route.fulfill({ status, json: { success: status < 400, data } });

// Instance reads every page makes at boot, answered by the runner's Station.
const STATION_BOOTSTRAP = new Set([
  'GET /api/boot',
  'GET /api/auth/authority',
  'GET /api/settings/managed-policy',
  'GET /api/usage-telemetry/status',
  'GET /api/usage-telemetry/disclosure',
  'GET /api/plugins',
  'GET /api/plugins/home-role',
  'GET /api/system/capabilities',
  'GET /api/system/skills',
  'GET /api/system/core-update',
  'GET /api/connections/agents',
  'GET /api/models',
  'GET /api/me/layouts',
  'GET /api/me/appearance',
  'GET /api/feature-previews',
  'GET /api/environments/ssh',
  'GET /api/environments/peers',
  'GET /api/projects/run-locations',
  'GET /api/orchestration/work-claims',
  'GET /api/tasks',
  'POST /api/presence/focus',
  'GET /acp/connections',
  'GET /config/app',
]);

const SESSION_OF: Record<string, string> = {
  'conv-1': 'session-1',
  'conv-2': 'session-2',
};
const PROMPT_OF: Record<string, string> = {
  'session-1': 'Check the first chat',
  'session-2': 'Draft the release notes',
};

/** The seeded conversations' own reads, in each route's envelope. */
async function fulfillConversationRead(route: Route): Promise<boolean> {
  if (route.request().method() !== 'GET') return false;
  const url = new URL(route.request().url());
  const path = url.pathname;
  let match: RegExpMatchArray | null;
  // orchestration.ts GET /sessions/:threadId/checkpoints: none recorded.
  if (
    /^\/api\/orchestration\/sessions\/session-[12]\/checkpoints$/.test(path)
  ) {
    await json(route, []);
    return true;
  }
  // orchestration.ts GET /conversations/:id/inbox; thread-inbox.ts currentHead.
  if (
    (match = path.match(
      /^\/api\/orchestration\/conversations\/(conv-[12])\/inbox$/,
    ))
  ) {
    await json(route, {
      currentHead: JSON.stringify([SESSION_OF[match[1]], 2]),
      entries: [],
    });
    return true;
  }
  // session-project-activity.ts GET /:sessionId/turn-directory, one turn.
  if (
    (match = path.match(
      /^\/api\/orchestration\/session-reads\/(conv-[12])\/turn-directory$/,
    ))
  ) {
    const sessionId = SESSION_OF[match[1]];
    await json(route, {
      session: {
        conversationId: match[1],
        ...(url.searchParams.get('includeCount') === 'false'
          ? {}
          : { turnCount: 1 }),
      },
      turns: [
        {
          turnId: `${sessionId}-turn`,
          startedAt: NOW,
          request: PROMPT_OF[sessionId],
          outcome: 'completed',
        },
      ],
      nextCursor: null,
    });
    return true;
  }
  // agent-schedule.ts GET /agent-schedule/:conversationId: nothing scheduled.
  if (/^\/api\/orchestration\/agent-schedule\/conv-[12]$/.test(path)) {
    await json(route, { wakeUps: [], jobProposals: [], jobs: [] });
    return true;
  }
  // mcp-prompts.ts GET /:slug/mcp-prompts: the fixture agent has no MCP server.
  if (path === '/agents/dev-agent/mcp-prompts') {
    await json(route, { prompts: [], unavailable: [] });
    return true;
  }
  // orchestration.ts GET /sessions/:threadId/turns/:turnId/basis: none kept.
  if (
    /^\/api\/orchestration\/sessions\/session-[12]\/turns\/[^/]+\/basis$/.test(
      path,
    )
  ) {
    await route.fulfill({
      status: 404,
      json: { success: false, error: 'Basis not found' },
    });
    return true;
  }
  // orchestration.ts GET /sessions/:threadId/inventory (the Inbox hover card):
  // no inventory is kept for these sessions here.
  if (
    [
      `/api/orchestration/sessions/${encodeURIComponent(ATTACHED)}/inventory`,
      '/api/orchestration/sessions/session-1/inventory',
    ].includes(path) &&
    url.search === '?scope=whole-session'
  ) {
    await route.fulfill({
      status: 404,
      headers: { 'Cache-Control': 'private, no-store' },
      json: { success: false, error: 'Session inventory unavailable' },
    });
    return true;
  }
  // conversations.ts GET /:slug/conversations/:id/stats; usage not measured.
  if (
    (match = path.match(
      /^\/agents\/dev-agent\/conversations\/(conv-[12])\/stats$/,
    ))
  ) {
    await json(route, {
      conversationId: match[1],
      modelId: 'claude-sonnet',
      turns: 1,
      toolCalls: 0,
    });
    return true;
  }
  // browser.ts GET /projects/:projectSlug/access and /sessions, as the shell
  // models them for its own Project.
  if (path === '/api/browser/projects/dev/access') {
    await json(route, {
      projectId: DEV_CONFIG.id,
      role: 'operator',
      principalKey: 'operator',
      operator: true,
      browser: 'not-ready',
    });
    return true;
  }
  if (
    path === '/api/browser/sessions' &&
    url.searchParams.get('projectSlug') === 'dev'
  ) {
    await json(route, []);
    return true;
  }
  // conversations.ts GET /:slug/conversations/:id/summary: none written.
  if (/^\/agents\/dev-agent\/conversations\/conv-[12]\/summary$/.test(path)) {
    await json(route, null);
    return true;
  }
  // projects.ts GET /:slug/chat-defaults; project-chat-defaults.ts view() for
  // a Project with no default selections and no recorded starts.
  if (path === '/api/projects/dev/chat-defaults') {
    await json(route, {
      version: 'station.project-chat-defaults/v1',
      projectSlug: 'dev',
      model: { selection: 'fixed', lastUsed: [] },
      approvalMode: { selection: 'fixed', resolved: { source: 'none' } },
    });
    return true;
  }
  // terminal-runs.ts GET /api/terminal/runs?conversationId=: none waiting.
  if (
    path === '/api/terminal/runs' &&
    /^conv-[12]$/.test(url.searchParams.get('conversationId') ?? '')
  ) {
    await json(route, { runs: [] });
    return true;
  }
  return false;
}

/** Lowest-precedence boundary: nothing unmodelled reaches the Station unseen. */
async function closeFixtureBoundary(page: Page, passedThrough: Set<string>) {
  await page.route(
    (url) =>
      /^\/(api|agents|acp)\//.test(url.pathname) ||
      url.pathname === '/config/app',
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const read = `${request.method()} ${path}`;
      if (STATION_BOOTSTRAP.has(read)) {
        passedThrough.add(read);
        return route.fallback();
      }
      if (await fulfillStationShellRead(route)) return;
      if (await fulfillConversationRead(route)) return;
      return rejectUnexpectedFixtureRequest(route);
    },
  );
}

async function seed(page: Page): Promise<Set<string>> {
  const passedThrough = new Set<string>();
  await closeFixtureBoundary(page, passedThrough);
  await installMockOrchestrationSse(page);
  await seedOrchestrationRoutes(page, {
    conversations: [
      ...DEFAULT_CONVERSATIONS,
      {
        id: 'conv-2',
        title: 'Release notes',
        createdAt: NOW,
        updatedAt: NOW,
        messageCount: 2,
      },
    ],
    conversationLookups: {
      ...DEFAULT_CONVERSATION_LOOKUPS,
      'conv-2': {
        id: 'conv-2',
        currentSessionId: 'session-2',
        agentSlug: 'dev-agent',
        projectSlug: 'dev',
        title: 'Release notes',
      },
    },
    // Without the server's execution binding the open reads as an unknown
    // replacement ("Couldn't check this chat").
    executionBySession: {
      'session-1': {
        sessionId: 'session-1',
        agentId: agentId('dev-agent'),
        provider: 'codex',
        engineConnectionId: 'codex',
        model: 'claude-sonnet',
      },
      'session-2': {
        sessionId: 'session-2',
        agentId: agentId('dev-agent'),
        provider: 'codex',
        engineConnectionId: 'codex',
        model: 'claude-sonnet',
      },
    },
  });
  await installMockOrchestrationEventWindow(page, 'codex', {
    'session-1': turn(
      'session-1',
      'codex',
      'Check the first chat',
      'The first chat stays readable.',
    ),
    'session-2': turn(
      'session-2',
      'codex',
      'Draft the release notes',
      'Release notes are ready.',
    ),
    [ATTACHED]: turn(
      ATTACHED,
      'claude',
      'Read the design notes',
      'The imported transcript is here.',
    ),
  });
  await installMockOrchestrationConversationEventWindow(page, (id) =>
    id === 'conv-1' ? ['session-1'] : id === 'conv-2' ? ['session-2'] : [],
  );
  // Newer routes are tried first, so these answer before the shared ones.
  await page.route(
    (url) => url.pathname === '/api/me/preferences',
    (route) =>
      route.request().method() === 'GET'
        ? json(route, { schemaVersion: 1, values: {} })
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) => url.pathname === '/api/orchestration/sessions/read-model',
    (route) =>
      route.request().method() === 'GET'
        ? json(route, [
            ownedSession('session-1'),
            ownedSession('session-2'),
            attachedSession,
          ])
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) =>
      url.pathname ===
      `/api/orchestration/sessions/${encodeURIComponent(ATTACHED)}`,
    (route) =>
      route.request().method() === 'GET'
        ? json(route, { session: attachedSession, events: [] })
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) => url.pathname === '/api/attention',
    (route) =>
      route.request().method() === 'GET'
        ? json(route, { items: [], pendingCount: 0 })
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) => url.pathname === '/notifications',
    (route) =>
      route.request().method() === 'GET'
        ? json(route, NOTIFICATIONS)
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) => /^\/notifications\/n-(open|refused)\/read$/.test(url.pathname),
    (route) =>
      route.request().method() === 'POST'
        ? json(route, { outcome: 'read' })
        : rejectUnexpectedFixtureRequest(route),
  );
  return passedThrough;
}

// Opt-in, caller-owned evidence directory, as replay-inspector.ts does: the
// runner removes a passing run's test-results, captures included.
const EVIDENCE_DIR = process.env.STATION_NOTIFICATION_DEEP_LINK_EVIDENCE_DIR;
if (EVIDENCE_DIR !== undefined && !isAbsolute(EVIDENCE_DIR))
  throw new Error(
    'STATION_NOTIFICATION_DEEP_LINK_EVIDENCE_DIR must be absolute',
  );

async function retain(testInfo: TestInfo, file: string) {
  await testInfo.attach(basename(file), { path: file });
  if (!EVIDENCE_DIR) return;
  const directory = join(
    EVIDENCE_DIR,
    testInfo.titlePath
      .slice(1)
      .join(' ')
      .replace(/[^a-z0-9-]+/gi, '-')
      .slice(0, 120),
  );
  await mkdir(directory, { recursive: true });
  await copyFile(
    file,
    join(directory, basename(file)),
    constants.COPYFILE_EXCL,
  );
}

/** The dock's lookup (useChatDockActiveChatSync → fetchConversationById) refused. */
async function refuseLookup(page: Page) {
  let reached!: () => void;
  const wasReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route(
    (url) => url.pathname === '/api/conversations/conv-3',
    (route) => {
      if (route.request().method() !== 'GET')
        return rejectUnexpectedFixtureRequest(route);
      reached();
      return route.fulfill({
        status: 403,
        json: { success: false, error: 'Forbidden' },
      });
    },
  );
  return { reached: wasReached };
}

/**
 * Adds the agent's linked record to the feed, its read mark, and the
 * preferences read its Mute actions make (notification-preferences.ts).
 */
async function offerAgentLink(page: Page) {
  await page.route(
    (url) => url.pathname === '/notifications',
    (route) =>
      route.request().method() === 'GET'
        ? json(route, [...NOTIFICATIONS, AGENT_LINKED])
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) => url.pathname === `/notifications/${AGENT_LINKED.id}/read`,
    (route) =>
      route.request().method() === 'POST'
        ? json(route, { outcome: 'read' })
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    (url) => url.pathname === NOTIFICATION_PREFERENCES_PATH,
    (route) =>
      route.request().method() === 'GET'
        ? json(route, defaultNotificationPreferences())
        : rejectUnexpectedFixtureRequest(route),
  );
}

// One refused open per producer that names the conversation: a finished
// turn's session target, and an agent's notify_user link.
const REFUSALS = [
  {
    name: 'a refused conversation says why and is dismissed from the keyboard',
    row: 'Finished: Private review',
    capture: 'refused',
    install: async (_page: Page) => {},
  },
  {
    name: 'an agent-linked refused conversation says why and is dismissed from the keyboard',
    row: AGENT_LINKED.title,
    capture: 'refused-agent-link',
    install: offerAgentLink,
  },
] as const;

/** Holds the dock's conv-2 lookup, which owns the opening state; always unrouted. */
async function holdLookup(page: Page) {
  let reached!: () => void;
  const wasReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const matches = (url: URL) => url.pathname === '/api/conversations/conv-2';
  const handler = async (route: Route) => {
    if (route.request().method() !== 'GET')
      return rejectUnexpectedFixtureRequest(route);
    reached();
    await released;
    await route.fallback();
  };
  await page.route(matches, handler);
  return {
    reached: wasReached,
    release,
    async dispose() {
      release();
      await page.unroute(matches, handler);
    },
  };
}

async function openFirstChat(page: Page) {
  await page.goto('/?dock=open&chat=conv-1');
  await dismissSetupLauncher(page);
  await waitForMockOrchestrationSse(page);
  await expect(
    page.getByRole('log', { name: 'Conversation transcript' }),
  ).toContainText('The first chat stays readable.');
}

async function openFromNotifications(
  page: Page,
  title: string,
  phone: boolean,
) {
  await page.getByRole('button', { name: /^Notifications/ }).click();
  await page
    .locator('.notification-history__item')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Open' })
    .click();
  // The panel stays open after Open; close it the way a person does, by
  // pressing outside it, so it covers nothing in the captures. On a phone
  // that is the backdrop's top strip: a taller sheet covers its centre.
  if (phone)
    await page
      .getByTestId('notification-history-backdrop')
      .click({ position: { x: 195, y: 24 } });
  else
    await page.getByRole('heading', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.notification-history')).toHaveCount(0);
}

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 80; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement))
      break;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

// The title the dock's bar names (ChatDock.tsx: the opening, imported and
// active-chat identity branches; the phone header's own title on a phone).
const headerTitle = (page: Page, phone: boolean) =>
  page
    .getByRole('region', { name: 'Dock' })
    .locator(
      phone
        ? '.chat-dock__mobile-title'
        : '.chat-dock__header-identity .chat-dock__active-identity-title',
    );
const openingStatus = (page: Page) =>
  page.getByRole('status', { name: 'Opening conversation' });

for (const [width, viewport] of [
  ['390', PHONE],
  ['1440', DESKTOP],
] as const) {
  const phone = viewport === PHONE;
  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(`notification deep link (${width}, ${colorScheme})`, () => {
      let passedThrough = new Set<string>();
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme });
        passedThrough = await seed(page);
      });
      // The bootstrap reads the boundary handed to the Station by the time
      // this hook runs (method and pathname only); not a record of responses,
      // of traffic other routes answered, or of anything after this point.
      test.afterEach(async ({ page: _page }, testInfo) => {
        const file = testInfo.outputPath('station-passthrough.json');
        await writeFile(
          file,
          JSON.stringify([...passedThrough].sort(), null, 2),
        );
        await retain(testInfo, file);
      });

      const capture = async (page: Page, testInfo: TestInfo, name: string) => {
        await expect(page.locator('.notification-history')).toHaveCount(0);
        await expect(page.locator('html')).toHaveAttribute(
          'data-theme',
          colorScheme,
        );
        await page.screenshot({
          path: testInfo.outputPath(`${name}-${width}-${colorScheme}.png`),
        });
        await retain(
          testInfo,
          testInfo.outputPath(`${name}-${width}-${colorScheme}.png`),
        );
      };

      test('names the opening conversation and covers the previous one', async ({
        page,
      }, testInfo) => {
        const hold = await holdLookup(page);
        try {
          await openFirstChat(page);
          await openFromNotifications(page, 'Finished: Release notes', phone);
          await hold.reached;
          await expect(openingStatus(page)).toBeVisible();
          await expect(headerTitle(page, phone)).toHaveText(
            'Opening conversation',
          );
          await expect(
            page.getByRole('log', { name: 'Conversation transcript' }),
          ).toHaveCount(0);
          await capture(page, testInfo, 'opening');
          hold.release();
          await expect(
            page.getByRole('log', { name: 'Conversation transcript' }),
          ).toContainText('Release notes are ready.');
          await expect(openingStatus(page)).toHaveCount(0);
          await expect(headerTitle(page, phone)).toHaveText('Release notes');
        } finally {
          await hold.dispose();
        }
      });

      for (const refusal of REFUSALS)
        test(refusal.name, async ({ page }, testInfo) => {
          await refusal.install(page);
          const refused = await refuseLookup(page);
          await openFirstChat(page);
          await openFromNotifications(page, refusal.row, phone);
          await refused.reached;
          const notice = page
            .getByRole('alert')
            .filter({ hasText: 'No access to this conversation' });
          await expect(notice).toBeVisible();
          await expect(notice).toContainText(
            'This device is not allowed to read it.',
          );
          await expect(
            notice.getByRole('button', { name: 'Manage Stations' }),
          ).toBeVisible();
          await capture(page, testInfo, refusal.capture);
          const dismiss = notice.getByRole('button', { name: 'Dismiss' });
          await tabTo(page, dismiss);
          await page.keyboard.press('Enter');
          await expect(notice).toHaveCount(0);
        });

      test('an imported conversation keeps its header and Continue over a pending open', async ({
        page,
      }, testInfo) => {
        const launches: unknown[] = [];
        await page.route(
          (url) => url.pathname === '/api/starter-work/continue-session',
          (route) =>
            route.request().method() === 'GET'
              ? json(route, { state: 'unbound' })
              : rejectUnexpectedFixtureRequest(route),
        );
        await page.route(
          (url) => url.pathname === '/api/starter-work/launch',
          (route) => {
            if (route.request().method() !== 'POST')
              return rejectUnexpectedFixtureRequest(route);
            launches.push(route.request().postDataJSON());
            return json(route, {
              state: 'failed',
              source: { kind: 'session', id: ATTACHED },
              reason: 'The source conversation is still syncing.',
              retrySafe: true,
            });
          },
        );
        const hold = await holdLookup(page);
        try {
          await openFirstChat(page);
          // A phone folds the Inbox behind its header toggle; the desktop
          // dock already shows it beside the chat.
          if (phone)
            await page
              .getByRole('button', { name: 'Chat list', exact: true })
              .click();
          await expect(
            page.locator('[aria-label="Chats"], [aria-label="Inbox"]').first(),
          ).toBeVisible();
          await page
            .getByRole('button', {
              name: new RegExp(`^${IMPORTED_TITLE},.*third-party session`),
            })
            .click();
          const continueAction = page.getByRole('button', {
            name: 'Continue in Station',
            exact: true,
          });
          await expect(continueAction).toBeVisible();
          await expect(
            page.getByText('The imported transcript is here.'),
          ).toBeVisible();
          await expect(headerTitle(page, phone)).toHaveText(IMPORTED_TITLE);
          if (!phone)
            await expect(
              page
                .locator('.chat-dock__header-action')
                .getByRole('button', { name: 'Continue in Station' }),
            ).toBeVisible();
          await openFromNotifications(page, 'Finished: Release notes', phone);
          await hold.reached;
          await expect(continueAction).toBeVisible();
          await expect(headerTitle(page, phone)).toHaveText(IMPORTED_TITLE);
          await expect(openingStatus(page)).toHaveCount(0);
          await capture(page, testInfo, 'imported');
          await tabTo(page, continueAction);
          await page.keyboard.press('Enter');
          await expect(
            page.getByRole('alert').filter({
              hasText:
                "Couldn't start the continuation. The source conversation is still syncing.",
            }),
          ).toBeVisible();
          expect(launches).toEqual([
            expect.objectContaining({
              starterId: 'continue-session',
              sourceSessionId: ATTACHED,
            }),
          ]);
        } finally {
          await hold.dispose();
        }
      });
    });
  }
}
