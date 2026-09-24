import type { ConversationOpenExecution } from '@kontourai/station-contracts/orchestration';
import type { WorkspacePaneHostActionCatalog } from '@kontourai/station-contracts/workspace-pane-host-contribution';
import { expect, type Page } from '@playwright/test';
import {
  E2E_STATION_COMPATIBILITY,
  installE2EWorkspacePaneCatalog,
} from './current-station-contract';
import { rejectUnexpectedFixtureRequest } from './fixture-audit';

type ConversationLookupFixture = {
  id: string;
  currentSessionId: string;
  agentSlug: string;
  projectSlug?: string;
  title?: string;
};

const E2E_ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const emittedOrchestrationEvents = new WeakMap<
  Page,
  Array<Record<string, unknown>>
>();
const historicalOrchestrationEvents = new WeakMap<
  Page,
  Record<string, Record<string, unknown>[]>
>();
const conversationSessionReaders = new WeakMap<
  Page,
  (conversationId: string) => string[]
>();

const CHAT_REGION_LABELS = ['Left', 'Right', 'Bottom'] as const;
type ChatRegionLabel = (typeof CHAT_REGION_LABELS)[number];

/**
 * Whether a Playwright rejection is a STRICT-MODE VIOLATION — a locator that
 * matched more than one element.
 *
 * This file used to answer `false`/`null` for it 17 times over, and
 * `agents-journey.ts:265-277` records what that costs: a broad
 * `/^Expand chat/` matched three unrelated controls, the surrounding
 * `.catch(() => false)` swallowed the violation as "not visible", and a real
 * ambiguity became a silent no-op instead of a loud failure. The sixteen
 * `isVisible()` reads below no longer catch at all — `isVisible()` returns
 * immediately and answers `false` for an absent element, so absence never
 * needed a catch, and a violation, a closed page and an invalid selector were
 * the only things one could ever have hidden. This predicate exists for the
 * one read whose catch has a legitimate case to keep.
 *
 * A read that is NOT one of those sixteen is the chooser wait in
 * `openChatThroughRegionControl`: it asks for an element that appears as a
 * consequence of a click it just made, behind a lazy boundary, so it
 * auto-waits and fails loudly rather than answering `false` (#2155 delta
 * review F3). The distinction to keep is the page's state, not the API: a
 * probe on a settled page may read immediately; a probe on a page that is
 * still becoming what the probe asks about may not.
 */
function isAmbiguousLocator(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('strict mode violation')
  );
}

async function activeChatRegion(page: Page): Promise<ChatRegionLabel | null> {
  const className = await page
    .getByRole('region', { name: 'Dock', exact: true })
    .getAttribute('class')
    // NOT a bare `() => null`, unlike the `isVisible()` reads below, and the
    // difference is real: `getAttribute` DOES auto-wait, so its timeout means
    // "no Dock region", which is this function's documented `null` answer. A
    // strict-mode violation is not that — it means the NAME matched several
    // regions, and answering `null` would report "no dock" for "too many
    // docks", then pick a layout branch from it.
    .catch((error: unknown) => {
      if (isAmbiguousLocator(error)) throw error;
      return null;
    });
  const region = className?.match(/\bchat-dock--(left|right|bottom)\b/)?.[1];
  if (!region) return null;
  return `${region[0]?.toUpperCase()}${region.slice(1)}` as ChatRegionLabel;
}

/**
 * The toolbar's folded region control on a coarse device too wide to be
 * mobile ("Regions"); `null` on a fine pointer, which has per-region toggles
 * (#2143), and on a phone, where #917 moved the region commands into the `⋯`
 * overflow.
 */
async function regionControlTrigger(page: Page) {
  const trigger = page.getByRole('button', { name: 'Regions', exact: true });
  return (await trigger.isVisible()) ? trigger : null;
}

