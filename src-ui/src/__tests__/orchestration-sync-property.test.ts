import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  PUBLIC_STATION_HANDSHAKE_PATH,
  REMOTE_AUTH_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
// This UI-lane tsconfig has no type declarations for 'jsdom' (a vitest
// environment transitive dep, not a workspace dependency of this lane) —
// same cross-runtime-import reasoning as the `vi.importActual<any>` server
// module loads below.
// @ts-expect-error no type declarations for 'jsdom' in this typecheck lane
import { JSDOM } from 'jsdom';
import { afterEach, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../types';
import { CHAT_ERROR_MARKER_PREFIX } from '../utils/sessionFailure';

vi.mock('../../../src-server/constants.js', async (load) => ({
  ...(await load<Record<string, unknown>>()),
  ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD: 5,
}));

/**
 * station#2530 review H1: the transcript comparison needs a real DOM for
 * `renderHook`. This file cannot use the ambient `@vitest-environment
 * jsdom` pragma — vitest's jsdom environment runs the WHOLE file inside a
 * fresh vm context, and `better-sqlite3`'s native binding then returns
 * Buffer/Uint8Array instances from a DIFFERENT realm than that context's own
 * `Uint8Array`, so the real `EventStore`'s cursor-key `instanceof Uint8Array`
 * check fails ("Cursor key is unavailable.") — a defect in the harness, not
 * the server. Installing jsdom's `document` directly, in this file's own
 * (node) realm, sidesteps that: `better-sqlite3` and `document` then agree
 * on which `Uint8Array` they mean. `window` itself is still fully replaced
 * per client below (`vi.stubGlobal('window', page)`); this only supplies
 * the `document` `renderHook` needs.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://sync-property.test/',
});
// Deliberately narrow: `window`, `Event` and `EventTarget` stay Node's own
// (the per-client `page` below is a native `EventTarget`, and mixing a
// jsdom `Event` into a native `dispatchEvent` fails Node's own brand check).
// Only what `document`-driven rendering actually needs.
vi.stubGlobal('document', dom.window.document);
vi.stubGlobal('navigator', dom.window.navigator);
vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle);
if (
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT === undefined
) {
  // Test-only global React reads to silence act() warnings.
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}

const apiBase = 'http://sync-property.test';
const userId = 'sync-property-user';
const roots: string[] = [];
const services: Array<{ shutdown(): Promise<unknown> }> = [];
const stores: Array<{ close(): void }> = [];
const requests: Array<{
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}> = [];

/**
 * A minimal, spec-conforming public handshake (see
 * `parsePublicStationHandshake`/`parseStationCompatibility` in
 * `@kontourai/station-contracts/environment-security`). Without this route,
 * `fetchSessionEventWindowCapability` gets no answer, `useSessionEventWindow`
 * never trusts the bounded window protocol, and `useActiveChatTranscript`
 * can only ever show what arrived live on THIS connection — exactly the
 * catch-up path the transcript comparison below exists to exercise.
 */
function publicHandshakeResponse() {
  return {
    schemaVersion: PUBLIC_HANDSHAKE_SCHEMA_VERSION,
    environmentId: 'sync-property-env',
    authentication: {
      scheme: 'bearer' as const,
      protocolVersion: REMOTE_AUTH_PROTOCOL_VERSION,
    },
    transports: {
      http: REMOTE_AUTH_PROTOCOL_VERSION,
      sse: REMOTE_AUTH_PROTOCOL_VERSION,
      websocket: REMOTE_AUTH_PROTOCOL_VERSION,
    },
    compatibility: {
      serverVersion: '0.0.0-sync-property-test',
      protocolVersion: 1,
      minClientProtocol: 1,
    },
    capabilities: { sessionEventWindow: true },
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const service of services.splice(0)) await service.shutdown();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function setup() {
  // Vitest loads the real server modules at runtime. This cross-runtime
  // harness lives in the UI test lane, whose TypeScript project does not
  // compile server internals or provide their Node-only ambient types.
  const [storeModule, busModule, serviceModule, routeModule] =
    await Promise.all([
      vi.importActual<any>(
        '../../../src-server/services/orchestration/event-store.js',
      ),
      vi.importActual<any>(
        '../../../src-server/services/orchestration/event-bus.js',
      ),
      vi.importActual<any>(
        '../../../src-server/services/orchestration/orchestration-service.js',
      ),
      vi.importActual<any>(
        '../../../src-server/routes/orchestration/orchestration.js',
      ),
    ]);
  const { EventStore } = storeModule;
  const { EventBus } = busModule;
  const { OrchestrationService } = serviceModule;
  const { createOrchestrationRoutes } = routeModule;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  const root = mkdtempSync(join(tmpdir(), 'station-sync-property-'));
  roots.push(root);
  const store = new EventStore(join(root, 'orchestration.sqlite'));
  stores.push(store);
  const eventBus = new EventBus();
  const service = new OrchestrationService({
    adapterRegistry: {
      register() {},
      get() {
        return undefined;
      },
      list() {
        return [];
      },
    } as any,
    eventBus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() } as any,
  });
  services.push(service);
  const app = new Hono();
  app.get(PUBLIC_STATION_HANDSHAKE_PATH, (c) =>
    c.json(publicHandshakeResponse()),
  );
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => userId,
    }),
  );
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(
        String(input instanceof Request ? input.url : input),
        init,
      );
      // The body is read from a CLONE: the original must still be readable
      // once by whatever consumes the real `app.fetch(request)` response.
      let body: string | undefined;
      try {
        body = await request.clone().text();
      } catch {
        body = undefined;
      }
      requests.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body,
      });
      return app.fetch(request);
    },
  );
  const publish = (event: CanonicalRuntimeEvent) => {
    store.appendEvent(event);
    eventBus.emit('orchestration:event', { event });
  };
  const publishViaService = (event: CanonicalRuntimeEvent) => {
    (service as any).publishCanonicalEvent(event);
  };
  return { store, service, app, publish, publishViaService };
}

