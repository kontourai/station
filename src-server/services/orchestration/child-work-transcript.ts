import {
  CHILD_WORK_TRANSCRIPT_PAGE_MAX,
  type ChildWorkDelta,
  type ChildWorkItem,
  type ChildWorkTranscriptPage,
  type ChildWorkTranscriptRef,
  parseChildWorkTranscriptRef,
} from '@kontourai/station-contracts/child-work';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { readClaudeSubagentTranscriptPage } from '../../providers/adapters/claude-subagent-transcript.js';

/**
 * #3163: a child's own transcript, read-only and paged.
 *
 * The client names a session and a child id, never a file. The transcript's
 * identity comes from the child-work facts this Station persisted for that
 * session (the `transcript` ref its engine's adapter recorded), so it is the
 * same after a server restart as before it, and a running or settled child
 * reads the same way.
 *
 * Sources: Claude subagents (`claude-subagent`). Codex child threads have no
 * source that outlives the Codex process Station spawned, so they carry no
 * ref and offer no transcript.
 */

export type ChildWorkTranscriptOutcome =
  | { status: 'found'; page: ChildWorkTranscriptPage }
  /** No such readable session, child, or transcript for that child. */
  | { status: 'not-found' }
  /** The child names a transcript the engine can no longer produce. */
  | { status: 'unavailable' };

export interface ChildWorkTranscriptModuleDeps {
  /** The session's persisted child-work facts, oldest first. */
  listChildWorkHistory: (threadId: string) => readonly CanonicalRuntimeEvent[];
  canReadSession: (
    threadId: string,
    authority: SessionReadAuthority,
  ) => boolean;
}

export interface ChildWorkTranscriptModule {
  read(input: {
    threadId: string;
    childId: string;
    offset: number;
    limit: number;
    authority: SessionReadAuthority;
  }): Promise<ChildWorkTranscriptOutcome>;
}

function itemsOf(
  delta: Exclude<ChildWorkDelta, { kind: 'not-reported' }>,
): Partial<ChildWorkItem>[] {
  switch (delta.kind) {
    case 'snapshot':
      return delta.running;
    case 'upsert':
      return [delta.item];
    case 'settle':
      return [{ ...delta.identity, childId: delta.childId }];
  }
}

/**
 * The latest transcript ref the session's own reports gave `childId`. Reads
 * every persisted delta (not the bounded registry), so neither a session
 * exit nor settled-child eviction hides a child's transcript.
 */
function childTranscriptRefFromHistory(
  threadId: string,
  childId: string,
  events: readonly CanonicalRuntimeEvent[],
): ChildWorkTranscriptRef | undefined {
  let ref: ChildWorkTranscriptRef | undefined;
  for (const event of events) {
    if (event.method !== 'child-work.updated') continue;
    const delta = event.delta;
    if (delta.kind === 'not-reported') continue;
    const key = delta.kind === 'upsert' ? delta.item : delta;
    // Only the session's own reports about its own engine subagents.
    if (
      event.threadId !== threadId ||
      key.reporterThreadId !== threadId ||
      key.producer !== 'engine-subagent'
    ) {
      continue;
    }
    for (const item of itemsOf(delta)) {
      if (item.childId !== childId) continue;
      ref = parseChildWorkTranscriptRef(item.transcript) ?? ref;
    }
  }
  return ref;
}

export function createChildWorkTranscriptModule(
  deps: ChildWorkTranscriptModuleDeps,
): ChildWorkTranscriptModule {
  return {
    async read({ threadId, childId, offset, limit, authority }) {
      if (!deps.canReadSession(threadId, authority))
        return { status: 'not-found' };
      const ref = childTranscriptRefFromHistory(
        threadId,
        childId,
        deps.listChildWorkHistory(threadId),
      );
      if (!ref) return { status: 'not-found' };
      const pageLimit = Math.min(
        Math.max(1, Math.floor(limit)),
        CHILD_WORK_TRANSCRIPT_PAGE_MAX,
      );
      try {
        return await readClaudeSubagentTranscriptPage(ref, {
          offset: Math.max(0, Math.floor(offset)),
          limit: pageLimit,
        });
      } catch {
        return { status: 'unavailable' };
      }
    },
  };
}
