import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PendingApprovalRequest } from '../../hooks/orchestration/pendingRequestRows';
import { useIsMobile } from '../../hooks/useIsMobile';
import { Button } from '../Button';
import {
  REVEAL_APPROVAL_EVENT,
  type RevealApprovalDetail,
} from '../status/approvalReveal';
import { ApprovalSheetContext } from './ApprovalSheetContext';
import { RequestSheet } from './RequestSheet';
import { type ToolApprovalOutcome, ToolCallDisplay } from './ToolCallDisplay';

const dismissed = new Set<string>();
const identity = (request: PendingApprovalRequest) =>
  `${request.approvalThreadId}:${request.approvalId}:${request.approvalEventId}`;

export function ApprovalSheetProvider({
  requests,
  onApprove,
  onCheck,
  children,
}: {
  requests: readonly PendingApprovalRequest[];
  onApprove(
    request: PendingApprovalRequest,
    action: 'once' | 'trust' | 'deny',
  ): Promise<ToolApprovalOutcome>;
  children: ReactNode;
  onCheck?: (
    request: PendingApprovalRequest,
  ) => Promise<'pending' | 'already-settled'>;
}) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [failedRequests, setFailedRequests] = useState<Set<string>>(
    () => new Set(),
  );
  const returnFocusTarget = useRef<HTMLElement | null>(null);
  const shouldAutoOpen =
    mobile && requests.some((request) => !dismissed.has(identity(request)));
  useEffect(() => {
    if (shouldAutoOpen) setOpen(true);
  }, [shouldAutoOpen]);
  const show = useCallback(
    (detail: RevealApprovalDetail) => {
      if (
        !mobile ||
        !requests.some(
          (request) =>
            request.approvalId === detail.requestId &&
            (detail.threadId === undefined ||
              request.approvalThreadId === detail.threadId),
        )
      )
        return false;
      returnFocusTarget.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setOpen(true);
      return true;
    },
    [mobile, requests],
  );
  useEffect(() => {
    const reveal = (event: Event) => {
      const detail = (event as CustomEvent<RevealApprovalDetail>).detail;
      if (detail?.requestId) show(detail);
    };
    window.addEventListener(REVEAL_APPROVAL_EVENT, reveal);
    return () => window.removeEventListener(REVEAL_APPROVAL_EVENT, reveal);
  }, [show]);
  const check = useCallback(
    (detail: RevealApprovalDetail) => {
      const request = requests.find(
        (candidate) =>
          candidate.approvalId === detail.requestId &&
          (detail.threadId === undefined ||
            candidate.approvalThreadId === detail.threadId),
      );
      if (!request || !onCheck)
        return Promise.reject(
          new Error('Open this conversation to check the request.'),
        );
      return onCheck(request).then((outcome) => {
        setFailedRequests((current) => {
          const next = new Set(current);
          next.delete(identity(request));
          return next;
        });
        return outcome;
      });
    },
    [requests, onCheck],
  );
  const context = useMemo(
    () => ({ insideSheet: false, show, check }),
    [show, check],
  );
  const sheetContext = useMemo(
    () => ({ insideSheet: true, show, check }),
    [show, check],
  );
  const dismiss = () => {
    for (const request of requests) dismissed.add(identity(request));
    for (const key of [...dismissed].slice(
      0,
      Math.max(0, dismissed.size - 256),
    ))
      dismissed.delete(key);
    setOpen(false);
  };
  return (
    <ApprovalSheetContext.Provider value={context}>
      {children}
      {mobile &&
        !open &&
        requests.some((request) => failedRequests.has(identity(request))) && (
          <div className="approval-sheet__notice" role="alert">
            <span>
              A decision needs attention. Open approvals to check its status.
            </span>
            <Button onClick={() => setOpen(true)}>Open approvals</Button>
          </div>
        )}
      {mobile && requests.length > 0 && (
        <ApprovalSheetContext.Provider value={sheetContext}>
          <RequestSheet
            open={open}
            title={
              requests.length === 1
                ? 'Needs approval'
                : `Needs approval (${requests.length})`
            }
            subtitle={undefined}
            returnFocusTarget={returnFocusTarget.current}
            onDismiss={dismiss}
            actions={null}
          >
            <div className="approval-sheet__requests">
              {requests.map((request) => (
                <ToolCallDisplay
                  key={identity(request)}
                  toolCall={request}
                  onApprove={async (action) => {
                    try {
                      const outcome = await onApprove(request, action);
                      setFailedRequests((current) => {
                        const next = new Set(current);
                        next.delete(identity(request));
                        return next;
                      });
                      return outcome;
                    } catch (error) {
                      setFailedRequests(
                        (current) => new Set([...current, identity(request)]),
                      );
                      throw error;
                    }
                  }}
                />
              ))}
            </div>
          </RequestSheet>
        </ApprovalSheetContext.Provider>
      )}
    </ApprovalSheetContext.Provider>
  );
}
