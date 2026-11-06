import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import { KnowledgeStoreProvider } from '../knowledge-store-provider.js';
import { MemoryReviewService } from '../memory-review.js';
import { MemoryRootManager } from '../memory-root.js';
import { candidate, claim, OWNER } from './memory-claim-fixtures.js';

const makeTempDir = trackTempDirs();
const owner = sessionReadAuthorityFromRequest(OWNER, undefined, undefined);
afterEach(() => vi.unstubAllEnvs());
const itemOf = (id: string) =>
  `memory-change.${id.replace(/^sha256:/, '').slice(0, 32)}`;

test('a review that read the store before another decision landed does not erase that decision', async () => {
  const home = makeTempDir('station-memory-race-');
  vi.stubEnv('STATION_HOME', home);
  const persistence = new FileStorageAdapter(home);
  const store = new KnowledgeStoreProvider(persistence);
  let between: (() => Promise<void>) | undefined;

  // Runs `between` once, after the first listing has been read and before it is returned:
  // the window in which a stale snapshot would be acted on.
  class SlowManager extends MemoryRootManager {
    override async listProposals(
      ...args: Parameters<MemoryRootManager['listProposals']>
    ) {
      const result = await super.listProposals(...args);
      const hook = between;
      between = undefined;
      if (hook) await hook();
      return result;
    }
  }
  const manager = new SlowManager(store, persistence, home, () => true);
  const review = new MemoryReviewService({ manager, home });
  const root = await manager.ensureRoot(owner, () => {});
  const propose = (memory: ReturnType<typeof claim>, key: string) =>
    manager.propose(
      owner,
      root,
      () => {},
      candidate(memory),
      { agent: 'dream', proposal: 'x' },
      'agent:dream',
      key,
    );

  const first = claim({
    subject: 'Billing',
    property: 'region',
    value: 'eu-west-1',
    excerpt: 'Billing runs in eu-west-1.',
  });
  const second = claim({
    subject: 'Search',
    property: 'engine',
    value: 'Typesense',
    excerpt: 'Search uses Typesense.',
  });
  await propose(first, 'a');

  between = async () => {
    await propose(second, 'b');
    await review.decide(
      owner,
      root,
      () => {},
      itemOf(second.id),
      { outcome: 'accept' },
      'human',
    );
  };
  await review.decide(
    owner,
    root,
    () => {},
    itemOf(first.id),
    { outcome: 'accept' },
    'human',
  );

  const recall = await review.recall(owner, root, () => {}, '');
  const labels = Object.fromEntries(
    recall.entries.map((entry) => [entry.value, entry.review.label]),
  );
  expect(labels).toEqual({ 'eu-west-1': 'confirmed', Typesense: 'confirmed' });
});
