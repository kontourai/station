import type {
  InboxCancelCommand,
  InboxCancelResult,
  InboxClaimNextCommand,
  InboxClaimNextResult,
  InboxReleaseCommand,
  InboxResolveUnconfirmedCommand,
  InboxSettleCommand,
  InboxSubmitCommand,
  InboxSubmitResult,
  InboxWriteResult,
} from '../commands.js';
import type { InboxEntryRecord, InboxEntryState } from '../records.js';

/**
 * One inbox has ordered follow-ups and turn-bound steers. The host places
 * one entry at a time.
 *
 * - A submission is idempotent by key: the same digest answers the stored
 *   entry, a different digest is a conflict. A refused or never-placed
 *   cancelled entry can be queued again unless the host retired the key
 *   while replacing the input. Dismissing an unknown effect cannot requeue it.
 * - Queued steers take precedence over queued follow-ups, with FIFO within
 *   each kind. Existing placements and unknown effects take precedence over
 *   both. A `placing` head is in flight and
 *   is never claimed afresh; the host re-drives it under the same key. An
 *   `unconfirmed` head may have had its effect: it blocks the inbox until the
 *   host cancels it, so nothing written after it overtakes an effect nobody
 *   can see.
 * - The placement is recorded in the same transaction as the move to
 *   `placing`, before the host's effect.
 */

export const RETIRED_INBOX_INPUT_OUTCOME =
  '{"reasonCode":"inbox_input_retired"}';

export function inboxInputIsRetired(entry: InboxEntryRecord): boolean {
  return (
    entry.state === 'cancelled' && entry.outcome === RETIRED_INBOX_INPUT_OUTCOME
  );
}

/** Entries that still hold a place in the queue. */
const UNSETTLED: ReadonlySet<InboxEntryState> = new Set([
  'queued',
  'placing',
  'unconfirmed',
]);

function inboxEntryIsUnsettled(entry: InboxEntryRecord): boolean {
  return UNSETTLED.has(entry.state);
}

function placementPriority(entry: InboxEntryRecord): number {
  if (entry.state === 'placing') return 0;
  if (entry.state === 'unconfirmed') return 1;
  return entry.kind === 'steer' ? 2 : 3;
}

export function inboxHead(
  entries: readonly InboxEntryRecord[],
): InboxEntryRecord | undefined {
  let head: InboxEntryRecord | undefined;
  for (const entry of entries) {
    if (!inboxEntryIsUnsettled(entry)) continue;
    const priority = placementPriority(entry);
    if (
      !head ||
      priority < placementPriority(head) ||
      (priority === placementPriority(head) && entry.sequence < head.sequence)
    )
      head = entry;
  }
  return head;
}

export interface InboxDecision<Result> {
  readonly put?: InboxEntryRecord;
  readonly result: Result;
}

export function decideInboxSubmit(
  inputs: {
    readonly existing: InboxEntryRecord | undefined;
    /** Every retained entry of the inbox, after retention ran. */
    readonly entries: readonly InboxEntryRecord[];
    readonly maxUnsettled: number;
    readonly maxDisplay: number;
  },
  command: InboxSubmitCommand,
): InboxDecision<InboxSubmitResult> {
  const { existing } = inputs;
  if (
    existing &&
    (inboxInputIsRetired(existing) ||
      existing.digest !== command.digest ||
      existing.kind !== command.kind)
  )
    return { result: { kind: 'conflict' } };
  const requeue =
    existing?.state === 'refused' ||
    (existing?.state === 'cancelled' && existing.placement === null);
  if (existing && !requeue)
    return { result: { kind: 'existing', entry: existing } };
  const displayCount = inputs.entries.filter(
    (entry) => entry.kind === 'display',
  ).length;
  if (command.kind === 'display' && displayCount >= inputs.maxDisplay)
    return { result: { kind: 'capacity', limit: inputs.maxDisplay } };
  const unsettled = inputs.entries.filter(inboxEntryIsUnsettled).length;
  if (command.kind !== 'display' && unsettled >= inputs.maxUnsettled)
    return { result: { kind: 'capacity', limit: inputs.maxUnsettled } };
  const sequence =
    inputs.entries.reduce((max, entry) => Math.max(max, entry.sequence), 0) + 1;
  const entry: InboxEntryRecord = {
    inboxId: command.inboxId,
    key: command.key,
    sequence,
    kind: command.kind,
    digest: command.digest,
    payload: command.payload,
    state: command.kind === 'display' ? 'placed' : 'queued',
    placement: null,
    outcome: null,
    createdAt: existing?.createdAt ?? command.now,
    updatedAt: command.now,
  };
  return {
    put: entry,
    result: { kind: 'accepted', entry, requeued: requeue },
  };
}

