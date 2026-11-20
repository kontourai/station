import type { handoffExecutionMessage } from '@kontourai/station-sdk/client';
import { createStore, del, get, set } from 'idb-keyval';
import type { DraftQuote } from '../utils/answer-quotes';

export interface StagedHandoffAttempt {
  key: string;
  request: Parameters<typeof handoffExecutionMessage>[2];
  draft: string;
  quotes: readonly DraftQuote[];
  attachmentIds: string[];
}

let storage: ReturnType<typeof createStore> | undefined;

function store() {
  return (storage ??= createStore('station-staged-handoff', 'attempts'));
}

export const stagedHandoffAttempts = {
  read: (key: string) => get<StagedHandoffAttempt>(key, store()),
  write: (key: string, attempt: StagedHandoffAttempt) =>
    set(key, attempt, store()),
  remove: (key: string) => del(key, store()),
};
