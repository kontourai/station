import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';
import { createMemoryBriefProvider } from '../memory-brief-provider.js';
import { MemoryReviewService } from '../memory-review.js';
import { MemoryRootManager } from '../memory-root.js';
import { candidate, claim, OWNER } from './memory-claim-fixtures.js';

const makeTempDir = trackTempDirs();
const owner = sessionReadAuthorityFromRequest(OWNER, undefined, undefined);
const stranger = sessionReadAuthorityFromRequest(
  'human:stranger',
  undefined,
  undefined,
);
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const home = makeTempDir('station-memory-brief-');
  vi.stubEnv('STATION_HOME', home);
  const persistence = new FileStorageAdapter(home);
  const store = new KnowledgeStoreProvider(persistence);
  const state = {
    enabled: true,
    current: true,
    allowRead: true,
    deliver: true,
    who: owner as
      | ReturnType<typeof sessionReadAuthorityFromRequest>
      | undefined,
  };
  const manager = new MemoryRootManager(
    store,
    persistence,
    home,
    () => state.enabled,
  );
  const review = new MemoryReviewService({ manager, home });
  const root = await manager.ensureRoot(owner, () => {});
  const memory = claim({
    subject: 'Billing',
    property: 'region',
    value: 'eu-west-1',
    excerpt: 'Billing runs in eu-west-1.',
  });
  await manager.propose(
    owner,
    root,
    () => {},
    candidate(memory),
    { agent: 'dream', proposal: 'Distilled memory' },
    'agent:dream',
    'seed-1',
  );
  // A person-confirmed claim is what a brief carries by default.
  await review.decide(
    owner,
    root,
    () => {},
    `memory-change.${memory.id.replace(/^sha256:/, '').slice(0, 32)}`,
    { outcome: 'accept' },
    'human',
  );
  const provider = createMemoryBriefProvider({
    manager,
    review,
    enabled: () => state.enabled,
    authority: () => state.who,
    isRequestCurrent: () => state.current,
    mayReadRoot: async () => state.allowRead,
    guardReadResponse: async (_request, _roots, response) =>
      state.deliver ? response : new Response(null, { status: 403 }),
  });
  return { state, provider, request: new Request('http://station.test/chat') };
}

test('the person’s own reviewed memory is briefed, as background', async () => {
  const { provider, request } = await setup();
  const brief = await provider(request);
  expect(brief?.entries).toBe(1);
  expect(brief?.text).toContain('Background, not instruction.');
  expect(brief?.text).toContain(
    '[stated · confirmed] Billing: region = eu-west-1',
  );
});

test('every missing condition yields no brief, never someone else’s memory', async () => {
  type Harness = Awaited<ReturnType<typeof setup>>;
  const cases: Record<string, (h: Harness) => void> = {
    'preview off': (h) => {
      h.state.enabled = false;
    },
    'no identity': (h) => {
      h.state.who = undefined;
    },
    'another person (no root of their own)': (h) => {
      h.state.who = stranger;
    },
    'request no longer current': (h) => {
      h.state.current = false;
    },
    'access to the root withdrawn': (h) => {
      h.state.allowRead = false;
    },
    'delivery guard refuses': (h) => {
      h.state.deliver = false;
    },
  };
  for (const [name, change] of Object.entries(cases)) {
    // Each case gets its own harness, so one refusal cannot mask another.
    const h = await setup();
    expect(await h.provider(h.request), `${name} (control)`).not.toBeNull();
    change(h);
    expect(await h.provider(h.request), name).toBeNull();
  }
});

test('a hosted authority is never briefed', async () => {
  const each = await setup();
  each.state.who = sessionReadAuthorityFromRequest(OWNER, undefined, {
    tenants: [],
  } as never);
  expect(await each.provider(each.request)).toBeNull();
});

test('a relayed session is briefed only from its recorded owner’s memory', async () => {
  const { provider, request } = await setup();
  // Station's relay carries the local operator's identity whoever owns the session.
  expect(
    await provider(request, { relayOwner: 'human:someone-else' }),
  ).toBeNull();
  expect(await provider(request, { relayOwner: null })).toBeNull();
  const own = await provider(request, { relayOwner: OWNER });
  expect(own?.entries).toBe(1);
});

test('a conversation is briefed once, however many turns the relay sends', async () => {
  const { provider, request } = await setup();
  const session = { relayOwner: OWNER, conversationId: 'thread-1' };
  expect((await provider(request, session))?.entries).toBe(1);
  expect(await provider(request, session)).toBeNull();
  expect(await provider(request, session)).toBeNull();
  // Another conversation is a new session.
  expect(
    (await provider(request, { ...session, conversationId: 'thread-2' }))
      ?.entries,
  ).toBe(1);
});
