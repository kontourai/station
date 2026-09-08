import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CONVERSATION_INTENT_SUMMARY_MAX_ITEMS,
  type ConversationIntentSummaryV2,
} from '@kontourai/station-contracts/conversation-intent-summary';
import { publishJsonFileWithOwnedLock } from '@kontourai/station-shared/json-file-storage';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { redactDeep } from '@kontourai/station-shared/redaction';

/** v1 shape is retained only so existing local sidecars remain readable. */
export interface StoredSessionSummaryV1 {
  text: string;
  model: string;
  generatedAt: string;
  summarizedFromMessageId: string;
  summarizedThroughMessageId: string;
  summarizedMessageCount: number;
  sourceMessageCount: number;
  partialMessageIncluded: boolean;
}

export type StoredSessionSummary = Omit<
  ConversationIntentSummaryV2,
  'stale'
> & {
  /** A dismissal hides a valid record; it is not destructive deletion. */
  dismissedAt?: string;
};

/** The v2 coordinate deliberately survives agent and engine handoff. */
export interface SessionSummaryCoordinate {
  ownerScope: string;
  conversationId: string;
  /** Read only for locating the old v1 sidecar; never part of v2 identity. */
  agentSlug?: string;
}

const isString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4_096;
const MAX_SUMMARY_BYTES = 32 * 1024;
const MAX_LIST_ITEMS = CONVERSATION_INTENT_SUMMARY_MAX_ITEMS;
const isBoundedCount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 10_000;
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_LIST_ITEMS &&
  value.every(isString);
const isRange = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const range = value as Record<string, unknown>;
  return (
    isString(range.fromMessageId) &&
    isString(range.throughMessageId) &&
    isBoundedCount(range.messageCount)
  );
};
const isVerificationRef = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    ref.kind === 'task-turn' &&
    ((ref.state === 'observed' &&
      isString(ref.taskId) &&
      isString(ref.turnId) &&
      isString(ref.eventId)) ||
      (ref.state === 'unavailable' &&
        (ref.unavailableReason === 'not-captured-by-station' ||
          ref.unavailableReason === 'not-authorized' ||
          ref.unavailableReason === 'revoked')))
  );
};
const isUsageReceipt = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    receipt.state === 'unknown' ||
    (receipt.state === 'observed' &&
      Number.isInteger(receipt.inputTokens) &&
      Number.isInteger(receipt.outputTokens))
  );
};
const isRelatedEvidenceRef = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (
    ref.kind === 'task-turn' &&
    isString(ref.taskId) &&
    isString(ref.turnId) &&
    isString(ref.eventId)
  );
};
const isContextBoundary = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const boundary = value as Record<string, unknown>;
  return (
    isString(boundary.boundaryId) &&
    (boundary.policy === 'continue-from-history' ||
      boundary.policy === 'empty-next-cold-start') &&
    typeof boundary.priorTranscriptInjected === 'boolean'
  );
};

/** Future/corrupt v2 records are unavailable, never partially projected. */
export function isStoredSessionSummary(
  value: unknown,
): value is StoredSessionSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return (
    summary.version === 2 &&
    isString(summary.text) &&
    isString(summary.overview) &&
    isStringArray(summary.goals) &&
    isStringArray(summary.constraints) &&
    isStringArray(summary.progress) &&
    isStringArray(summary.nextSteps) &&
    isStringArray(summary.reportedCompletion) &&
    Array.isArray(summary.relatedEvidenceRefs) &&
    summary.relatedEvidenceRefs.length <= MAX_LIST_ITEMS &&
    summary.relatedEvidenceRefs.every(isRelatedEvidenceRef) &&
    Array.isArray(summary.verificationRefs) &&
    summary.verificationRefs.length <= MAX_LIST_ITEMS &&
    summary.verificationRefs.every(isVerificationRef) &&
    isString(summary.model) &&
    isString(summary.generatedAt) &&
    isString(summary.sourceRevision) &&
    isRange(summary.sourceRange) &&
    Array.isArray(summary.sourceRanges) &&
    summary.sourceRanges.length > 0 &&
    summary.sourceRanges.length <= MAX_LIST_ITEMS &&
    summary.sourceRanges.every(isRange) &&
    isBoundedCount(summary.sourceMessageCount) &&
    typeof summary.partialMessageIncluded === 'boolean' &&
    typeof summary.contextBoundaryCount === 'number' &&
    Array.isArray(summary.contextBoundaries) &&
    summary.contextBoundaries.length <= MAX_LIST_ITEMS &&
    summary.contextBoundaries.every(isContextBoundary) &&
    isUsageReceipt(summary.generationUsage) &&
    (summary.dismissedAt === undefined || isString(summary.dismissedAt))
  );
}