/**
 * `outboundData` backs the durable outbound-queue storage a real reload
 * carries across (localStorage) — see the `reload` reconnect method below,
 * which passes a previous client's map forward instead of minting a fresh
 * empty one.
 */
async function clientGraph(
  conversationId: string,
  options?: { outboundData?: Map<string, unknown> },
) {
  vi.resetModules();
  const page = Object.assign(new EventTarget(), {
    location: { pathname: '/', search: '', origin: apiBase, href: apiBase },
    history: { state: null, replaceState() {}, pushState() {} },
  });
  vi.stubGlobal('window', page);
  const sdk = await import('@kontourai/station-sdk');
  const { activeChatsStore } = await import('../contexts/active-chats-store');
  const { ensureOrchestrationEventStream } = await import(
    '../hooks/orchestration/ensureOrchestrationEventStream'
  );
  const { childWorkRegistrySnapshot } = await import(
    '../hooks/orchestration/childWorkHandlers'
  );
  const { childWorkGlobalStore } = await import(
    '../contexts/child-work-global-store'
  );
  const { backgroundTasksStore } = await import(
    '../contexts/background-tasks-store'
  );
  const { _setOutboundQueueStorage } = await import('../lib/outboundQueue');
  const outboundData = options?.outboundData ?? new Map<string, unknown>();
  _setOutboundQueueStorage({
    getItem: async (key) => outboundData.get(key),
    setItem: async (key, value) => {
      outboundData.set(key, value);
    },
    updateItem: async (key, update) => {
      outboundData.set(key, update(outboundData.get(key)));
    },
  });
  sdk.setClientCredentialResolver(() => ({
    origin: apiBase,
    credential: 'test-credential',
  }));
  activeChatsStore.initChat(conversationId, {
    agentSlug: 'claude',
    agentName: 'Claude',
    title: 'Property test',
    conversationId,
    currentSessionId: conversationId,
    provider: 'claude',
    orchestrationSessionStarted: true,
  });
  const close = ensureOrchestrationEventStream(apiBase);
  // This client's own React/testing-library instance: `vi.resetModules()`
  // above gives every client a fresh module registry, and the transcript
  // hook must be rendered with the SAME `react` instance it was imported
  // with, or React refuses the hook calls as cross-instance.
  const { renderHook } = await import('@testing-library/react');
  const { useActiveChatTranscript } = await import(
    '../hooks/orchestration/useActiveChatTranscript'
  );
  function buildSession() {
    return {
      messages: [],
      orchestrationSessionStarted: true,
      orchestrationHistoryRevision: 0,
      ...activeChatsStore.getSnapshot()[conversationId],
      id: conversationId,
    } as unknown as Parameters<typeof useActiveChatTranscript>[1];
  }
  let transcriptView = renderHook(
    (session: ReturnType<typeof buildSession>) =>
      useActiveChatTranscript(apiBase, session),
    { initialProps: buildSession() },
  );
  /**
   * Rerenders with the store's current snapshot and waits past any
   * catching-up reload before reading the transcript — the quiesce point
   * the review asked for, not merely "the window fetch resolved once".
   */
  async function settleTranscript(): Promise<ChatMessage[]> {
    // A settle can itself change store state that the NEXT render must
    // react to (e.g. a reconnect-fallback refetch, or another revision
    // bump this reader had not been rendered with yet) — rerender with the
    // CURRENT snapshot and repeat until a pass changes nothing further,
    // rather than trusting a single settle. Bounded so a genuine defect
    // (never settling) still fails instead of hanging.
    let previousKey: string | undefined;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      transcriptView.rerender(buildSession());
      await vi.waitFor(
        () => {
          expect(transcriptView.result.current.settled).toBe(true);
          expect(transcriptView.result.current.loading).toBe(false);
          expect(transcriptView.result.current.catchingUp).toBe(false);
        },
        { timeout: 5_000 },
      );
      const session = activeChatsStore.getSnapshot()[conversationId];
      const key = JSON.stringify([
        session?.orchestrationHistoryRevision,
        session?.currentSessionId,
        transcriptView.result.current.messages.length,
        // `watermark` is only on the non-replay branch of the hook's return
        // union; this test never uses replay threads, but TS cannot narrow
        // that from the runtime session shape.
        (transcriptView.result.current as { watermark?: number }).watermark,
      ]);
      if (key === previousKey) break;
      previousKey = key;
    }
    return transcriptView.result.current.messages;
  }
  /** A fresh mount of just the transcript reader — a component remount. */
  function remountTranscript(): void {
    transcriptView.unmount();
    transcriptView = renderHook(
      (session: ReturnType<typeof buildSession>) =>
        useActiveChatTranscript(apiBase, session),
      { initialProps: buildSession() },
    );
  }
  function unmountTranscript(): void {
    transcriptView.unmount();
  }
  return {
    activeChatsStore,
    childWorkRegistrySnapshot,
    childWorkGlobalStore,
    backgroundTasksStore,
    close,
    outboundData,
    ensure: () => ensureOrchestrationEventStream(apiBase),
    disconnect: () => page.dispatchEvent(new Event('pagehide')),
    settleTranscript,
    remountTranscript,
    unmountTranscript,
  };
}

type ClientGraph = Awaited<ReturnType<typeof clientGraph>>;

async function until(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5_000 });
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * `useActiveChatTranscript` builds `content` FROM the message's own 'text'
 * parts (`content: message.parts.filter(p=>p.type==='text')...join('')`),
 * so `content` already IS their concatenation — scanning `contentParts` too
 * (as the hook's own private `transcriptMessageText` does, for an unrelated
 * prefix check) would double every text part's contribution and break exact
 * occurrence counting.
 */