export function decideInboxClaimNext(
  entries: readonly InboxEntryRecord[],
  command: InboxClaimNextCommand,
): InboxDecision<InboxClaimNextResult> {
  const head = inboxHead(entries);
  if (!head) return { result: { kind: 'empty' } };
  if (head.state === 'placing')
    return { result: { kind: 'in-flight', entry: head } };
  if (head.state === 'unconfirmed')
    return { result: { kind: 'blocked', entry: head } };
  const entry: InboxEntryRecord = {
    ...head,
    state: 'placing',
    placement: head.placement ?? command.placement,
    updatedAt: command.now,
  };
  return { put: entry, result: { kind: 'claimed', entry } };
}

export function decideInboxSettle(
  existing: InboxEntryRecord | undefined,
  command: InboxSettleCommand,
): InboxDecision<InboxWriteResult> {
  if (existing?.state !== 'placing') return { result: { kind: 'stale' } };
  const entry: InboxEntryRecord = {
    ...existing,
    state: command.to,
    outcome: command.outcome,
    updatedAt: command.now,
  };
  return { put: entry, result: { kind: 'applied', entry } };
}

export function decideInboxRelease(
  existing: InboxEntryRecord | undefined,
  command: InboxReleaseCommand,
): InboxDecision<InboxWriteResult> {
  if (existing?.state !== 'placing') return { result: { kind: 'stale' } };
  const entry: InboxEntryRecord = {
    ...existing,
    state: 'queued',
    placement: command.keepPlacement ? existing.placement : null,
    updatedAt: command.now,
  };
  return { put: entry, result: { kind: 'applied', entry } };
}

export function decideInboxResolveUnconfirmed(
  existing: InboxEntryRecord | undefined,
  command: InboxResolveUnconfirmedCommand,
): InboxDecision<InboxWriteResult> {
  if (existing?.state !== 'unconfirmed') return { result: { kind: 'stale' } };
  const entry: InboxEntryRecord =
    command.to === 'placed'
      ? {
          ...existing,
          state: 'placed',
          outcome: command.outcome,
          updatedAt: command.now,
        }
      : {
          ...existing,
          state: 'queued',
          placement: null,
          outcome: command.outcome,
          updatedAt: command.now,
        };
  return { put: entry, result: { kind: 'applied', entry } };
}

export function decideInboxCancel(
  existing: InboxEntryRecord | undefined,
  command: InboxCancelCommand,
): InboxDecision<InboxCancelResult> {
  if (!existing) return { result: { kind: 'missing' } };
  switch (existing.state) {
    case 'placing':
      return { result: { kind: 'in-flight', entry: existing } };
    case 'placed':
      return { result: { kind: 'placed', entry: existing } };
    case 'cancelled':
      return { result: { kind: 'cancelled', entry: existing } };
    case 'queued':
    case 'unconfirmed':
    case 'refused': {
      const entry: InboxEntryRecord = {
        ...existing,
        state: 'cancelled',
        outcome:
          command.retireKey &&
          existing.state === 'queued' &&
          existing.placement === null
            ? RETIRED_INBOX_INPUT_OUTCOME
            : existing.outcome,
        updatedAt: command.now,
      };
      return { put: entry, result: { kind: 'cancelled', entry } };
    }
  }
}
