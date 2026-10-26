import { useApprovalContentQuery } from '@kontourai/station-sdk/runtime-event-content';
import {
  type ToolRequestServerGrant,
  type ToolRequestSessionGrant,
  toolRequestFromPayload,
  toolRequestServerGrantFromPayload,
  toolRequestSessionGrantFromPayload,
} from '@kontourai/station-shared/tool-request-preview';
import { type ReactNode, useEffect, useState } from 'react';
import { recordViewedContentDigest } from '../../hooks/orchestration/answerRequest';
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
  const request = active ? toolCall.approvalContentEvent : undefined;
  const [gate, setGate] = useState<{
    eventId: string;
    gate: ApprovalContentGate;
  }>();
  if (!request) return { gate: NOT_NEEDED, loader: null };
  return {
    gate: gate?.eventId === request.eventId ? gate.gate : LOADING,
    loader: (
      <ApprovalContentLoader
        key={request.eventId}
        toolCall={toolCall}
        onChange={(next) => setGate({ eventId: request.eventId, gate: next })}
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
  const request = toolCall.approvalContentEvent;
  const threadId = toolCall.approvalThreadId;
  const query = useApprovalContentQuery({
    threadId,
    request,
    args: toolCall.args,
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
    if (threadId && request?.eventId)
      recordViewedContentDigest(
        threadId,
        request.eventId,
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
        data.args ?? toolRequestFromPayload(payload).toolInput ?? toolCall.args,
      sessionGrant: toolRequestSessionGrantFromPayload(payload),
      serverGrant: toolRequestServerGrantFromPayload(payload),
      retry,
    });
  }, [data, isError, refetch, threadId, request?.eventId]);
  return null;
}