export function isStoredSessionSummaryV1(
  value: unknown,
): value is StoredSessionSummaryV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return (
    isString(summary.text) &&
    isString(summary.model) &&
    isString(summary.generatedAt) &&
    isString(summary.summarizedFromMessageId) &&
    isString(summary.summarizedThroughMessageId) &&
    isBoundedCount(summary.summarizedMessageCount) &&
    isBoundedCount(summary.sourceMessageCount) &&
    typeof summary.partialMessageIncluded === 'boolean' &&
    summary.version === undefined
  );
}

export class FileSessionSummaryStore {
  constructor(private readonly projectHomeDir: string) {}

  private v2Path(coordinate: SessionSummaryCoordinate): string {
    return join(
      this.projectHomeDir,
      'conversation-intent-summaries',
      'v2',
      encodeURIComponent(coordinate.ownerScope),
      `${encodeURIComponent(coordinate.conversationId)}.json`,
    );
  }

  private v1Path(coordinate: Required<SessionSummaryCoordinate>): string {
    return join(
      this.projectHomeDir,
      'session-summaries',
      encodeURIComponent(coordinate.ownerScope),
      encodeURIComponent(coordinate.agentSlug),
      `${encodeURIComponent(coordinate.conversationId)}.json`,
    );
  }

  private async readJson(
    path: string,
  ): Promise<{ state: 'missing' | 'invalid' | 'valid'; value?: unknown }> {
    try {
      if ((await stat(path)).size > MAX_SUMMARY_BYTES)
        return { state: 'invalid' };
      const bytes = await readFile(path);
      if (bytes.byteLength > MAX_SUMMARY_BYTES) return { state: 'invalid' };
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return { state: 'invalid' };
      return { state: 'valid', value: parsed };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { state: 'missing' };
      if (error instanceof SyntaxError) return { state: 'invalid' };
      throw error;
    }
  }

  async read(
    coordinate: SessionSummaryCoordinate,
  ): Promise<StoredSessionSummary | StoredSessionSummaryV1 | null> {
    const v2 = await this.readJson(this.v2Path(coordinate));
    if (v2.state === 'valid')
      return isStoredSessionSummary(v2.value) ? v2.value : null;
    // A present corrupt/future v2 sidecar is not an invitation to revive v1.
    if (v2.state === 'invalid' || !coordinate.agentSlug) return null;
    const v1 = await this.readJson(
      this.v1Path(coordinate as Required<SessionSummaryCoordinate>),
    );
    return v1.state === 'valid' && isStoredSessionSummaryV1(v1.value)
      ? v1.value
      : null;
  }

  /**
   * Publishes a whole regenerated summary.
   *
   * Serialized on `${v2}.mutation`, the same capability `dismiss` and `show`
   * take below. Regeneration itself is a whole-value publish that reads
   * nothing, so it needs no lock to be internally consistent -- but it races
   * the read-modify-write in `#mutateStored`, and without a shared capability
   * a dismissal that read before this publish would overwrite it a moment
   * after. `SessionSummaryCoordinator` does not close that: `invalidate()`
   * bumps an epoch and `begin()` fences only the generation path, so nothing
   * excluded a concurrent dismiss even in one process.
   */
  async write(
    coordinate: SessionSummaryCoordinate,
    summary: StoredSessionSummary,
  ): Promise<void> {
    const path = this.v2Path(coordinate);
    // Before the acquisition: `${path}.mutation` lives in this directory, so
    // acquiring first fails ENOENT on a coordinate's first write.
    await this.#ensureOwnerDirectory(coordinate);
    const release = await acquireFileMutationLockAsync(`${path}.mutation`);
    try {
      await this.#publishUnderLock(coordinate, summary);
    } finally {
      await release();
    }
  }