/**
 * Opens Chat through the shell's region controls, whichever chrome this
 * breakpoint draws.
 *
 * FINE POINTER (#2143, #2155): one toggle per dock region, `aria-pressed`
 * from the model, and it only shows and hides. Chat's region is read off the
 * Dock's own class; if that region's toggle is not pressed, pressing it shows
 * the region; then, if Chat is behind another pane's tab there, its tab is
 * selected. An UNPLACED Chat has no region at all, so the toggle pressed is
 * Bottom's (Chat's default) — which opens Bottom EMPTY, on its own chooser
 * (#2154), and the "Chat" row there is the placement.
 *
 * That second half is #2155's, and the shape it replaces is why it is spelled
 * out: until then an empty region's toggle had NO `aria-pressed` and opened
 * an offer menu, so this helper branched on `pressed !== null`. Every toggle
 * reports `aria-pressed` now, so that branch became unreachable and the one
 * it fell into opened an empty region and waited for a `Dock` landmark an
 * empty region never has — a timeout where the contract says "return false
 * and let the caller's fallbacks run".
 *
 * Chat's own shell is the one landmark named `Dock` rather than by its
 * surface (`DockShell`), which is why the placement is driven here rather
 * than through `region-placement.ts`'s `chooseSurfaceInEmptyRegion` — that
 * helper's post-condition reads a shell named for its surface.
 *
 * COARSE, WIDE: the flat "Region surfaces" menu, unchanged since #1536 F.
 *
 * The post-condition is read after the write settles — the toggle's pressed
 * state re-derived from the arrangement, or the menu reopened — never the
 * DOM just clicked.
 *
 * Returns false when no region control is on screen, or when the one that is
 * could not place Chat, leaving the caller's remaining fallbacks to run.
 */
async function openChatThroughRegionControl(page: Page): Promise<boolean> {
  const region = await activeChatRegion(page);
  const label = region ?? 'Bottom';
  const toggle = page.getByRole('button', {
    name: `${label} region`,
    exact: true,
  });
  if (await toggle.isVisible()) {
    if ((await toggle.getAttribute('aria-pressed')) === 'false') {
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    }
    if (region === null) {
      // Chat is placed nowhere, so the region just opened is empty and its
      // body is the chooser. Its "Chat" row is `openSurfaceInRegion`, which
      // places Chat here; the list going away is the placement landing.
      //
      // AUTO-WAITING, unlike the `isVisible()` reads elsewhere in this file
      // (#2155 delta review F3). Those are branch-selection probes on a
      // SETTLED page — "which chrome does this breakpoint draw" — and answer
      // a question that is already decided when they run. This one asks for
      // an element that appears as a CONSEQUENCE of the click three lines
      // above, through `RegionShells` → a `LazyBoundary` whose `pending` is
      // `null`: there is a real window in which the region is open and its
      // body renders nothing at all, and the pre-warm that usually closes it
      // has no reason to have run on a route that never mounted Chat. A
      // non-waiting probe there does not report "no chooser", it reports
      // "not yet" — and returning `false` for it would send 43 importing
      // specs down their fallbacks for a timing accident.
      const chooser = page.getByRole('list', {
        name: `Add to ${label} region`,
      });
      await expect(
        chooser,
        `the ${label} region opened but never rendered its chooser, so Chat cannot be placed from it`,
      ).toBeVisible();
      // Settled now, so this one IS a branch-selection probe: whether the
      // registry offers Chat for this region at all.
      const row = chooser.getByRole('button', { name: /^Chat( |$)/ });
      if (!(await row.isVisible())) return false;
      await row.click();
      await expect(chooser).toBeHidden();
    }
    // The region is showing, but "Dock" names the region whose panes
    // INCLUDE Chat, selected or not (#2046 D3) — so Chat may be behind
    // another pane's tab. The strip renders only for two or more panes;
    // if it is there and Chat's tab is not selected, select it, and read
    // `aria-selected` back rather than trusting the click. `count()` does
    // not wait, so the strip is given the region's own settle first.
    const chatTab = page
      .getByRole('tablist', { name: 'Region panes' })
      .getByRole('tab', { name: 'Chat', exact: true });
    await page.getByRole('region', { name: 'Dock', exact: true }).waitFor();
    if (
      (await chatTab.count()) > 0 &&
      (await chatTab.getAttribute('aria-selected')) !== 'true'
    ) {
      await chatTab.click();
      await expect(chatTab).toHaveAttribute('aria-selected', 'true');
    }
    return true;
  }

  const trigger = await regionControlTrigger(page);
  if (!trigger) return false;
  await trigger.click();

  // The folded rows name the dock since #1386 ("Hide Chat from the dock"),
  // because the bare verb collided with the docked shell's own control.
  const menu = page.getByRole('menu', { name: 'Region surfaces' });
  if (await menu.isVisible()) {
    const hide = menu.getByRole('menuitemcheckbox', {
      name: 'Hide Chat from the dock',
    });
    if (!(await hide.isVisible())) {
      await menu
        .getByRole('menuitemcheckbox', { name: 'Show Chat in the dock' })
        .click();
      const reopen = await regionControlTrigger(page);
      if (!reopen) {
        throw new Error('The region control disappeared after showing Chat.');
      }
      await reopen.click();
    }
    await expect(
      page
        .getByRole('menu', { name: 'Region surfaces' })
        .getByRole('menuitemcheckbox', { name: 'Hide Chat from the dock' }),
      'the folded region menu does not offer Hide Chat, so Chat is not shown',
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('menu', { name: 'Region surfaces' }),
    ).toBeHidden();
    return true;
  }

  // A trigger that opened none of the three is a chrome this helper has not
  // been taught. Close whatever it did open and let the caller's remaining
  // fallbacks run; `openChatRegion`'s own error names the failure if they
  // cannot either.
  await page.keyboard.press('Escape');
  return false;
}

