import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  isSettledRequest,
  rememberSettledRequest,
  useHeldDuringCatchUp,
} from '../../hooks/orchestration/heldDuringCatchUp';
import type { PendingApprovalRequest } from '../../hooks/orchestration/pendingRequestRows';
import { pendingRequestKind } from '../../hooks/orchestration/pendingRequestRows';
import { useIsMobile } from '../../hooks/useIsMobile';
import { attentionWord } from '../../views/home/work-status';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import {
  REVEAL_APPROVAL_EVENT,
  type RevealApprovalDetail,
} from '../status/approvalReveal';
import { ApprovalSheetContext } from './ApprovalSheetContext';
import { RequestSheet } from './RequestSheet';
import { type ToolApprovalOutcome, ToolCallDisplay } from './ToolCallDisplay';

type SheetAction =
  | 'once'
  | 'trust'
  | 'trust-server'
  | 'trust-rule'
  | 'trust-all'
  | 'deny';

const MAX_REMEMBERED = 256;
const remember = (set: Set<string>, key: string) => {
  set.add(key);
  for (const old of [...set].slice(0, Math.max(0, set.size - MAX_REMEMBERED)))
    set.delete(old);
};

const dismissed = new Set<string>();
const identity = (request: PendingApprovalRequest) =>
  `${request.approvalThreadId}:${request.approvalId}:${request.approvalEventId}`;

export function ApprovalSheetProvider({
  requests: openRequests,
  apiBase,
  catchingUp: requestedHold = false,
  onApprove,
  onCheck,
  onSettledElsewhere,
  children,
}: {
  requests: readonly PendingApprovalRequest[];
  apiBase?: string;
  /**
   * The event stream is replaying what this view missed. Requests opened and
   * resolved inside the replay would otherwise flash through the sheet and
   * its count, so the sheet holds what it last showed until the replay ends.
   */
  catchingUp?: boolean;
  onApprove(
    request: PendingApprovalRequest,
    action: SheetAction,
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
  // Bumped whenever the module-wide settled set changes, so the filter reruns.
  const [settledVersion, setSettledVersion] = useState(0);
  const listed = useHeldDuringCatchUp(openRequests, requestedHold);
  const catchingUp = listed !== openRequests;
  // A request Station reports settled stays off the sheet and out of its
  // count even before this view's transcript sees its resolution. Kept on
  // screen with live buttons, it read as the request to answer while the one
  // actually blocking the turn was missing from the sheet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: settledVersion re-reads the module-wide set.
  const requests = useMemo(
    () => listed.filter((request) => !isSettledRequest(request.approvalId)),
    [listed, settledVersion],
  );
  const settledElsewhere = useCallback(
    (request: PendingApprovalRequest, catchUp: boolean) => {
      rememberSettledRequest(request.approvalId);
      setSettledVersion((version) => version + 1);
      if (catchUp) onSettledElsewhere?.(request);
    },
    [onSettledElsewhere],
  );
  const [failedRequests, setFailedRequests] = useState<Set<string>>(
    () => new Set(),
  );
  const returnFocusTarget = useRef<HTMLElement | null>(null);
  const shouldAutoOpen =
    mobile &&
    !catchingUp &&
    requests.some((request) => !dismissed.has(identity(request)));
  useEffect(() => {
    if (shouldAutoOpen) setOpen(true);
  }, [shouldAutoOpen]);

  // Ask Station once about each request the open sheet lists. A transcript
  // that missed a resolution (a reconnect whose replay or history window did
  // not reach it) would otherwise keep the request, its count and the
  // session's "needs approval" state forever. `onCheck` catches the
  // transcript up on a settled answer itself.
  // Each opening checks afresh: a request confirmed open last time may have
  // been settled since.
  const checked = useRef(new Set<string>());
  useEffect(() => {
    if (!open) checked.current.clear();
  }, [open]);
  useEffect(() => {
    if (!open || !mobile || catchingUp || !onCheck) return;
    for (const request of requests) {
      const key = identity(request);
      if (checked.current.has(key)) continue;
      checked.current.add(key);
      onCheck(request)
        .then((outcome) => {
          if (outcome === 'already-settled') settledElsewhere(request, false);
        })
        // Unknown stays listed: a failed check never hides a request. It is
        // not retried until the next opening (the key is cleared on close),
        // so a failing Station is not asked again on every render.
        .catch(() => undefined);
    }
  }, [open, mobile, catchingUp, requests, onCheck, settledElsewhere]);

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
    for (const request of requests) remember(dismissed, identity(request));
    setOpen(false);
  };
  const answer = async (
    request: PendingApprovalRequest,
    action: SheetAction,
  ) => {
    try {
      const outcome = await onApprove(request, action);
      setFailedRequests((current) => {
        const next = new Set(current);
        next.delete(identity(request));
        return next;
      });
      if (outcome === 'already-settled') settledElsewhere(request, true);
      return outcome;
    } catch (error) {
      setFailedRequests((current) => new Set([...current, identity(request)]));
      throw error;
    }
  };
  // Bulk answers cover tool approvals only: a question needs its own answer.
  const approvals = requests.filter(
    (request) => pendingRequestKind(request) !== 'input',
  );
  const [bulk, setBulk] = useState<'once' | 'trust' | null>(null);
  const allowAll = async (action: 'once' | 'trust') => {
    if (bulk) return;
    setBulk(action);
    try {
      // One at a time: each answer is its own authority check, and a refusal
      // of one (already answered, or content not yet loaded) must not stop
      // the rest. Failures stay listed with their own error and retry.
      for (const request of approvals) {
        await answer(request, action).catch(() => undefined);
      }
    } finally {
      setBulk(null);
    }
  };
  const bulkActions =
    approvals.length > 1 ? (
      <ActionRow
        className="approval-decision-row"
        overflowLabel="More ways to allow every request"
        primary={
          <Button
            variant="primary"
            disabled={bulk !== null}
            pending={bulk === 'once'}
            pendingLabel="Allowing…"
            onClick={() => void allowAll('once')}
          >
            {`Allow all (${approvals.length})`}
          </Button>
        }
        overflow={[
          {
            key: 'allow-all-session',
            label: 'Allow all for this session',
            disabled: bulk !== null,
            onSelect: () => void allowAll('trust'),
          },
        ]}
      />
    ) : null;
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
            actions={bulkActions}
          >
            <div className="approval-sheet__requests">
              {requests.map((request) => (
                <ToolCallDisplay
                  key={identity(request)}
                  toolCall={request}
                  onApprove={(action) => answer(request, action)}
                />
              ))}
            </div>
          </RequestSheet>
        </ApprovalSheetContext.Provider>
      )}
    </ApprovalSheetContext.Provider>
  );
}
