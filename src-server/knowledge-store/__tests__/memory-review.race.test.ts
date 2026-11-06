import type { KitCreateProposal } from '@kontourai/corpus-store';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import {
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
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

  // Pause after the snapshot's root lease is released, so the intervening
  // decision runs before the first review acts on its stale snapshot.
  class SlowManager extends MemoryRootManager {
    override async withProposals<T>(
      authority: SessionReadAuthority,
      root: KnowledgeStoreRoot,
      assertCurrent: () => void,
      operation: (proposals: KitCreateProposal[]) => Promise<T>,
    ): Promise<T> {
      const result = await super.withProposals(
        authority,
        root,
        assertCurrent,
        operation,
      );
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
