import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod/v3';
import { writePrivateJsonFileSync } from '../notifications/private-json-file.js';
import { parseFeedbackSummary } from './feedback-analysis.js';
import type { FeedbackStore, MessageRating } from './feedback-service.js';
import { feedbackRatingEvidenceDigest } from './feedback-target.js';

export const FEEDBACK_HISTORY_LIMITS = {
  records: 1024,
  bytes: 2 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
} as const;
export class FeedbackEvidenceStoreError extends Error {
  constructor(readonly code: 'feedback_capacity' | 'feedback_unavailable') {
    super(
      code === 'feedback_capacity'
        ? 'Feedback history is full. Delete feedback to continue.'
        : 'Feedback evidence is unavailable.',
    );
  }
}
const target = z
  .object({
    conversationId: z.string(),
    sessionId: z.string(),
    turnId: z.string(),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const rating = z
  .object({
    id: z.string().min(1),
    agentSlug: z.string(),
    conversationId: z.string(),
    messageIndex: z.number().int().nonnegative(),
    messagePreview: z.string(),
    rating: z.enum(['thumbs_up', 'thumbs_down']),
    reason: z.string().optional(),
    createdAt: z.string(),
    target: target.optional(),
    analysis: z.unknown().optional(),
    analyzedAt: z.unknown().optional(),
  })
  .strict();
const rawRating = rating.omit({ analysis: true, analyzedAt: true });
const envelope = z
  .object({
    ratings: z.array(rating),
    summary: z.unknown(),
    summaryBasis: z.string().optional(),
    ratingEvidence: z
      .array(
        z
          .object({
            revision: z.string().regex(/^[a-f0-9]{64}$/),
            record: rawRating,
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export function assertFeedbackHistoryCapacity(
  history: NonNullable<FeedbackStore['ratingEvidence']>,
) {
  if (
    history.length > FEEDBACK_HISTORY_LIMITS.records ||
    Buffer.byteLength(JSON.stringify(history)) > FEEDBACK_HISTORY_LIMITS.bytes
  )
    throw new FeedbackEvidenceStoreError('feedback_capacity');
}

/** Honest legacy0644 reads remain supported; all explicit writes are private, durable, and have no recovery copy. */
export class FeedbackEvidenceStore {
  constructor(private readonly file: string) {}
  read(): FeedbackStore {
    return this.capture().data;
  }
  capture(): { data: FeedbackStore; assertCurrent(): void } {
    const fingerprint = (value: Stats) =>
      JSON.stringify([
        value.dev,
        value.ino,
        value.size,
        value.mtimeMs,
        value.ctimeMs,
        value.mode,
        value.nlink,
        value.uid,
      ]);
    let descriptor: number | undefined;
    try {
      let path: Stats;
      try {
        path = lstatSync(this.file);
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return {
            data: { ratings: [], summary: null },
            assertCurrent: () => {
              try {
                lstatSync(this.file);
              } catch (current) {
                if (
                  current &&
                  typeof current === 'object' &&
                  'code' in current &&
                  current.code === 'ENOENT'
                )
                  return;
                throw new FeedbackEvidenceStoreError('feedback_unavailable');
              }
              throw new FeedbackEvidenceStoreError('feedback_unavailable');
            },
          };
        throw error;
      }
      if (
        !path.isFile() ||
        path.isSymbolicLink() ||
        path.nlink !== 1 ||
        path.size > FEEDBACK_HISTORY_LIMITS.fileBytes
      )
        throw new FeedbackEvidenceStoreError('feedback_unavailable');
      descriptor = openSync(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = fstatSync(descriptor);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.dev !== path.dev ||
        before.ino !== path.ino ||
        (process.platform !== 'win32' &&
          (before.uid !== process.getuid?.() ||
            (before.mode & 0o133) !== 0 ||
            (before.mode & 0o400) === 0))
      )
        throw new FeedbackEvidenceStoreError('feedback_unavailable');
      const buffer = Buffer.alloc(
        Math.min(before.size + 1, FEEDBACK_HISTORY_LIMITS.fileBytes + 1),
      );
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(
          descriptor,
          buffer,
          length,
          buffer.length - length,
          null,
        );
        if (!count) break;
        length += count;
      }
      const after = fstatSync(descriptor);
      const current = lstatSync(this.file);
      if (
        length > before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        current.dev !== before.dev ||
        current.ino !== before.ino
      )
        throw new FeedbackEvidenceStoreError('feedback_unavailable');
      const parsed = envelope.parse(
        JSON.parse(buffer.subarray(0, length).toString('utf8')),
      );
      assertFeedbackHistoryCapacity(parsed.ratingEvidence ?? []);
      const keys = new Set<string>();
      for (const entry of parsed.ratingEvidence ?? []) {
        if (
          entry.revision !== feedbackRatingEvidenceDigest(entry.record) ||
          keys.has(`${entry.record.id}:${entry.revision}`)
        )
          throw new FeedbackEvidenceStoreError('feedback_unavailable');
        keys.add(`${entry.record.id}:${entry.revision}`);
      }
      const ratings: MessageRating[] = parsed.ratings.map((record) => ({
        ...record,
        analysis:
          typeof record.analysis === 'string' ? record.analysis : undefined,
        analyzedAt:
          typeof record.analyzedAt === 'string' ? record.analyzedAt : undefined,
      }));
      const identity = fingerprint(before);
      const assertCurrent = () => {
        try {
          if (fingerprint(lstatSync(this.file)) === identity) return;
        } catch {}
        throw new FeedbackEvidenceStoreError('feedback_unavailable');
      };
      assertCurrent();
      return {
        data: {
          ratings,
          summary: parseFeedbackSummary(parsed.summary),
          summaryBasis: parsed.summaryBasis,
          ratingEvidence: parsed.ratingEvidence,
        },
        assertCurrent,
      };
    } catch {
      throw new FeedbackEvidenceStoreError('feedback_unavailable');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  write(data: FeedbackStore): void {
    assertFeedbackHistoryCapacity(data.ratingEvidence ?? []);
    if (
      Buffer.byteLength(JSON.stringify(data)) >
      FEEDBACK_HISTORY_LIMITS.fileBytes
    )
      throw new FeedbackEvidenceStoreError('feedback_capacity');
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(this.file));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        (parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0))
    )
      throw new FeedbackEvidenceStoreError('feedback_unavailable');
    writePrivateJsonFileSync(
      this.file,
      data,
      FEEDBACK_HISTORY_LIMITS.fileBytes,
      'feedback evidence',
    );
  }
}
