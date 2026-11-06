import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import type { ReviewDecision, ReviewSessionEvent } from '@kontourai/survey';
import { JsonFileStore } from '../services/infra/json-store.js';
import { assertExistingPathInside } from '../utils/path-containment.js';

/**
 * The person's own review records for their private memory: Survey
 * `ReviewDecision`s and `ReviewSessionEvent`s, kept as plain JSON beside (not
 * inside) the Corpus store, so Corpus never sees a file it did not write.
 *
 * This is one file under the existing file-mutation lock, the same primitive
 * the memory root uses, written through the shared `JsonFileStore` (bounded
 * read, crash-safe atomic write that keeps one prior complete copy as
 * `review.json.previous`). Each record is the whole effect, so there is nothing
 * for Monument to sequence afterwards. A decision is keyed by its name;
 * recording the same name twice returns the first record, so a retried request
 * cannot double-count.
 *
 * Records hold only identifiers, decision fields and, for a correction, the
 * reviewer's own value. When the memory they refer to is erased they are
 * filtered on reads. Station erasure and reconciliation prune them and remove
 * the prior copy before completing cleanup. External copies have their own retention.
 */
export interface MemoryReviewState {
  version: 1;
  decisions: ReviewDecision[];
  events: ReviewSessionEvent[];
  bindings?: Record<string, string>;
}

const EMPTY: MemoryReviewState = { version: 1, decisions: [], events: [] };
/** Same order of magnitude as the Kit's per-run history limit; refuse past it. */
const MAX_RECORDS = 100_000;

function isState(value: unknown): value is MemoryReviewState {
  const state = value as Partial<MemoryReviewState> | null;
  const bindings = state?.bindings;
  return (
    !!state &&
    state.version === 1 &&
    Array.isArray(state.decisions) &&
    Array.isArray(state.events) &&
    (bindings === undefined ||
      (bindings !== null &&
        typeof bindings === 'object' &&
        !Array.isArray(bindings) &&
        Object.keys(bindings).length <= MAX_RECORDS &&
        Object.entries(bindings).every(
          ([key, id]) =>
            /^memory-change\.[a-f0-9]{32}$/.test(key) &&
            typeof id === 'string' &&
            id.length > 0 &&
            id.length <= 200,
        )))
  );
}

export function bindReviewItems(
  state: MemoryReviewState,
  live: Record<string, string>,
): Record<string, string> {
  const names = new Set([
    ...state.decisions.map((decision) => decision.spec.reviewItemName),
    ...state.events.flatMap((event) =>
      event.spec.reviewItemName ? [event.spec.reviewItemName] : [],
    ),
  ]);
  const bindings = { ...state.bindings };
  for (const name of names)
    if (!bindings[name] && live[name]) bindings[name] = live[name];
  return bindings;
}

const MAX_READ_BYTES = 64 * 1024 * 1024;

function decode(text: string): MemoryReviewState {
  const parsed: unknown = JSON.parse(text);
  if (!isState(parsed))
    throw new Error('Memory review records are unreadable.');
  return parsed;
}

export class MemoryReviewStore {
  private readonly file: string;
  private readonly json: JsonFileStore<MemoryReviewState>;

  constructor(
    private readonly home: string,
    ownerHash: string,
  ) {
    this.file = join(
      resolve(home),
      'knowledge',
      'memory-review',
      ownerHash,
      'review.json',
    );
    this.json = new JsonFileStore<MemoryReviewState>(this.file, EMPTY, {
      onCorruption: 'throw',
      maxReadBytes: MAX_READ_BYTES,
      durableAtomicWrite: true,
    });
  }

  private ensureDirectory(): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertExistingPathInside(resolve(this.home), dir, 'Memory review records');
  }

  read(): MemoryReviewState {
    assertExistingPathInside(
      resolve(this.home),
      this.file,
      'Memory review records',
    );
    return this.json.read(decode);
  }

  async bindItems(live: Record<string, string>): Promise<void> {
    if (!existsSync(this.file) && !existsSync(`${this.file}.previous`)) return;
    await this.mutate(
      () => {},
      (state) => ({
        state: { ...state, bindings: bindReviewItems(state, live) },
        result: undefined,
      }),
    );
  }

  async pruneItems(live: Record<string, string>): Promise<void> {
    if (!existsSync(this.file) && !existsSync(`${this.file}.previous`)) return;
    await this.mutate(
      () => {},
      (state) => {
        const keep = (id: string) =>
          Boolean(
            live[id] &&
              (!state.bindings?.[id] || state.bindings[id] === live[id]),
          );
        return {
          state: {
            version: 1,
            decisions: state.decisions.filter((d) =>
              keep(d.spec.reviewItemName),
            ),
            events: state.events.filter(
              (e) => !e.spec.reviewItemName || keep(e.spec.reviewItemName),
            ),
            bindings: Object.fromEntries(
              Object.entries(state.bindings ?? {}).filter(([id]) => keep(id)),
            ),
          },
          result: undefined,
        };
      },
    );
    try {
      unlinkSync(`${this.file}.previous`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** Runs `change` on the current state under the lock and writes the state it returns. `change` may read other stores: the lock is held across it. */
  async mutate<T>(
    assertCurrent: () => void,
    change: (
      state: MemoryReviewState,
    ) =>
      | { state: MemoryReviewState; result: T }
      | Promise<{ state: MemoryReviewState; result: T }>,
  ): Promise<T> {
    this.ensureDirectory();
    assertCurrent();
    const release = await acquireFileMutationLockAsync(`${this.file}.lock`);
    try {
      assertCurrent();
      const { state, result } = await change(this.read());
      if (!isState(state))
        throw new Error('Memory review records are invalid.');
      if (
        state.decisions.length > MAX_RECORDS ||
        state.events.length > MAX_RECORDS
      )
        throw new Error('Memory review history is full.');
      assertCurrent();
      this.json.write(state);
      return result;
    } finally {
      await release();
    }
  }
}