/**
 * Opens Chat through the shell's region controls instead of an internal dock
 * affordance. The region command is the public ownership boundary for where
 * Chat lives: after opening or placing it, the same region must report that it
 * now shows Chat.
 *
 * Phone chrome does not always render the desktop region toolbar, so it falls
 * back only to the named mobile/legacy Chat expander. The anchored label
 * deliberately excludes sidebar actions such as "Open chats" and
 * "Expand chat list".
 */
export async function openChatRegion(page: Page): Promise<void> {
  for (const region of CHAT_REGION_LABELS) {
    const hide = page.getByRole('button', {
      name: `Hide Chat ${region} region`,
      exact: true,
    });
    if (await hide.isVisible()) {
      await expect(hide).toBeVisible();
      return;
    }
  }

  // The live chrome since #1536 F: one folded control rather than a button per
  // region. Tried before the legacy per-region Place/Show lookups below, which
  // no surface has rendered since that fold.
  if (await openChatThroughRegionControl(page)) return;

  // The Dock's own region class is the live shell state. A surface registry
  // can retain a dormant Chat registration in another region, so choosing the
  // first visible Place action would move the test arbitrarily rather than
  // open the shell's active Chat region.
  const activeRegion = await activeChatRegion(page);
  if (activeRegion) {
    const show = page.getByRole('button', {
      name: `Show Chat ${activeRegion} region`,
      exact: true,
    });
    if (await show.isVisible()) {
      await show.click();
      await expect(
        page.getByRole('button', {
          name: `Hide Chat ${activeRegion} region`,
          exact: true,
        }),
      ).toBeVisible();
      return;
    }

    const place = page.getByRole('button', {
      name: `Place Chat in ${activeRegion} region`,
      exact: true,
    });
    if (await place.isVisible()) {
      await place.click();
      await expect(
        page.getByRole('button', {
          name: `Hide Chat ${activeRegion} region`,
          exact: true,
        }),
      ).toBeVisible();
      return;
    }
  }

  const expand = page.getByRole('button', {
    name: /^Expand chat(?: dock)?$/,
  });
  if (await expand.isVisible()) {
    await expand.click();
    await expect(
      page.getByRole('button', { name: /^Collapse chat(?: dock)?$/ }),
    ).toBeVisible();
    return;
  }

  throw new Error(
    `Chat has no visible command for its ${activeRegion ?? 'unknown'} shell region or mobile Chat expander; refusing to match a sidebar chat-list control.`,
  );
}

