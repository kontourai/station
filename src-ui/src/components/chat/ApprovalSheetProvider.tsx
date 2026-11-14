import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PendingApprovalRequest } from '../../hooks/orchestration/pendingRequestRows';
import { pendingRequestKind } from '../../hooks/orchestration/pendingRequestRows';
import { useIsMobile } from '../../hooks/useIsMobile';
import { attentionWord } from '../../views/home/work-status';
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
  requests: openRequests,
  apiBase,
  onApprove,
  onCheck,
  onSettledElsewhere,
  children,
}: {
  requests: readonly PendingApprovalRequest[];
  apiBase?: string;
  onApprove(
    request: PendingApprovalRequest,
    action: 'once' | 'trust' | 'trust-server' | 'trust-rule' | 'deny',
  ): Promise<ToolApprovalOutcome>;
  children: ReactNode;
  onCheck?: (
    request: PendingApprovalRequest,
  ) => Promise<'pending' | 'already-settled'>;
  /**
   * Station said a request this sheet still lists is no longer open: this
   * view missed its resolution, and may be missing the request that replaced
   * it. The caller catches the transcript up.
   */
  onSettledElsewhere?: (request: PendingApprovalRequest) => void;
}) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  // A request Station reports settled stays off the sheet and out of its
  // count even before this view's transcript sees its resolution. Kept on
  // screen with live buttons, it read as the request to answer while the one
  // actually blocking the turn was missing from the sheet.
  const [settledRequests, setSettledRequests] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const requests = useMemo(
    () =>
      settledRequests.size === 0
        ? openRequests
        : openRequests.filter(
            (request) => !settledRequests.has(identity(request)),
          ),
    [openRequests, settledRequests],
  );
  const settledElsewhere = useCallback(
    (request: PendingApprovalRequest, catchUp: boolean) => {
      setSettledRequests((current) => {
        const next = new Set(current);
        next.add(identity(request));
        // Bounded: identities of requests long gone need not be kept.
        for (const key of [...next].slice(0, Math.max(0, next.size - 256)))
          next.delete(key);
        return next;
      });
      if (catchUp) onSettledElsewhere?.(request);
    },
    [onSettledElsewhere],
  );
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
        // `onCheck` itself catches the transcript up on this outcome.
        if (outcome === 'already-settled') settledElsewhere(request, false);
        return outcome;
      });
    },
    [requests, onCheck, settledElsewhere],
  );
  const context = useMemo(
    () => ({ apiBase, insideSheet: false, show, check }),
    [apiBase, show, check],
  );
  const sheetContext = useMemo(
    () => ({ apiBase, insideSheet: true, show, check }),
    [apiBase, show, check],
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
                ? requests[0] && pendingRequestKind(requests[0]) === 'input'
                  ? attentionWord('answer')
                  : attentionWord('approval')
                : `${requests.some((request) => pendingRequestKind(request) !== 'input') ? attentionWord('approval') : attentionWord('answer')} (${requests.length})`
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
                      if (outcome === 'already-settled')
                        settledElsewhere(request, true);
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
