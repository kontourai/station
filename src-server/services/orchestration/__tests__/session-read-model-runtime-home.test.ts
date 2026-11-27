/**
 * #5050: the session read model classified each row's `cwd` ("is this a
 * folder Station made for the chat") against a runtime home it re-admitted
 * per row. Admission walks every path component with `lstat`/`realpath`, so a
 * build cost one filesystem walk per session. The home is now admitted once
 * per build at `buildSessionReadModel` and handed to the summary builder.
 *
 * Real EventStore and OrchestrationService; the admission resolver is spied
 * at its package boundary and still runs for real.
 */
import { join } from 'node:path';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { resolveAdmittedRuntimeHome } from '@kontourai/station-shared/runtime-path-resolver';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { resolveHomeDir } from '../../../utils/paths.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

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
  const createdAt = new Date(2026, 0, 1, 0, 0, index).toISOString();
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
    metadata: { userId: 'local-operator', agentSlug: 'claude' },
  } as never);
}

/** A store of `count` sessions: alternately in this home's scratch root and in a user folder. */
function world(count: number) {
  const dir = makeTempDir('station-read-model-home-');
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
  const service = new OrchestrationService({
    eventStore: store,
    adoptionLedger: store.createAdoptionLedger(),
    eventBus: new EventBus(),
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    logger: { debug() {}, warn() {} },
  } as never);
  service.initialize();
  return { service, expected };
}

/** Runtime-home admissions made by one read-model build. */
async function admissionsDuringRead(service: OrchestrationService) {
  // `listSessionReadModel` first refreshes adapter state (`listSessions`);
  // run that outside the counted window so only the build is measured.
  await service.listSessions(INTERNAL_SESSION_READ_SCOPE);
  const admit = vi.mocked(resolveAdmittedRuntimeHome);
  admit.mockClear();
  const sessions = await service.listSessionReadModel(
    INTERNAL_SESSION_READ_SCOPE,
    { purpose: 'session-list' },
  );
  return { sessions, admissions: admit.mock.calls.length };
}

describe('session read model runtime-home admission (#5050)', () => {
  test('a build admits the runtime home once, however many sessions it lists', async () => {
    const small = world(2);
    const large = world(150);
    const smallRead = await admissionsDuringRead(small.service);
    const largeRead = await admissionsDuringRead(large.service);
    expect(smallRead.sessions).toHaveLength(3);
    expect(largeRead.sessions).toHaveLength(151);
    expect(largeRead.admissions).toBe(1);
    expect(smallRead.admissions).toBe(largeRead.admissions);
  });

  test('a later build admits the home again rather than reusing an earlier answer', async () => {
    const { service } = world(4);
    expect((await admissionsDuringRead(service)).admissions).toBe(1);
    expect((await admissionsDuringRead(service)).admissions).toBe(1);
  });

  test('scratch-root and outside sessions keep their classification', async () => {
    const { service, expected } = world(6);
    const { sessions } = await admissionsDuringRead(service);
    const flagged = new Map(
      sessions.map((session) => [
        session.threadId,
        session.cwdManagedWorkspace === true,
      ]),
    );
    expect(flagged).toEqual(new Map([...expected, ['no-cwd', false]]));
    expect([...expected.values()]).toContain(true);
    expect([...expected.values()]).toContain(false);
    expect(
      sessions.find((session) => session.threadId === 'no-cwd')?.cwd,
    ).toBeUndefined();
  });
});
