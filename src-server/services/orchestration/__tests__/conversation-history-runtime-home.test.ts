/**
 * #5092: the conversation history list built each row's summary with the
 * "is `cwd` a folder Station made for the chat" check resolving the runtime
 * home per row. Admission walks every path component with `lstat`/`realpath`,
 * so one list request cost one filesystem walk per record. `list()` now
 * admits the home at most once per request and hands a reader to each row's
 * summary, the same seam #5091 (#5050) gave the session read model.
 *
 * Real EventStore and ConversationHistoryReadService; the admission resolver
 * is spied at its package boundary and still runs for real, and the summary
 * builder is wrapped (not replaced) so each row's classification is observed.
 */
import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { resolveAdmittedRuntimeHome } from '@kontourai/station-shared/runtime-path-resolver';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { resolveHomeDir } from '../../../utils/paths.js';
import { ConversationHistoryReadService } from '../conversation-history-read-service.js';
import { EventStore } from '../event-store.js';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

vi.mock('@kontourai/station-shared/runtime-path-resolver', async (load) => {
  const actual =
    await load<
      typeof import('@kontourai/station-shared/runtime-path-resolver')
    >();
  return {
    ...actual,
    resolveAdmittedRuntimeHome: vi.fn(actual.resolveAdmittedRuntimeHome),
  };
});

vi.mock('../orchestration-session-state.js', async (load) => {
  const actual =
    await load<typeof import('../orchestration-session-state.js')>();
  return {
    ...actual,
    buildOrchestrationSessionSummary: vi.fn(
      actual.buildOrchestrationSessionSummary,
    ),
  };
});

const OWNER = 'owner-alpha';
const makeTempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function seed(
  store: EventStore,
  threadId: string,
  index: number,
  cwd?: string,
) {
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  store.upsertSession({
    provider: 'claude',
    threadId,
    status: 'ready',
    ...(cwd ? { cwd } : {}),
    createdAt,
    updatedAt: createdAt,
  });
  store.appendEvent({
    eventId: `${threadId}:start`,
    provider: 'claude',
    threadId,
    createdAt,
    method: 'session.started',
    sessionId: threadId,
    metadata: { userId: OWNER, agentSlug: 'claude' },
  });
}

/** `count` records alternately in this home's scratch root and in a user folder, plus one without a `cwd`. */
function world(count: number) {
  const dir = makeTempDir('station-history-home-');
  const store = new EventStore(join(dir, 'orchestration.sqlite'));
  stores.push(store);
  const scratchRoot = join(resolveHomeDir(), 'scratch');
  const outside = join(dir, 'user-project');
  const expected = new Map<string, boolean>();
  for (let index = 0; index < count; index += 1) {
    const inScratch = index % 2 === 0;
    const threadId = `${inScratch ? 'scratch' : 'outside'}-${index}`;
    seed(
      store,
      threadId,
      index,
      inScratch ? join(scratchRoot, threadId) : join(outside, threadId),
    );
    expected.set(threadId, inScratch);
  }
  seed(store, 'no-cwd', count);
  const reader = new ConversationHistoryReadService({
    eventStore: store,
    canReadSession: () => true,
    hydratePersistedSession: (threadId) => store.readSessionByThread(threadId),
    loadedSessionForThread: () => undefined,
    observeAnswerability: (_threadId, _provider, observedAt) => ({
      threadAttachment: 'detached',
      providerRegistered: true,
      observedBy: 'test',
      observedAt,
    }),
  });
  return { reader, expected };
}

/** Runtime-home admissions, and each row's classification, for one list request. */
async function listRequest(reader: ConversationHistoryReadService) {
  const admit = vi.mocked(resolveAdmittedRuntimeHome);
  const build = vi.mocked(buildOrchestrationSessionSummary);
  admit.mockClear();
  build.mockClear();
  const page = await reader.list({
    authority: sessionReadAuthorityFromRequest(OWNER, undefined, undefined),
    limit: 100,
  });
  const managed = new Map(
    build.mock.results.map((result) => {
      const summary = result.value as ReturnType<
        typeof buildOrchestrationSessionSummary
      >;
      return [summary.threadId, summary.cwdManagedWorkspace === true] as const;
    }),
  );
  return { page, managed, admissions: admit.mock.calls.length };
}

describe('conversation history runtime-home admission (#5092)', () => {
  test('a list request admits the runtime home once, however many records it lists', async () => {
    const small = await listRequest(world(2).reader);
    const large = await listRequest(world(60).reader);
    expect(small.page.items).toHaveLength(3);
    expect(large.page.items).toHaveLength(61);
    expect(large.managed.size).toBe(61);
    expect(large.admissions).toBe(1);
    expect(small.admissions).toBe(large.admissions);
  });

  test('a later list request admits the home again rather than reusing an earlier answer', async () => {
    const { reader } = world(4);
    expect((await listRequest(reader)).admissions).toBe(1);
    expect((await listRequest(reader)).admissions).toBe(1);
  });

  test('scratch-root and outside records keep their classification', async () => {
    const { reader, expected } = world(6);
    const { managed } = await listRequest(reader);
    expect(managed).toEqual(new Map([...expected, ['no-cwd', false]]));
    expect([...expected.values()]).toContain(true);
    expect([...expected.values()]).toContain(false);
  });
});