function messageText(message: ChatMessage): string {
  return message.content ?? '';
}

/**
 * Role + text + tool parts, excluding ids and clocks (station#2530 review
 * H1): a duplicated or dropped row shows up as an extra/missing array entry
 * even with identity fields stripped out.
 */
/**
 * A pre-existing, documented presentational duality — NOT something this PR
 * touches or is meant to converge: a client that lived through a
 * `runtime.error` LIVE gets `handleRuntimeErrorEvent`'s rich local marker
 * row (translated copy, retry affordance, repeat-compaction) beside a clean
 * assistant bubble; a client that only ever reads the durable PROJECTION
 * (a reconnect that never replayed that exact frame) instead sees the raw
 * `⚠️ <message>` suffix appended straight onto the assistant text, with no
 * marker row at all (`runtime-event-projection.ts`). Both convey the same
 * failure; this test's oracle cares whether the STREAMED TEXT survived
 * intact (D2), not which of the two established failure presentations
 * rendered it, so both are normalized away before comparing.
 */
const RUNTIME_ERROR_SUFFIX_PATTERN = /⚠️.*$/s;
function stripKnownFailurePresentationDuality(text: string): string {
  return text.replace(RUNTIME_ERROR_SUFFIX_PATTERN, '').trimEnd();
}

function normalizeTranscript(messages: readonly ChatMessage[]) {
  return messages
    .filter(
      (message) =>
        !(
          message.role === 'user' &&
          messageText(message).trimStart().startsWith(CHAT_ERROR_MARKER_PREFIX)
        ),
    )
    .map((message) => ({
      role: message.role,
      text: stripKnownFailurePresentationDuality(messageText(message)),
      tools: (message.contentParts ?? [])
        .filter((part) => part.type === 'tool-invocation')
        .map((part) => ({
          toolName: part.toolName,
          state: part.state,
          args: part.args ?? null,
          output: part.output ?? null,
          result: part.result ?? null,
          error: part.error ?? null,
          isError: part.isError ?? null,
          cancelled: part.cancelled ?? null,
          needsApproval: part.needsApproval ?? null,
          approvalStatus: part.approvalStatus ?? null,
        })),
    }));
}

function fullTranscriptText(messages: readonly ChatMessage[]): string {
  return normalizeTranscript(messages)
    .map((message) => message.text)
    .join('\u0000');
}

/** How many non-overlapping times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

/**
 * The activity/state/child-work/delegate convergence the original test
 * asserted only once per seed (at the end), factored out so the randomized
 * mid-turn reconnects below (station#2530 review M2) can assert the SAME
 * thing at every quiesce, not only the last one.
 */
async function assertClientsConverged(
  a: ClientGraph,
  b: ClientGraph,
  conversationId: string,
  expectedHead: number,
  label: string,
  /**
   * `orchestrationStatus` is deliberately excluded from a MID-TURN bounce
   * comparison. `handleTurnStartedEvent` sets it OPTIMISTICALLY to 'running'
   * the instant a turn starts — "the server event remains authoritative and
   * will confirm or correct this value" (its own comment) — and that
   * correction, for a STALE approval left open past ITS OWN turn's
   * completion (this test resolves a seed's request one seed later, on
   * purpose, to exercise a gap spanning a turn boundary), only arrives with
   * THAT approval's own `request.resolved`. A client that stayed connected
   * (A) reads 'running' until then by design; a client that just reconnected
   * mid-turn via a snapshot legitimately derives a more precise
   * 'awaiting-approval' from the still-open request in THAT instant. Both
   * converge once the resolve lands — checked at every seed's end, where
   * this stays included. `conversationActivity` (the SERVER's own record,
   * compared in full below) is never excluded — it is not an optimistic
   * guess.
   *
   * `pendingApprovals` (the pre-#2309 legacy field, populated only through
   * `planSnapshot`'s bespoke `openRequestIds` union — NOT sourced from
   * `conversationActivity`) is NOT vestigial: `ChatMessageList`'s live-row
   * copy, `home-view-model`'s "Needs attention" badge, `WorkflowPlanPanel`'s
   * "Approval required (N)" count, `MessageBubble`'s pending-approval count
   * and `ACPChatPanel` all read it directly. station#2530 review 2 round 2:
   * a 'reload' bounce (a brand-new client's very first connect snapshot)
   * observed it empty at seed 64 while A (never disconnected) still
   * correctly showed a request opened on a lineage child two seeds earlier —
   * even though `conversationActivity` (checked above, full equality) was
   * already byte-identical between both clients at that same instant. Root
   * cause: `selectSnapshotRows`' candidate matching resolves a lineage
   * child's row to its chat via `keyByExecutionIdentity`, seeded only from
   * the CLIENT's own prior `currentSessionId`/`conversationId` — a reloaded
   * client's very first snapshot has neither yet (`initChat` seeds
   * `currentSessionId` to the chat's own root key, and this payload's rows
   * carry no `conversationId` at all), so the child's row never joined the
   * union and its `openRequestIds` were silently dropped. Fixed by also
   * seeding `keyByExecutionIdentity` from each row's OWN advertised
   * `currentSessionId` (the root row names its current child, self-
   * referentially, regardless of what the client knew beforehand) — see
   * `selectSnapshotRows` in snapshotHandlers.ts. `pendingApprovals` is
   * compared like every other field below now; seed 64 stays pinned as the
   * regression that would catch a reoccurrence.
   */
  options: {
    includeOrchestrationStatus: boolean;
  } = {
    includeOrchestrationStatus: true,
  },
) {
  await vi.waitFor(
    () => {
      const activity =
        a.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity;
      expect(activity?.asOfSequence, label).toBe(expectedHead);
    },
    { timeout: 5_000 },
  );
  await vi.waitFor(
    () => {
      const activity =
        b.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity;
      expect(activity?.asOfSequence, label).toBe(expectedHead);
    },
    { timeout: 5_000 },
  );
  expect(
    b.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity,
    label,
  ).toEqual(
    a.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity,
  );
  const select = (
    chat: ReturnType<typeof a.activeChatsStore.getSnapshot>[string],
  ) => ({
    orchestrationTurnOpen: chat.orchestrationTurnOpen,
    ...(options.includeOrchestrationStatus
      ? { orchestrationStatus: chat.orchestrationStatus }
      : {}),
    status: chat.status,
    error: chat.error,
    openTurnId: chat.openTurnId,
    pendingApprovals: chat.pendingApprovals ?? [],
    queuedMessages: chat.queuedMessages,
    queueDrainHeldForOpen: chat.queueDrainHeldForOpen,
    queueDrainSettling: chat.queueDrainSettling,
    backgroundTasks: chat.backgroundTasks ?? [],
    currentSessionId: chat.currentSessionId,
  });
  expect(
    select(b.activeChatsStore.getSnapshot()[conversationId]!),
    label,
  ).toEqual(select(a.activeChatsStore.getSnapshot()[conversationId]!));
  expect(b.childWorkRegistrySnapshot().items, label).toEqual(
    a.childWorkRegistrySnapshot().items,
  );
  expect(
    b.childWorkGlobalStore.getPartition(apiBase).registry.items,
    label,
  ).toEqual(a.childWorkGlobalStore.getPartition(apiBase).registry.items);
  const delegates = (client: ClientGraph) =>
    Object.fromEntries(
      Object.entries(client.backgroundTasksStore.getSnapshot().entries).filter(
        ([, entry]) => entry.kind === 'agent',
      ),
    );
  expect(delegates(b), label).toEqual(delegates(a));
}

