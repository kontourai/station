import { collectRuntimeEventContentRefs } from '@kontourai/station-contracts/runtime-event-content';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { _getApiBase } from '../api';
import {
  fetchRuntimeEventContent,
  loadRuntimeEventContent,
} from '../client/runtime-event-content.js';
import { useApiQuery } from '../query-core';

export interface LoadedApprovalContent {
  /** The request with every reference resolved. */
  request: CanonicalRuntimeEvent;
  /** The bound tool call's arguments, resolved (when they held references). */
  args?: unknown;
  /** Proof of the load, sent with an allow decision. */
  viewedContentDigest: string;
}

/**
 * docs/design/event-content-spill.md: loads the whole of an approval whose
 * content was stored out of line (and the bound call's spilled arguments)
 * before a surface may offer Allow. Bodies are immutable per digest, so the
 * result never goes stale; it is refetched only when the request changes.
 */
export function useApprovalContentQuery(input: {
  threadId?: string;
  request?: CanonicalRuntimeEvent;
  args?: unknown;
}) {
  const threadId = input.threadId;
  const request = input.request;
  return useApiQuery<LoadedApprovalContent>(
    [
      'runtime-event-content',
      'approval',
      threadId ?? '',
      request?.eventId ?? '',
    ],
    async () => {
      if (!threadId || !request) throw new Error('No request to load');
      const apiBase = await _getApiBase();
      const loaded = await loadRuntimeEventContent(apiBase, threadId, request);
      const argRefs = collectRuntimeEventContentRefs(input.args);
      if (argRefs.length === 0)
        return {
          request: loaded.resolved,
          viewedContentDigest: loaded.viewedContentDigest,
        };
      const resolvedArgs = await loadRuntimeEventContent(
        apiBase,
        threadId,
        input.args,
      );
      return {
        request: loaded.resolved,
        args: resolvedArgs.resolved,
        viewedContentDigest: loaded.viewedContentDigest,
      };
    },
    {
      enabled: Boolean(threadId && request),
      staleTime: Number.POSITIVE_INFINITY,
    },
  );
}

/** One out-of-line body on demand (tool output, plan entries, a reply). */
export function useRuntimeEventContentQuery(input: {
  threadId?: string;
  ref?: string;
  enabled?: boolean;
}) {
  return useApiQuery(
    ['runtime-event-content', 'body', input.threadId ?? '', input.ref ?? ''],
    async () => {
      if (!input.threadId || !input.ref) throw new Error('No content to load');
      return fetchRuntimeEventContent(
        await _getApiBase(),
        input.threadId,
        input.ref,
      );
    },
    {
      enabled: Boolean(input.threadId && input.ref) && input.enabled !== false,
      staleTime: Number.POSITIVE_INFINITY,
    },
  );
}
