import {
  type ActionOperation,
  useActionOperationsQuery,
  useCancelActionOperationMutation,
} from '@kontourai/station-sdk/action-operations';
import { useEffect, useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import { relativeTimeAgo } from '../../utils/relativeTime';
import { SkeletonList } from '../state';
import './ActionOperationsSection.css';

export interface ActionOperationGroups {
  readonly inProgress: readonly ActionOperation[];
  readonly needsAttention: readonly ActionOperation[];
  readonly recent: readonly ActionOperation[];
}

/** Activity grouping is a pure projection of canonical lifecycle state. */
export function groupActionOperations(
  operations: readonly ActionOperation[],
): ActionOperationGroups {
  return {
    inProgress: operations.filter(
      (operation) =>
        (operation.status === 'accepted' || operation.status === 'running') &&
        !(
          operation.progress.kind === 'phase' &&
          operation.progress.code === 'reconciliation-required'
        ),
    ),
    needsAttention: operations.filter(
      (operation) =>
        operation.status === 'failed' ||
        (operation.progress.kind === 'phase' &&
          operation.progress.code === 'reconciliation-required'),
    ),
    recent: operations.filter(
      (operation) =>
        operation.status === 'succeeded' || operation.status === 'cancelled',
    ),
  };
}

function progressLabel(operation: ActionOperation): string {
  if (operation.progress.kind === 'phase') {
    return {
      preparing: 'Preparing',
      'creating-continuation': 'Creating continuation',
      'cancellation-requested': 'Cancellation requested',
      'reconciliation-required': 'Status needs reconciliation',
    }[operation.progress.code];
  }
  if (operation.progress.kind === 'determinate') {
    return `${operation.progress.completed}/${operation.progress.total} ${operation.progress.unit}`;
  }
  return operation.status === 'accepted' ? 'Queued' : 'Working';
}
function reentryLabel(operation: ActionOperation): string {
  if (operation.reentry.kind === 'conversation') return 'Open conversation';
  if (operation.reentry.kind === 'session') return 'Open session';
  return 'View routing receipt';
}

function useBrowserOnline(): boolean {
  const [online, setOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine,
  );
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}
function statusLabel(operation: ActionOperation): string {
  return operation.status === 'cancelled'
    ? 'Cancelled'
    : operation.status[0]!.toUpperCase() + operation.status.slice(1);
}

function Group({
  title,
  items,
  onOpen,
  onCancel,
  cancelling,
}: {
  title: string;
  items: readonly ActionOperation[];
  onOpen: (operation: ActionOperation) => void;
  onCancel: (operation: ActionOperation) => void;
  cancelling: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section className="action-operations__group" aria-label={title}>
      <h3>{title}</h3>
      <ul className="action-operations__rows">
        {items.map((operation) => {
          const cancellable =
            operation.cancellation === 'supported' &&
            (operation.status === 'accepted' || operation.status === 'running');
          return (
            <li className="action-operations__row" key={operation.id}>
              <div className="action-operations__body">
                <strong>{operation.title}</strong>
                <span>
                  {statusLabel(operation)} · {progressLabel(operation)} ·{' '}
                  {relativeTimeAgo(Date.parse(operation.updatedAt), Date.now())}
                </span>
                {operation.errorSummary && (
                  <span role="alert">{operation.errorSummary}</span>
                )}
              </div>
              <div className="action-operations__actions">
                <button type="button" onClick={() => onOpen(operation)}>
                  {reentryLabel(operation)}
                </button>
                {cancellable && (
                  <button
                    type="button"
                    disabled={cancelling}
                    onClick={() => onCancel(operation)}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The Activity pane’s operation projection, not a second inbox. */
export function ActionOperationsSection() {
  const { data, isLoading, isFetching, error } = useActionOperationsQuery();
  const cancel = useCancelActionOperationMutation();
  const { navigate } = useNavigation();
  const online = useBrowserOnline();
  if (!online && !data) {
    return (
      <p className="action-operations__state" role="status">
        Offline — operation status is unavailable.
      </p>
    );
  }
  // Audit / : a bare "Connecting…" sentence read as debug output
  // in the Activity list pane — the canonical loading vocabulary is
  // SkeletonList/SkeletonBlock (src-ui/src/components/state), never a new
  // one-off string. Row-shaped, to mirror the operation rows this pane shows
  // once the read resolves. Scoped to the genuine initial load only
  // (`isLoading` — no data has ever been read, no error has been recorded)
  // see the below for why the error branch does NOT get
  // the same treatment.
  if (isLoading) {
    return <SkeletonList count={2} label="Connecting to operation status" />;
  }
  // archive#4474: this used to branch again on `isFetching` and
  // show a SECOND SkeletonList ("Reconnecting…") while an error persists
  // with no cached data. `useActionOperationsQuery` retries on a 5s
  // `refetchInterval`, so `isFetching` flips true/false indefinitely while
  // the error never clears — that made the pane alternate between a ~114px
  // skeleton and a ~13px line forever, displacing every row below it twice
  // a cycle (measured with a real Chromium page at 390px). An automatic
  // background retry is not news (the same "auto-retry doesn't banner"
  // stance ConnectionBannerSource already takes for transient reachability,
  // archive#3297) — so both arms of "error, no data" now render the SAME
  // static line regardless of `isFetching`, which is what makes the
  // in-flight state invisible to this pane's own layout instead of merely
  // quieter.
  if (error && !data) {
    return (
      <p className="action-operations__state" role="alert">
        Operation status unavailable.
      </p>
    );
  }
  if (!data || data.items.length === 0) return null;
  const groups = groupActionOperations(data.items);
  const open = (operation: ActionOperation) => {
    if (operation.reentry.kind === 'conversation') {
      navigate(
        `/agents/${encodeURIComponent(operation.reentry.agentId)}/conversations/${encodeURIComponent(operation.reentry.conversationId)}`,
      );
      return;
    }
    if (operation.reentry.kind === 'session') {
      navigate('/activity', { session: operation.reentry.sessionId });
      return;
    }
    navigate('/monitoring', {
      receipt: operation.reentry.routingReceiptId,
    });
  };
  const connectionStatus = !online
    ? 'Offline — showing last known status.'
    : error && isFetching
      ? 'Reconnecting…'
      : error
        ? 'Operation status unavailable.'
        : isFetching
          ? 'Refreshing…'
          : undefined;
  return (
    <section className="action-operations" aria-label="Platform actions">
      <div className="action-operations__header">
        <div>
          <h3>Platform actions</h3>
          <span>Progress from this Station</span>
        </div>
        {connectionStatus && (
          <span role={error && !isFetching ? 'alert' : 'status'}>
            {connectionStatus}
          </span>
        )}
      </div>
      {cancel.error && (
        <p className="action-operations__state" role="alert">
          {cancel.error.message}
        </p>
      )}
      <Group
        title="In progress"
        items={groups.inProgress}
        onOpen={open}
        onCancel={(operation) => cancel.mutate(operation.id)}
        cancelling={cancel.isPending}
      />
      <Group
        title="Needs attention"
        items={groups.needsAttention}
        onOpen={open}
        onCancel={(operation) => cancel.mutate(operation.id)}
        cancelling={cancel.isPending}
      />
      <Group
        title="Recent"
        items={groups.recent}
        onOpen={open}
        onCancel={(operation) => cancel.mutate(operation.id)}
        cancelling={cancel.isPending}
      />
    </section>
  );
}