/**
 * H1's transcript half of convergence: both clients render the identical
 * normalized transcript. Returns the raw messages so a caller can also run
 * the delta-text oracle against them.
 */
async function assertTranscriptsConverged(
  a: ClientGraph,
  b: ClientGraph,
  label: string,
): Promise<{ aMessages: ChatMessage[]; bMessages: ChatMessage[] }> {
  const aMessages = await a.settleTranscript();
  const bMessages = await b.settleTranscript();
  expect(normalizeTranscript(bMessages), label).toEqual(
    normalizeTranscript(aMessages),
  );
  return { aMessages, bMessages };
}

/** An oracle independent of the A-vs-B comparison: what was actually sent. */
function assertDeltaTextRenderedOnce(
  messages: readonly ChatMessage[],
  expectedText: string | undefined,
  label: string,
) {
  if (!expectedText) return;
  expect(
    countOccurrences(fullTranscriptText(messages), expectedText),
    label,
  ).toBe(1);
}

const RECONNECT_METHODS = [
  'replay',
  'snapshot',
  'replacement',
  'reload',
  'remount',
] as const;
type ReconnectMethod = (typeof RECONNECT_METHODS)[number];

/** A benign thread no client tracks — padding to control the resume gap. */
const RECONNECT_FILLER_THREAD = 'reconnect-filler';

/**
 * Executes one of the five ways a real client resumes (station#2530 review
 * M2): a small replay, a snapshot fallback (padded past the mocked resume
 * gap threshold), an immediate stream replacement, a full page reload
 * (fresh module graph, durable outbound-queue storage carried across), or a
 * bare component remount of just the transcript reader. Returns the client
 * to use afterward — only `reload` replaces it.
 */
async function reconnectClient(params: {
  b: ClientGraph;
  method: ReconnectMethod;
  store: { appendEvent(event: CanonicalRuntimeEvent): void };
  conversationId: string;
  createdAt: string;
  seed: number;
}): Promise<ClientGraph> {
  const { method, store, conversationId, createdAt, seed } = params;
  let { b } = params;
  if (method === 'snapshot') {
    // The mocked ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD is 5: pad past it
    // on an unrelated thread so the reconnect must fall back to a snapshot
    // rather than a replay.
    for (let index = 0; index < 6; index += 1) {
      store.appendEvent({
        eventId: `reconnect-filler-${seed}-${Math.random()}`,
        provider: 'claude',
        threadId: RECONNECT_FILLER_THREAD,
        createdAt,
        method: 'content.text-delta',
        itemId: RECONNECT_FILLER_THREAD,
        delta: 'x',
      } as CanonicalRuntimeEvent);
    }
  }
  if (method === 'reload') {
    // A real page reload discards the old tab entirely — its stream, and
    // whatever it had in flight, is simply gone. Abandoning it here (as the
    // ORIGINAL page did) let the abandoned client's requests keep racing the
    // new one against the same in-process EventStore, which stacks up
    // needless concurrent SQLite traffic across a long seed run.
    b.disconnect();
    b.unmountTranscript();
    b = await clientGraph(conversationId, { outboundData: b.outboundData });
    return b;
  }
  if (method === 'remount') {
    // A fresh mount of the transcript reader alone — the stream connection
    // (live or disconnected) is untouched.
    b.remountTranscript();
    return b;
  }
  // 'replay' and 'replacement' both reconnect the SAME document's stream
  // immediately; 'replacement' additionally asserts a near-zero gap (F3:
  // resume from the last applied cursor with nothing missed), while
  // 'replay' allows the ordinary handful of events a short disconnect
  // accumulates — both stay under the mocked threshold of 5.
  b.ensure();
  return b;
}

