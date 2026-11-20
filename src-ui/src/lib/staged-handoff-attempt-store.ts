import type { handoffExecutionMessage } from '@kontourai/station-sdk/client';
import { createStore, del, get, set, update } from 'idb-keyval';
import type { DraftQuote } from '../utils/answer-quotes';

export interface StagedHandoffAttempt {
  key: string;
  request: Parameters<typeof handoffExecutionMessage>[2];
  draft: string;
  quotes: readonly DraftQuote[];
  attachmentIds: string[];
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type RetainedAttempt = { attempt: StagedHandoffAttempt; expiresAt: number };

let storage: ReturnType<typeof createStore> | undefined;

function store() {
  return (storage ??= createStore('station-staged-handoff', 'attempts'));
}

export const stagedHandoffAttempts = {
  read: async (key: string) => {
    const record = await get<RetainedAttempt>(key, store());
    if (record && record.expiresAt > Date.now()) return record.attempt;
    if (record)
      await update<RetainedAttempt | undefined>(
        key,
        (current) =>
          current && current.expiresAt > Date.now() ? current : undefined,
        store(),
      );
    return undefined;
  },
  write: (key: string, attempt: StagedHandoffAttempt) =>
    set(key, { attempt, expiresAt: Date.now() + MAX_AGE_MS }, store()),
  remove: (key: string) => del(key, store()),
};
