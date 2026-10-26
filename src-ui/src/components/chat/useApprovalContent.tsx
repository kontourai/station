import { collectRuntimeEventContentRefs } from '@kontourai/station-contracts/runtime-event-content';
import { useApprovalContentQuery } from '@kontourai/station-sdk/runtime-event-content';
import {
  type ToolRequestServerGrant,
  type ToolRequestSessionGrant,
  toolRequestFromPayload,
  toolRequestServerGrantFromPayload,
  toolRequestSessionGrantFromPayload,
} from '@kontourai/station-shared/tool-request-preview';
import {
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  contentRefreshVersion,
  recordViewedContentDigest,
  subscribeContentRefresh,
} from '../../hooks/orchestration/answerRequest';
import { commandOnlyArgs } from '../../hooks/orchestration/pendingRequestRows';
import type { ToolCallData } from './ToolCallDisplay';

/**
 * docs/design/event-content-spill.md: an approval whose content was stored
 * out of line is loaded whole before any surface offers Allow. Until it has
 * loaded, `allowable` is false and the card offers only Deny; once it has,
 * the card shows the resolved arguments and derives its grants from the
 * resolved request, and the answer path sends the proof of the load.
 */
export interface ApprovalContentGate {
  status: 'not-needed' | 'loading' | 'ready' | 'error';
  allowable: boolean;
  /** Resolved arguments to show in place of the stored ones. */
  args?: unknown;
  sessionGrant?: ToolRequestSessionGrant;
  serverGrant?: ToolRequestServerGrant;
  retry: () => void;
}

const NOT_NEEDED: ApprovalContentGate = {
  status: 'not-needed',
  allowable: true,
  retry: () => {},
};
const LOADING: ApprovalContentGate = {
  status: 'loading',
  allowable: false,
  retry: () => {},
};

/**
 * The gate, and the loader element the caller renders. The query runs in
 * that element, so a row with nothing stored out of line (nearly every row)
 * mounts no query at all.
 */
export function useApprovalContent(
  toolCall: ToolCallData,
  active: boolean,
): { gate: ApprovalContentGate; loader: ReactNode } {
  const threadId = toolCall.approvalThreadId;
  const requestId = toolCall.approvalId;
  const requestEventId = toolCall.approvalEventId;
  // A request needs loading when its stored form (or the call it binds)
  // shows a reference, or when the server refused an allow for content
  // this surface did not know about (a 409 marks it).
  const marked = useSyncExternalStore(subscribeContentRefresh, () =>
    threadId && requestEventId
      ? contentRefreshVersion(threadId, requestEventId)
      : 0,
  );
  const needed =
    active &&
    Boolean(threadId && requestId) &&
    (Boolean(toolCall.approvalContentEvent) || marked > 0);
  const [gate, setGate] = useState<{
    key: string;
    gate: ApprovalContentGate;
  }>();
  if (!needed) return { gate: NOT_NEEDED, loader: null };
  const key = `${requestEventId ?? requestId}:${marked}`;
  return {
    gate: gate?.key === key ? gate.gate : LOADING,
    loader: (
      <ApprovalContentLoader
        key={key}
        toolCall={toolCall}
        onChange={(next) => setGate({ key, gate: next })}
      />
    ),
  };
}

function ApprovalContentLoader({
  toolCall,
  onChange,
}: {
  toolCall: ToolCallData;
  onChange: (gate: ApprovalContentGate) => void;
}) {
  const threadId = toolCall.approvalThreadId;
  const requestEventId = toolCall.approvalEventId;
  // The server defines what is loaded and proved; the references this row
  // shows key the query, so a later bound `tool.started` refetches.
  const shownRefs = collectRuntimeEventContentRefs(toolCall.args).map(
    (ref) => ref.ref,
  );
  const query = useApprovalContentQuery({
    threadId,
    requestId: toolCall.approvalId,
    requestEventId,
    shownRefs,
  });
  const { data, isError, refetch } = query;
  // biome-ignore lint/correctness/useExhaustiveDependencies: onChange is a fresh closure per render; the query state and request identity are what matter.
  useEffect(() => {
    const retry = () => void refetch();
    if (!data) {
      onChange({
        status: isError ? 'error' : 'loading',
        allowable: false,
        retry,
      });
      return;
    }
    if (threadId && requestEventId && data.required)
      recordViewedContentDigest(
        threadId,
        requestEventId,
        data.viewedContentDigest,
      );
    const payload =
      data.request.method === 'request.opened'
        ? data.request.payload
        : undefined;
    onChange({
      status: 'ready',
      allowable: true,
      args:
        data.args ??
        toolRequestFromPayload(payload).toolInput ??
        commandOnlyArgs(payload) ??
        toolCall.args,
      sessionGrant: toolRequestSessionGrantFromPayload(payload),
      serverGrant: toolRequestServerGrantFromPayload(payload),
      retry,
    });
  }, [data, isError, refetch, threadId, requestEventId]);
  return null;
}
