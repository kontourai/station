/** Session-owned publication policy around fixed, read-only worker facts. */
import {
  isSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import type { IsolatedTranscriptReads } from '../search/isolated-transcript-search.js';
import { boundedTaskText } from '../search/task-search-protocol.js';
import type { TranscriptSearchMatch } from '../search/transcript-search-protocol.js';
import type { SessionAuthorization } from './session-authorization.js';

export function createIsolatedSessionTranscriptSearch(
  source: IsolatedTranscriptReads,
  authorization: SessionAuthorization,
  runtimeCurrent: () => boolean,
) {
  let closed = false;
  let busy = false;
  let active: AbortController | undefined;
  return {
    inspect: source.inspect,
    close() {
      closed = true;
      active?.abort();
      return source.close();
    },
    async search(input: {
      query: string;
      authority: SessionReadAuthority;
      limit?: number;
      signal?: AbortSignal;
      /** Parent-owned principal/credential currentness, never sent to the worker. */
      current: () => boolean;
    }): Promise<
      | { state: 'available'; matches: TranscriptSearchMatch[] }
      | { state: 'unavailable' }
    > {
      if (closed || busy || input.signal?.aborted)
        return { state: 'unavailable' };
      const { authority, query, signal } = input;
      const requestCurrent = input.current;
      const limit = input.limit ?? 20;
      if (
        !isSessionReadAuthority(authority) ||
        (authority.mode === 'hosted' && !authority.tenantExecutionContext) ||
        !boundedTaskText(query, 256) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 20
      )
        return { state: 'unavailable' };
      busy = true;
      const controller = new AbortController();
      active = controller;
      const deadline = performance.now() + 2000;
      const sameGeneration = authorization.captureReadCurrentness();
      const current = () =>
        runtimeCurrent() === true &&
        requestCurrent() === true &&
        !closed &&
        !controller.signal.aborted &&
        performance.now() < deadline &&
        sameGeneration();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, 2000);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (signal?.aborted || !current()) return { state: 'unavailable' };
        const rows = await source.search(
          {
            query,
            limit,
            ownerUserId: authority.userId,
            ...(authority.mode === 'hosted'
              ? { tenantId: authority.tenantExecutionContext!.tenantId }
              : {}),
          },
          controller.signal,
        );
        if (!current()) return { state: 'unavailable' };
        const matches: TranscriptSearchMatch[] = [];
        for (const row of rows) {
          if (
            await authorization.canReadSessionAsync(
              row.conversationId,
              authority,
              current,
              controller.signal,
            )
          )
            matches.push(row);
          if (!current()) return { state: 'unavailable' };
        }
        return { state: 'available', matches };
      } catch {
        return { state: 'unavailable' };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        active = undefined;
        busy = false;
      }
    },
  };
}