test('seeded clients converge through live, replay, and snapshot reconnects', async () => {
  const { store, publish, publishViaService } = await setup();
  const conversationId = 'sync-root';
  const createdAt = '2026-09-24T00:00:00.000Z';
  store.upsertSession({
    provider: 'claude',
    threadId: conversationId,
    status: 'ready',
    createdAt,
    updatedAt: createdAt,
  });
  publish({
    eventId: 'configured',
    provider: 'claude',
    threadId: conversationId,
    createdAt,
    method: 'session.configured',
    sessionId: conversationId,
    metadata: { agentSlug: 'claude', userId },
  } as CanonicalRuntimeEvent);
  const a = await clientGraph(conversationId);
  await until(() =>
    Boolean(
      a.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity,
    ),
  );
  let b = await clientGraph(conversationId);
  await until(() =>
    Boolean(
      b.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity,
    ),
  );
  expect(
    b.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity,
  ).toEqual(
    a.activeChatsStore.getSnapshot()[conversationId]?.conversationActivity,
  );
  const selectedSeed = process.env.SYNC_FUZZ_SEED;
  const seeds = [
    // Pinned regressions: 0 deleted-tail/replacement/snapshot approvals and
    // settled child; 12 runtime.error; 16 turn.aborted; 20 lineage child;
    // 30 reload; 40 finished delegate; 50 mid-turn; 199 queued follow-up.
    ...Array.from({ length: 200 }, (_, seed) => seed),
    ...(selectedSeed && Number.isSafeInteger(Number(selectedSeed))
      ? [Number(selectedSeed)]
      : []),
  ];
  let executionThreadId = conversationId;
  // The exact text each turn's deltas concatenate to, keyed by turnId — the
  // oracle for "rendered exactly once" (station#2530 review H1).
  const turnDeltaText = new Map<string, string>();
  // Seeds whose scripted scenario the mid-turn reconnect fuzzing (review M2)
  // must not disturb: 30 is a reload-only regression, 50/51 are the
  // deliberately-left-open mid-turn pair, and 199's queued-follow-up oracle
  // wants an exact request count.
  const BOUNCE_EXEMPT_SEEDS = new Set([30, 50, 51, 199]);
  for (const seed of seeds) {
    const random = mulberry32(seed);
    const trace: string[] = [];
    // A PRNG independent of `random` above: the mid-turn reconnect fuzzing
    // must not perturb the existing seeded decisions (delta counts, tool/
    // approval inclusion) that the pinned regressions above depend on.
    const reconnectRandom = mulberry32(seed * 2_654_435_761 + 977);
    let bouncesRemaining = BOUNCE_EXEMPT_SEEDS.has(seed)
      ? 0
      : Math.floor(reconnectRandom() * 4);
    /**
     * station#2530 review M2: a random mid-turn disconnect/reconnect, at a
     * point the caller names (between deltas, between tool start and done,
     * after an approval opens). Reconnects with a random method, asserts
     * convergence at THIS quiesce (not only the seed's final one), then
     * returns to the disconnected baseline so the rest of the turn is still
     * exercised against a client that missed it live.
     */
    async function maybeBounceMidTurn(checkpoint: string) {
      if (bouncesRemaining <= 0) return;
      if (reconnectRandom() >= 0.5) return;
      bouncesRemaining -= 1;
      const method =
        RECONNECT_METHODS[
          Math.floor(reconnectRandom() * RECONNECT_METHODS.length)
        ];
      const expectedHead = store.headGlobalSequence();
      b = await reconnectClient({
        b,
        method,
        store,
        conversationId,
        createdAt,
        seed,
      });
      const label = `seed=${seed} bounce@${checkpoint} method=${method}`;
      // 'remount' only resets the TRANSCRIPT READER's component state — it
      // never touches B's SSE connection, which is still genuinely
      // disconnected. `orchestrationTurnOpen`/`status`/`openTurnId` are
      // event-stream-driven fields `applyConversationActivity` deliberately
      // never reconciles from a bare window read (`conversationActivity` is
      // the authority consumers read instead, via `serverTurnLive`) — so
      // asserting full store-field equality here would fail on a client that
      // legitimately has not heard the live turn.started yet. Exercise the
      // remount (it must not throw, hang, or wedge in "catching up" forever)
      // without that equality assertion; the other 4 methods DO reconnect
      // B's stream/data and get the full check.
      if (method === 'remount') {
        await b.settleTranscript();
      } else {
        await assertClientsConverged(
          a,
          b,
          conversationId,
          expectedHead,
          label,
          { includeOrchestrationStatus: false },
        );
      }
      // A vs B is not compared here: while this turn is still open, its own
      // content is legitimately asymmetric between a client rendering it
      // from its live streaming shell (never disconnected) and one
      // rendering it from the stitched window+live projection (just
      // reconnected) — that IS the shell/projection handoff F4 exists for,
      // not a defect. The A-vs-B transcript comparison below runs once the
      // turn has a terminal event, where both clients must agree on the
      // durable copy.
      //
      // What DOES get checked here, independent of A: whether B's own
      // stitched read shows the deltas published so far for the STILL-OPEN
      // turn. This is deliberately checked mid-turn, not only post-terminal
      // — by the time a turn has a terminal event, its own REST window read
      // alone (no stitching at all) already carries everything, so a
      // post-terminal-only check cannot tell a working stitch from a
      // disabled one.
      //
      // Caveat, found while trying to fault-inject this: it is NOT proven
      // to isolate F4's live-buffer stitching specifically. A defeated
      // stitch (`stitchedEvents` forced to `window.events` only) still left
      // this green, because station#2309's debounced "turnless" refetch
      // (`streamHandlers.ts`'s `scheduleTurnlessRefetch`,
      // `TURNLESS_REFETCH_DEBOUNCE_MS`) independently bumps
      // `orchestrationHistoryRevision` and re-fetches the window within
      // this check's own settle-loop patience window, masking the
      // regression the same way the post-terminal check does. Left in
      // because it is still a real, useful convergence check (and the
      // closest oracle to F4 this pass produced) — but the F4 fault
      // injection this PR's rules asked for did NOT go red in either form,
      // and that gap is disclosed rather than papered over.
      if (method !== 'remount') {
        const bMidTurnMessages = await b.settleTranscript();
        assertDeltaTextRenderedOnce(
          bMidTurnMessages,
          turnDeltaText.get(turnId),
          `${label} mid-turn stitch oracle`,
        );
      }
      // Back to simulating a disconnected client for the rest of the turn —
      // 'remount' never touched the transport, so there is nothing to
      // re-disconnect for it.
      if (method !== 'remount') {
        lastDisconnectCursor = store.headGlobalSequence();
        bounced = true;
        b.disconnect();
      }
    }
    if (seed === 51) {
      publish({
        eventId: 'turn-50-late-complete',
        provider: 'claude',
        threadId: executionThreadId,
        turnId: 'turn-50',
        createdAt,
        method: 'turn.completed',
      } as CanonicalRuntimeEvent);
      trace.push('prior-turn.completed');
    }
    if (seed === 199) {
      // station#2530 review M3: the level-triggered drain is gated behind
      // `conversationCanMutate` (`conversation-open-policy.ts`), which this
      // harness never resolves — it does not simulate the conversation-open
      // REST round trip at all. Seed 20's lineage child left
      // `conversationOpenPending: true` on this chat 179 seeds ago (the
      // conversation-binding side effect `handleOrchestrationEvent` applies
      // when a lineage child's `session.configured` arrives), which reads as
      // "resolving" forever absent that round trip and would silently zero
      // out the send oracle below for a reason that has nothing to do with
      // the drain itself. Force this test's policy state to what a real,
      // already-resolved conversation looks like before asserting sends.
      a.activeChatsStore.updateChat(conversationId, {
        queuedMessages: ['follow-up-199'],
        conversationOpenPending: false,
        conversationOpenFailed: false,
      });
      b.activeChatsStore.updateChat(conversationId, {
        queuedMessages: ['follow-up-199'],
        conversationOpenPending: false,
        conversationOpenFailed: false,
      });
      trace.push('queue.follow-up');
    }
    const cursor = store.headGlobalSequence();
    // The cursor B should present on ITS NEXT reconnect. A mid-turn bounce
    // (review M2) re-disconnects afterward, so this tracks whichever
    // disconnect was LAST — the seed-start one when nothing bounced, or the
    // most recent bounce's otherwise — rather than the pinned resumedId
    // checks below reading a stale seed-start value.
    let lastDisconnectCursor = cursor;
    let bounced = false;
    b.disconnect();
    const draft = `draft-${seed}`;
    store.appendEvent({
      eventId: `${draft}-event`,
      provider: 'claude',
      threadId: draft,
      createdAt,
      method: 'content.text-delta',
      itemId: draft,
      delta: 'discard',
    } as CanonicalRuntimeEvent);
    const deletedTailCursor = store.headGlobalSequence();
    store.deleteThread(draft);
    trace.push('draft.discard');
    if (seed === 20) {
      const child = `${conversationId}:session:continuation`;
      store.reserveNextConversationSession({
        conversationId,
        predecessorSessionId: conversationId,
        proposedSessionId: child,
        createdAt,
      });
      store.upsertSession({
        provider: 'claude',
        threadId: child,
        status: 'ready',
        createdAt,
        updatedAt: createdAt,
      });
      publish({
        eventId: 'lineage-child-configured',
        provider: 'claude',
        threadId: child,
        createdAt,
        method: 'session.configured',
        sessionId: child,
        metadata: { agentSlug: 'claude', userId },
      } as CanonicalRuntimeEvent);
      executionThreadId = child;
      trace.push('lineage.child');
    }
    const turnId = `turn-${seed}`;
    publish({
      eventId: `${turnId}-start`,
      provider: 'claude',
      threadId: executionThreadId,
      turnId,
      createdAt,
      method: 'turn.started',
      prompt: `seed ${seed}`,
      ...(seed % 9 === 0 ? { metadata: { trigger: 'provider' } } : {}),
    } as CanonicalRuntimeEvent);
    trace.push('turn.started');
    expect(
      store.headGlobalSequence(),
      `deleted-tail cursor seed=${seed} trace=${trace.join(',')}`,
    ).toBeGreaterThan(deletedTailCursor);
    const deltaCount = seed === 50 || seed % 3 === 0 ? 6 : 1;
    for (let index = 0; index < deltaCount; index++) {
      const deltaText = String(random());
      publish({
        eventId: `${turnId}-delta-${index}`,
        provider: 'claude',
        threadId: executionThreadId,
        turnId,
        createdAt,
        method: 'content.text-delta',
        itemId: `answer-${seed}`,
        delta: deltaText,
      } as CanonicalRuntimeEvent);
      turnDeltaText.set(turnId, (turnDeltaText.get(turnId) ?? '') + deltaText);
      trace.push('content.text-delta');
      await maybeBounceMidTurn(`delta-${index}`);
    }
    if (random() > 0.5) {
      publish({
        eventId: `${turnId}-tool-start`,
        provider: 'claude',
        threadId: executionThreadId,
        turnId,
        createdAt,
        method: 'tool.started',
        itemId: `tool-${seed}`,
        toolCallId: `tool-${seed}`,
        toolName: 'Read',
      } as CanonicalRuntimeEvent);
      trace.push('tool.started');
      await maybeBounceMidTurn('tool-started');
      publish({
        eventId: `${turnId}-tool-done`,
        provider: 'claude',
        threadId: executionThreadId,
        turnId,
        createdAt,
        method: 'tool.completed',
        itemId: `tool-${seed}`,
        toolCallId: `tool-${seed}`,
        toolName: 'Read',
        status: 'success',
      } as CanonicalRuntimeEvent);
      trace.push('tool.completed');
    }
    if (seed % 7 === 0) {
      publish({
        eventId: `${turnId}-request`,
        provider: 'claude',
        threadId: executionThreadId,
        turnId,
        createdAt,
        method: 'request.opened',
        requestId: `request-${seed}`,
        requestType: 'approval',
        title: 'Allow Read',
      } as CanonicalRuntimeEvent);
      trace.push('request.opened');
      await maybeBounceMidTurn('request-opened');
    }
    if (seed > 0 && seed % 7 === 1) {
      publish({
        eventId: `${turnId}-request-resolved`,
        provider: 'claude',
        threadId: executionThreadId,
        turnId,
        createdAt,
        method: 'request.resolved',
        requestId: `request-${seed - 1}`,
        status: 'approved',
      } as CanonicalRuntimeEvent);
      trace.push('request.resolved');
    }
    if (seed === 0) {
      const child = {
        producer: 'engine-subagent',
        reporterThreadId: conversationId,
        childId: 'seed-child',
        status: 'running',
        title: 'Explore',
        backgrounded: true,
      };
      publishViaService({
        eventId: 'child-upsert',
        provider: 'claude',
        threadId: conversationId,
        createdAt,
        method: 'child-work.updated',
        delta: { kind: 'upsert', item: child },
      } as CanonicalRuntimeEvent);
      publishViaService({
        eventId: 'child-settle',
        provider: 'claude',
        threadId: conversationId,
        createdAt,
        method: 'child-work.updated',
        delta: {
          kind: 'settle',
          producer: 'engine-subagent',
          reporterThreadId: conversationId,
          childId: 'seed-child',
          status: 'completed',
          result: { summary: 'Explored.' },
        },
      } as CanonicalRuntimeEvent);
      trace.push('child.upsert', 'child.settle');
    }
    if (seed === 1) {
      publishViaService({
        eventId: 'late-child-upsert',
        provider: 'claude',
        threadId: conversationId,
        createdAt,
        method: 'child-work.updated',
        delta: {
          kind: 'upsert',
          item: {
            producer: 'engine-subagent',
            reporterThreadId: conversationId,
            childId: 'late-child',
            status: 'running',
            title: 'Build',
          },
        },
      } as CanonicalRuntimeEvent);
      trace.push('child.upsert');
    }
    if (seed === 2) {
      publishViaService({
        eventId: 'late-child-settle',
        provider: 'claude',
        threadId: conversationId,
        createdAt,
        method: 'child-work.updated',
        delta: {
          kind: 'settle',
          producer: 'engine-subagent',
          reporterThreadId: conversationId,
          childId: 'late-child',
          status: 'completed',
        },
      } as CanonicalRuntimeEvent);
      trace.push('child.settle');
    }
    if (seed === 40) {
      const delegateId = 'delegate-seed-40';
      store.upsertSession({
        provider: 'claude',
        threadId: delegateId,
        status: 'ready',
        createdAt,
        updatedAt: createdAt,
      });
      publish({
        eventId: 'delegate-started',
        provider: 'claude',
        threadId: delegateId,
        createdAt,
        method: 'session.started',
        sessionId: delegateId,
        metadata: {
          taskId: delegateId,
          parentTaskId: conversationId,
          delegation: { mode: 'isolated-child', depth: 1, maxDepth: 3 },
          agentSlug: 'claude',
          userId,
        },
      } as CanonicalRuntimeEvent);
      publish({
        eventId: 'delegate-turn-started',
        provider: 'claude',
        threadId: delegateId,
        createdAt,
        method: 'turn.started',
        turnId: 'delegate-turn',
        prompt: 'Delegate work',
      } as CanonicalRuntimeEvent);
      publish({
        eventId: 'delegate-turn-completed',
        provider: 'claude',
        threadId: delegateId,
        createdAt,
        method: 'turn.completed',
        turnId: 'delegate-turn',
        outputText: 'Done',
      } as CanonicalRuntimeEvent);
      trace.push('delegate.start', 'delegate.complete');
    }
    if (seed === 199) {
      // The drain only fires on a turn boundary; nothing must have sent the
      // queued follow-up while this turn was still open.
      const sentWhileOpen = requests.some(
        (entry) =>
          entry.url.endsWith('/api/orchestration/chat') &&
          entry.method === 'POST' &&
          typeof entry.body === 'string' &&
          entry.body.includes('follow-up-199'),
      );
      expect(sentWhileOpen, `seed=${seed} no send while turn open`).toBe(false);
    }
    const terminal =
      seed % 17 === 16
        ? 'turn.aborted'
        : seed % 13 === 12
          ? 'runtime.error'
          : 'turn.completed';
    if (seed !== 50) {
      publish({
        eventId: `${turnId}-terminal`,
        provider: 'claude',
        threadId: executionThreadId,
        turnId,
        createdAt,
        method: terminal,
        ...(terminal === 'turn.aborted' ? { reason: 'interrupted' } : {}),
        ...(terminal === 'runtime.error'
          ? { severity: 'error', message: 'provider failed' }
          : {}),
      } as CanonicalRuntimeEvent);
      trace.push(terminal);
    } else {
      trace.push('turn.left-open');
    }
    const head = store.headGlobalSequence();
    expect(head, `seed=${seed} trace=${trace.join(',')}`).toBeGreaterThan(
      deletedTailCursor,
    );
    await vi.waitFor(
      () => {
        const activity =
          a.activeChatsStore.getSnapshot()[conversationId]
            ?.conversationActivity;
        expect(activity?.asOfSequence).toBe(head);
        if (seed === 50) expect(activity?.openTurn?.turnId).toBe(turnId);
      },
      { timeout: 5_000 },
    );
    // Captured HERE, not at the seed's start: a mid-turn bounce (review M2)
    // already made its own requests, and `before` must scope this wait to
    // the FINAL reconnect only.
    const before = requests.length;
    if (seed === 30) {
      b.unmountTranscript();
      b = await clientGraph(conversationId, { outboundData: b.outboundData });
      trace.push('client.reload');
    } else {
      b.ensure();
    }
    await until(() => requests.length > before);
    const resumedId = requests.at(-1)?.headers.get('Last-Event-ID');
    // A bounced seed's exact resumed-cursor shape depends on whichever of
    // the 5 reconnect methods the fuzzing last picked (review M2) — a
    // 'reload' bounce, for instance, leaves this exactly like seed 30's
    // `resumedId === null` case. The STATE convergence each bounce already
    // asserted (`assertClientsConverged`) is what matters here, so the
    // pinned exact-cursor check below runs only for the scripted
    // (unbounced) seeds.
    if (!bounced) {
      expect(
        seed === 30
          ? resumedId === null
          : seed === 51
            ? [String(cursor), String(cursor - 1)].includes(resumedId ?? '')
            : resumedId === String(lastDisconnectCursor),
        `seed=${seed} trace=${trace.join(',')} resumed=${resumedId}`,
      ).toBe(true);
    }
    await vi.waitFor(
      () => {
        const activity =
          b.activeChatsStore.getSnapshot()[conversationId]
            ?.conversationActivity;
        expect(activity?.asOfSequence).toBe(head);
        if (seed === 50) expect(activity?.openTurn?.turnId).toBe(turnId);
      },
      { timeout: 5_000 },
    );
    const seedLabel = `seed=${seed} trace=${trace.join(',')}`;
    await assertClientsConverged(a, b, conversationId, head, seedLabel);
    // station#2530 review H1: the transcript itself, not only the activity
    // records and store fields above. Turn 50 is deliberately left open
    // (mid-turn) at this point in the seed loop and closes later at seed 51
    // — the shell still owns its rendering, so its oracle check waits for
    // that terminal instead of running against an incomplete answer here.
    if (seed !== 50) {
      const { aMessages, bMessages } = await assertTranscriptsConverged(
        a,
        b,
        seedLabel,
      );
      assertDeltaTextRenderedOnce(
        aMessages,
        turnDeltaText.get(turnId),
        `${seedLabel} oracle(A) ${turnId}`,
      );
      assertDeltaTextRenderedOnce(
        bMessages,
        turnDeltaText.get(turnId),
        `${seedLabel} oracle(B) ${turnId}`,
      );
    }
    if (seed === 51) {
      // turn-50 closed just now (the late `turn.completed` published above)
      // — its own deltas (published back at seed 50) must render exactly
      // once now that the shell has handed off to the durable projection.
      const { aMessages, bMessages } = await assertTranscriptsConverged(
        a,
        b,
        `${seedLabel} turn-50 late-close`,
      );
      assertDeltaTextRenderedOnce(
        aMessages,
        turnDeltaText.get('turn-50'),
        `${seedLabel} oracle(A) turn-50`,
      );
      assertDeltaTextRenderedOnce(
        bMessages,
        turnDeltaText.get('turn-50'),
        `${seedLabel} oracle(B) turn-50`,
      );
    }
    if (seed === 199) {
      // station#2530 review M3: an oracle on the actual outbound send, not
      // only the A-vs-B store comparison above (which two independent
      // permanent drops could satisfy identically). Station's queue drain is
      // a PER-CLIENT local copy with no cross-device claim yet (#2530 is
      // that very ticket) — station#2530's own review is explicit that
      // "once per client" is the real semantic here, not "once globally".
      const isFollowupSend = (entry: (typeof requests)[number]) =>
        entry.url.endsWith('/api/orchestration/chat') &&
        entry.method === 'POST' &&
        typeof entry.body === 'string' &&
        entry.body.includes('follow-up-199');
      const sends = requests.filter(isFollowupSend);
      expect(
        sends.length,
        `${seedLabel} queued follow-up sent once/client`,
      ).toBe(2);
      const clientTurnIds = new Set(
        sends.map((entry) => {
          try {
            return (JSON.parse(entry.body ?? '{}') as { clientTurnId?: string })
              .clientTurnId;
          } catch {
            return undefined;
          }
        }),
      );
      expect(
        clientTurnIds.size,
        `${seedLabel} each client's send is its own attempt`,
      ).toBe(2);
    }
  }
  // A restored database can have the same numeric sequence as an older one.
  // The old cursor is then valid by number but foreign by durable identity.
  const oldEpoch = store.streamEpoch();
  const replacement = await setup();
  replacement.publish({
    eventId: 'replacement-configured',
    provider: 'claude',
    threadId: conversationId,
    createdAt,
    method: 'session.configured',
    sessionId: conversationId,
    metadata: { agentSlug: 'claude', userId },
  } as CanonicalRuntimeEvent);
  expect(replacement.store.headGlobalSequence()).toBe(1);
  expect(replacement.store.streamEpoch()).not.toBe(oldEpoch);
  const response = await replacement.app.fetch(
    new Request(`${apiBase}/api/orchestration/events`, {
      headers: { 'Last-Event-ID': '1', 'X-Station-Stream-Epoch': oldEpoch },
    }),
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let wire = '';
  while (!wire.includes('event: orchestration:caughtUp')) {
    const next = await reader.read();
    if (next.done) throw new Error(`replacement stream ended: ${wire}`);
    wire += decoder.decode(next.value);
  }
  await reader.cancel();
  expect(wire).toContain('event: orchestration:snapshot');
  expect(wire).toContain(`"epoch":"${replacement.store.streamEpoch()}"`);
}, 150_000);
