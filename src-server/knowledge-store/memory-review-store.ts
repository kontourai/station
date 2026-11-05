import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import type { ReviewDecision, ReviewSessionEvent } from '@kontourai/survey';
import { assertExistingPathInside } from '../utils/path-containment.js';

/**
 * The person's own review records for their private memory: Survey
 * `ReviewDecision`s and `ReviewSessionEvent`s, kept as plain JSON beside (not
 * inside) the Corpus store, so Corpus never sees a file it did not write.
 *
 * This is one atomic file under the existing file-mutation lock, the same
 * primitive the memory root uses. Each record is the whole effect, so there is
 * nothing for Monument to sequence afterwards. A decision is keyed by its name;
 * recording the same name twice returns the first record, so a retried request
 * cannot double-count.
 *
 * Records hold only identifiers, decision fields and, for a correction, the
 * reviewer's own value. When the memory they refer to is erased, `retain`
 * drops them on the next load.
 */
export interface MemoryReviewState {
  version: 1;
  decisions: ReviewDecision[];
  events: ReviewSessionEvent[];
}

const EMPTY: MemoryReviewState = { version: 1, decisions: [], events: [] };
/** Same order of magnitude as the Kit's per-run history limit; refuse past it. */
const MAX_RECORDS = 100_000;

function isState(value: unknown): value is MemoryReviewState {
  const state = value as Partial<MemoryReviewState> | null;
  return (
    !!state &&
    state.version === 1 &&
    Array.isArray(state.decisions) &&
    Array.isArray(state.events)
  );
}

export class MemoryReviewStore {
  private readonly file: string;

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
  }

  private ensureDirectory(): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertExistingPathInside(resolve(this.home), dir, 'Memory review records');
  }

  read(): MemoryReviewState {
    try {
      assertExistingPathInside(
        resolve(this.home),
        this.file,
        'Memory review records',
      );
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!isState(parsed))
        throw new Error('Memory review records are unreadable.');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return structuredClone(EMPTY);
      throw error;
    }
  }

  /** Runs `change` on the current state under the lock; writes only if it returns a new state. */
  async mutate<T>(
    assertCurrent: () => void,
    change: (state: MemoryReviewState) => {
      state: MemoryReviewState;
      result: T;
    },
  ): Promise<T> {
    this.ensureDirectory();
    assertCurrent();
    const release = await acquireFileMutationLockAsync(`${this.file}.lock`);
    try {
      assertCurrent();
      const { state, result } = change(this.read());
      if (
        state.decisions.length > MAX_RECORDS ||
        state.events.length > MAX_RECORDS
      )
        throw new Error('Memory review history is full.');
      assertCurrent();
      const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      renameSync(temporary, this.file);
      chmodSync(this.file, 0o600);
      return result;
    } finally {
      await release();
    }
  }
}
