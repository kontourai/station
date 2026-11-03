import { collectRuntimeEventContentRefs } from '@kontourai/station-contracts/runtime-event-content';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { _getApiBase } from '../api';
import type { ClientRequestOptions } from '../client/http';
import {
  fetchRuntimeEventContent,
  loadApprovalContent,
  loadRuntimeEventContent,
} from '../client/runtime-event-content.js';
import { useApiQuery } from '../query-core';

type ContentTarget = {
  apiBase?: string;
  requestScope?: ClientRequestOptions['requestScope'];
};
const targetKey = (input: ContentTarget): string[] =>
  input.apiBase ? [input.apiBase, input.requestScope?.authorityKey ?? ''] : [];

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
 * The approval content query's key: the request, and the references the
 * surface shows for its call, so a later bound `tool.started` (new
 * references) fetches the binding again instead of keeping a stale digest.
 */
export function approvalContentQueryKey(
  input: {
    threadId?: string;
    requestId?: string;
    requestEventId?: string;
    shownRefs?: readonly string[];
  } & ContentTarget,
): string[] {
  return [
    'runtime-event-content',
    'approval',
    ...targetKey(input),
    input.threadId ?? '',
    input.requestId ?? '',
    input.requestEventId ?? '',
    [...(input.shownRefs ?? [])].sort().join(','),
  ];
}

/**
 * docs/design/event-content-spill.md: loads the whole of an approval (the
 * request and every tool call the server binds to it) before a surface may
 * offer Allow. The server defines the bound set and the digest; this loads
 * and echoes them. The key includes the references the surface currently
 * shows for the call, so a later bound `tool.started` refetches.
 */
export function useApprovalContentQuery(
  input: {
    threadId?: string;
    requestId?: string;
    requestEventId?: string;
    shownRefs?: readonly string[];
  } & ContentTarget,
) {
  const { threadId, requestId } = input;
  return useApiQuery<LoadedApprovalContent>(
    approvalContentQueryKey(input),
    async () => {
      if (!threadId || !requestId) throw new Error('No request to load');
      const loaded = await loadApprovalContent(
        input.apiBase ?? (await _getApiBase()),
        threadId,
        requestId,
        input.requestScope ? { requestScope: input.requestScope } : undefined,
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
export function useRuntimeEventContentQuery(
  input: {
    threadId?: string;
    ref?: string;
    enabled?: boolean;
  } & ContentTarget,
) {
  return useApiQuery(
    [
      'runtime-event-content',
      'body',
      ...targetKey(input),
      input.threadId ?? '',
      input.ref ?? '',
    ],
    async () => {
      if (!input.threadId || !input.ref) throw new Error('No content to load');
      return fetchRuntimeEventContent(
        input.apiBase ?? (await _getApiBase()),
        input.threadId,
        input.ref,
        input.requestScope ? { requestScope: input.requestScope } : undefined,
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
export function useResolvedRuntimeEventValueQuery<T>(
  input: {
    threadId?: string;
    value: T;
  } & ContentTarget,
) {
  const refs = collectRuntimeEventContentRefs(input.value).map(
    (ref) => ref.ref,
  );
  return useApiQuery<T>(
    [
      'runtime-event-content',
      'value',
      ...targetKey(input),
      input.threadId ?? '',
      refs.join(','),
    ],
    async () => {
      if (!input.threadId) throw new Error('No content to load');
      const loaded = await loadRuntimeEventContent(
        input.apiBase ?? (await _getApiBase()),
        input.threadId,
        input.value,
        input.requestScope ? { requestScope: input.requestScope } : undefined,
      );
      return loaded.resolved;
    },
    {
      enabled: Boolean(input.threadId) && refs.length > 0,
      staleTime: Number.POSITIVE_INFINITY,
    },
  );
}
