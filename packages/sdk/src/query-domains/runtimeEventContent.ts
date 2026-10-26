import { collectRuntimeEventContentRefs } from '@kontourai/station-contracts/runtime-event-content';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { _getApiBase } from '../api';
import {
  fetchRuntimeEventContent,
  loadApprovalContent,
  loadRuntimeEventContent,
} from '../client/runtime-event-content.js';
import { useApiQuery } from '../query-core';

export interface LoadedApprovalContent {
  /** The request with every reference resolved. */
  request: CanonicalRuntimeEvent;
  /** The latest bound tool call's arguments, resolved. */
  args?: unknown;
  /** Whether the server requires the digest for an allow. */
  required: boolean;
  /** Proof of the load, as the server's gate will check it. */
  viewedContentDigest: string;
}

/**
 * docs/design/event-content-spill.md: loads the whole of an approval (the
 * request and every tool call the server binds to it) before a surface may
 * offer Allow. The server defines the bound set and the digest; this loads
 * and echoes them. The key includes the references the surface currently
 * shows for the call, so a later bound `tool.started` refetches.
 */
export function useApprovalContentQuery(input: {
  threadId?: string;
  requestId?: string;
  requestEventId?: string;
  shownRefs?: readonly string[];
}) {
  const { threadId, requestId, requestEventId } = input;
  return useApiQuery<LoadedApprovalContent>(
    [
      'runtime-event-content',
      'approval',
      threadId ?? '',
      requestId ?? '',
      requestEventId ?? '',
      (input.shownRefs ?? []).join(','),
    ],
    async () => {
      if (!threadId || !requestId) throw new Error('No request to load');
      const loaded = await loadApprovalContent(
        await _getApiBase(),
        threadId,
        requestId,
      );
      const latest = loaded.bound[loaded.bound.length - 1];
      return {
        request: loaded.request,
        ...(latest && latest.method === 'tool.started'
          ? { args: latest.arguments }
          : {}),
        required: loaded.binding.required,
        viewedContentDigest: loaded.viewedContentDigest,
      };
    },
    {
      enabled: Boolean(threadId && requestId),
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

/**
 * Every reference inside `value` (tool arguments or output, a prompt, plan
 * entries), loaded and resolved on demand. Mount it only when the person asks
 * for the full content.
 */
export function useResolvedRuntimeEventValueQuery<T>(input: {
  threadId?: string;
  value: T;
}) {
  const refs = collectRuntimeEventContentRefs(input.value).map(
    (ref) => ref.ref,
  );
  return useApiQuery<T>(
    ['runtime-event-content', 'value', input.threadId ?? '', refs.join(',')],
    async () => {
      if (!input.threadId) throw new Error('No content to load');
      const loaded = await loadRuntimeEventContent(
        await _getApiBase(),
        input.threadId,
        input.value,
      );
      return loaded.resolved;
    },
    {
      enabled: Boolean(input.threadId) && refs.length > 0,
      staleTime: Number.POSITIVE_INFINITY,
    },
  );
}