  async #ensureOwnerDirectory(
    coordinate: SessionSummaryCoordinate,
  ): Promise<void> {
    await mkdir(
      join(
        this.projectHomeDir,
        'conversation-intent-summaries',
        'v2',
        encodeURIComponent(coordinate.ownerScope),
      ),
      { recursive: true },
    );
  }

  /** The publish half of a transaction whose caller already holds the lock. */
  async #publishUnderLock(
    coordinate: SessionSummaryCoordinate,
    summary: StoredSessionSummary,
  ): Promise<void> {
    const path = this.v2Path(coordinate);
    const requestedBytes = Buffer.byteLength(JSON.stringify(summary), 'utf8');
    if (requestedBytes > MAX_SUMMARY_BYTES)
      throw new Error('Conversation intent summary exceeds the 32 KiB limit');
    const safe = redactDeep(summary);
    const serialized = JSON.stringify(safe, null, 2);
    // The persisted sidecar has a hard all-up ceiling: corrupted/generated
    // bloat must not turn a re-entry aid into an unbounded local data sink.
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SUMMARY_BYTES)
      throw new Error('Conversation intent summary exceeds the 32 KiB limit');
    // The shared publisher owns the uniquely-named temp, the data fsync, the
    // rename and the directory fsync, and emits the same two-space document
    // `serialized` was measured from above.
    await publishJsonFileWithOwnedLock(path, safe);
    // Regeneration is the migration boundary. Once v2 is durable, its v1
    // predecessor under the active agent coordinate cannot become visible.
    if (coordinate.agentSlug) {
      await unlink(
        this.v1Path(coordinate as Required<SessionSummaryCoordinate>),
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  /**
   * Runs one read/derive/publish for this coordinate under `${v2}.mutation`.
   *
   * `mutateJsonFile`/`mutateJsonFileWithGuardedRead` are the seams for this
   * shape, and neither fits: both publish whatever the updater returns, so
   * "there is nothing here to dismiss" would have to be expressed as a value,
   * and publishing the fallback would CREATE a sidecar that dismiss must
   * never create. So this composes the same capability with the same
   * publisher instead -- the documented purpose of
   * `publishJsonFileWithOwnedLock` -- exactly as `SshEnvironmentProfileStore`
   * and `NotificationService` do for their own conditional mutations. The
   * updater is synchronous so no caller-controlled await can widen the
   * verified read/write window while the capability is held.
   */
  async #mutateStored(
    coordinate: SessionSummaryCoordinate,
    update: (current: StoredSessionSummary) => StoredSessionSummary | null,
  ): Promise<void> {
    await this.#ensureOwnerDirectory(coordinate);
    const release = await acquireFileMutationLockAsync(
      `${this.v2Path(coordinate)}.mutation`,
    );
    try {
      // Read INSIDE the capability. Hoisting it above the acquisition is what
      // made these two paths lose each other's writes.
      const current = await this.read(coordinate);
      // A v1 record has no `version`, and dismissal is a v2-only preference.
      if (!current || !('version' in current)) return;
      const next = update(current);
      if (!next) return;
      await this.#publishUnderLock(coordinate, next);
    } finally {
      await release();
    }
  }

  /** Hide without deleting; Show can reverse this user preference. */
  async dismiss(coordinate: SessionSummaryCoordinate): Promise<void> {
    await this.#mutateStored(coordinate, (current) => ({
      ...current,
      dismissedAt: new Date().toISOString(),
    }));
  }

  async show(coordinate: SessionSummaryCoordinate): Promise<void> {
    await this.#mutateStored(coordinate, (current) => {
      if (!current.dismissedAt) return null;
      const { dismissedAt: _dismissedAt, ...summary } = current;
      return summary;
    });
  }

  /** Remove both generations; no old agent-keyed sidecar can resurrect. */
  async delete(coordinate: SessionSummaryCoordinate): Promise<void> {
    const paths = [
      this.v2Path(coordinate),
      ...(coordinate.agentSlug
        ? [this.v1Path(coordinate as Required<SessionSummaryCoordinate>)]
        : []),
    ];
    await Promise.all(
      paths.map((path) =>
        unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        }),
      ),
    );
  }
}

/** Per-conversation fence for generation, dismiss, and conversation deletion. */
export class SessionSummaryCoordinator {
  private readonly epochs = new Map<string, number>();
  private readonly active = new Set<string>();
  private key(coordinate: SessionSummaryCoordinate) {
    return `${coordinate.ownerScope}\u0000${coordinate.conversationId}`;
  }
  begin(
    coordinate: SessionSummaryCoordinate,
  ): { key: string; epoch: number } | null {
    const key = this.key(coordinate);
    if (this.active.has(key)) return null;
    this.active.add(key);
    return { key, epoch: this.epochs.get(key) ?? 0 };
  }
  current(token: { key: string; epoch: number }) {
    return (this.epochs.get(token.key) ?? 0) === token.epoch;
  }
  finish(token: { key: string }) {
    this.active.delete(token.key);
  }
  /** A timed-out provider call remains exclusive until it has actually stopped. */
  finishWhenSettled(token: { key: string }, settled: Promise<unknown>) {
    // `finally()` mirrors a rejected promise into a new rejected promise.
    // Dropping that derived promise was an unhandled-rejection path after a
    // timeout. Both settlement outcomes merely release this coordinator key.
    void settled.then(
      () => this.finish(token),
      () => this.finish(token),
    );
  }
  invalidate(coordinate: SessionSummaryCoordinate) {
    const key = this.key(coordinate);
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
  }
}