export const STATUS_READY = JSON.stringify({
  ready: true,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
  providers: {
    configuredChatReady: true,
    configured: [
      {
        id: 'codex',
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
      source: 'codex',
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
    currentSessionId: 'session-1',
    agentSlug: 'dev-agent',
    projectSlug: 'dev',
    title: 'Dev Agent Chat',
  },
} satisfies Record<
  string,
  {
    id: string;
    currentSessionId: string;
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
  requestedModel?: string;
  requestedProviderOptions?: Record<string, unknown>;
  agentConnectionId?: string;
  executionMode?: 'external' | 'station';
  provider?: string;
  providerOptions?: Record<string, unknown>;
  projectSlug?: string;
  projectName?: string;
  cwd?: string;
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
  options: { preserveExisting?: boolean } = {},
): Promise<void> {
  await page.addInitScript(
    ({ items, preserveExisting }) => {
      if (preserveExisting && sessionStorage.getItem('activeChats') !== null)
        return;
      sessionStorage.setItem('activeChats', JSON.stringify(items));
    },
    { items: chats, preserveExisting: options.preserveExisting === true },
  );
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
/** Capture the observed source prefix once; retries must not recopy later turns. */
export function forkMockOrchestrationTranscript(
  page: Page,
  sourceSessionIds: readonly string[],
  targetSessionId: string,
  branchPointTurnId: string,
): Record<string, unknown>[] {
  const historical = historicalOrchestrationEvents.get(page);
  if (!historical)
    throw new Error('Orchestration history fixture is not installed');
  if (historical[targetSessionId]) return historical[targetSessionId];
  const sources = new Set(sourceSessionIds);
  const events = [
    ...sourceSessionIds.flatMap((id) => historical[id] ?? []),
    ...(emittedOrchestrationEvents.get(page) ?? []).filter(
      (event) =>
        typeof event.threadId === 'string' && sources.has(event.threadId),
    ),
  ];
  const end = events.findIndex(
    (event) =>
      event.turnId === branchPointTurnId && event.method === 'turn.completed',
  );
  if (end < 0) throw new Error('Fork fixture has no completed source turn');
  const prefix = structuredClone(events.slice(0, end + 1));
  historical[targetSessionId] = prefix;
  return prefix;
}

export async function installMockOrchestrationConversationEventWindow(
  page: Page,
  readSessionIds: (conversationId: string) => string[],
): Promise<void> {
  conversationSessionReaders.set(page, readSessionIds);
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
    const event = payload.event as Record<string, unknown>;
    // EventStore assigns identity before both live delivery and replay.
    // Negative fixtures can still explicitly supply a malformed identity.
    const identified = Object.hasOwn(event, 'eventId')
      ? event
      : { ...event, eventId: `e2e-live-${events.length + 1}` };
    payload = { ...payload, event: identified };
    events.push(identified);
    emittedOrchestrationEvents.set(page, events);
  }
  await page.evaluate(
    ([eventType, eventPayload]) => {
      (window as any).__mockOrchestrationSse.emit(eventType, eventPayload);
    },
    [type, payload],
  );
}

/**
 * Opens Settings the way the shell now offers it.
 *
 * #1552 D1 folded "Open settings" into the avatar's menu on a fine pointer.
 * On a phone the avatar — and therefore its menu — is hidden instead, and the
 * header carries no Settings gear either: Settings lives in the sidebar
 * drawer's footer (`ProjectSidebarFooter`), so this takes whichever route the
 * running breakpoint actually offers rather than assuming one.
 *
 * The avatar branch is deliberately a real click through the real menu: it is
 * the only end-to-end coverage of the route D1 introduced, and a spec that
 * reached Settings by chord would pass with that menu completely broken. The
 * drawer branch is the same idea: a real open of the drawer plus the real
 * footer button, so a spec fails if either stops existing.
 */
export async function openHeaderSettings(page: Page): Promise<void> {
  const avatar = page.getByRole('button', { name: 'Profile and settings' });
  const drawerToggle = page.getByRole('button', { name: 'Toggle menu' });
  // WAIT BEFORE BRANCHING. Asking `isVisible()` the instant after `goto` answers
  // "has the toolbar rendered yet", not "which breakpoint is this" — a first
  // draft branched on that answer, took the phone path on a desktop, and then
  // waited ten seconds for a control that is `display: none` there. Wait for
  // whichever route this breakpoint renders, THEN choose.
  await expect(avatar.or(drawerToggle).first()).toBeVisible({
    timeout: 15_000,
  });
  if (await avatar.isVisible()) {
    await avatar.click();
    await page
      .getByRole('menuitem', { name: 'Open settings' })
      .click({ timeout: 10_000 });
    return;
  }
  // The phone route: the hamburger opens the sidebar drawer, whose footer
  // carries the Settings button.
  await drawerToggle.click();
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .click({ timeout: 10_000 });
}

export async function dismissSetupLauncher(page: Page): Promise<void> {
  const launcher = page.getByTestId('setup-launcher');
  if (await launcher.isVisible()) {
    await launcher
      .getByRole('button', { name: 'Dismiss setup launcher', exact: true })
      .click();
    await expect(launcher).toBeHidden();
  }
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
    conversationLookups?: Record<string, ConversationLookupFixture>;
    executionBySession?: Record<string, ConversationOpenExecution>;
  },
): Promise<void> {
  await installMockOrchestrationEventWindow(page);
  await installE2EWorkspacePaneCatalog(page, {
    projectSlug: 'dev',
    projectId: DEV_CONFIG.id,
    layoutSlug: CODING_LAYOUT.slug,
  });
  // This fixture Project has only built-in Panes and no installed package
  // actions. Its identity exists in mocked Project routes, not the live server.
  const paneActions: WorkspacePaneHostActionCatalog = {
    projectSlug: 'dev',
    support: 'supported',
    complete: true,
    contributions: [],
  };
  await page.route('**/api/orchestration/pane-host/dev/catalog', (route) => {
    if (route.request().method() !== 'GET')
      return rejectUnexpectedFixtureRequest(route);
    return route.fulfill({ json: { success: true, data: paneActions } });
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
  const conversationLookups: Record<string, ConversationLookupFixture> =
    options?.conversationLookups ?? DEFAULT_CONVERSATION_LOOKUPS;
  // A test may replace the default catalog after its beforeEach setup. Its
  // event-window/open resolver must follow the same replacement snapshot.
  if (!conversationSessionReaders.has(page) || options?.conversationLookups) {
    await installMockOrchestrationConversationEventWindow(page, (id) => {
      const conversation = conversationLookups[id];
      return conversation ? [conversation.currentSessionId] : [];
    });
  }

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
    page.route('**/api/conversations/**', (r) => {
      const url = new URL(r.request().url());
      const parts = url.pathname.split('/').filter(Boolean);
      const conversationId =
        (parts.at(-1) === 'open' ? parts.at(-2) : parts.at(-1)) ?? '';
      const conversation = conversationLookups[conversationId];
      if (parts.at(-1) === 'open' && conversation) {
        const inventory = conversations.find(
          (candidate) => candidate.id === conversationId,
        );
        if (!inventory) {
          return r.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              success: false,
              error: 'Conversation fixture metadata is incomplete',
            }),
          });
        }
        const sessionReader = conversationSessionReaders.get(page);
        const currentSessionId = sessionReader
          ? sessionReader(conversationId).at(-1)
          : conversation.currentSessionId;
        const execution = currentSessionId
          ? options?.executionBySession?.[currentSessionId]
          : undefined;
        if (
          execution &&
          (execution.sessionId !== currentSessionId ||
            execution.agentId !== conversation.agentSlug)
        )
          throw new Error(
            'Conversation fixture execution identity is inconsistent',
          );
        const { currentSessionId: _seededCurrentSessionId, ...identity } =
          conversation;
        const exactConversation = {
          ...identity,
          source: 'runtime' as const,
          title: conversation.title ?? inventory.title ?? conversationId,
          createdAt: inventory.createdAt,
          updatedAt: inventory.updatedAt,
          messageCount: inventory.messageCount ?? 0,
          mutable: false,
          answerability: { answerable: true },
        };
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              status: currentSessionId ? 'resolved' : 'missing-session',
              conversation: exactConversation,
              ...(currentSessionId ? { currentSessionId } : {}),
              ...(execution ? { execution } : {}),
              transcript: {
                available: Boolean(currentSessionId),
                owner: 'runtime',
                ...(currentSessionId
                  ? { messageCount: inventory.messageCount ?? 0 }
                  : {}),
              },
              canContinue: Boolean(currentSessionId),
              answerability: { answerable: true },
              recoveryActions: currentSessionId ? [] : ['retry', 'start-new'],
            },
          }),
        });
      }
      const legacyConversation = conversation
        ? {
            id: conversation.id,
            agentSlug: conversation.agentSlug,
            ...(conversation.projectSlug
              ? { projectSlug: conversation.projectSlug }
              : {}),
            ...(conversation.title ? { title: conversation.title } : {}),
          }
        : undefined;
      return r.fulfill({
        status: legacyConversation ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(
          legacyConversation
            ? { success: true, data: legacyConversation }
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
