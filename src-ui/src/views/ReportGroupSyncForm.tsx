import type { ReportGroupView } from '@kontourai/station-contracts/report-group';
import {
  useFinalizeReportGroupSync,
  useReportGroupContextCheckpoint,
  useSyncReportGroupContext,
} from '@kontourai/station-sdk';
import {
  type ApiRequestScope,
  parseReportGroupContextSyncInput,
} from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useState } from 'react';
import { Button } from '../components/Button';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';

type Scope = ApiRequestScope & { isCurrent(): boolean };

function Receipt({
  scope,
  group,
  sync,
}: {
  scope: Scope;
  group: ReportGroupView;
  sync: NonNullable<ReportGroupView['contextSyncs']>[number];
}) {
  const finalize = useFinalizeReportGroupSync(scope);
  return (
    <section aria-label={`Context operation ${sync.operationKey}`}>
      <p>
        Seat {sync.seatId} · Context operation {sync.operationKey} ·{' '}
        {sync.state}
      </p>
      {sync.state === 'acknowledged' && (
        <p>
          Exact context ACK retained. Understanding and acceptance remain
          unassessed.
        </p>
      )}
      {sync.state === 'incomplete' && (
        <p>
          Context sync incomplete. Existing reservations and recorded charges
          remain.
        </p>
      )}
      {!sync.attempts && (
        <p>
          No complete operation accounting snapshot retained. Inspect root
          accounting; this is not zero spend.
        </p>
      )}
      {sync.attempts?.map((attempt) => (
        <p key={attempt.invocationId}>
          {attempt.invocationId}:{' '}
          {attempt.accountingTerminal && attempt.usage
            ? 'Known terminal usage'
            : 'Usage unresolved; allocation retained'}
          {' · '}
          {attempt.terminal
            ? 'Terminal receipt retained'
            : 'Termination unconfirmed'}
        </p>
      ))}
      {sync.state === 'prepared' && sync.preparedDigest && (
        <Button
          variant="secondary"
          disabled={!scope.isCurrent() || !finalize.isIdle}
          onClick={() =>
            finalize.mutate({
              groupId: group.groupId,
              command: {
                operationKey: `sync-receipt:${randomCorrelationId()}`,
                expectedRevision: group.revision,
                syncOperationKey: sync.operationKey,
                preparedDigest: sync.preparedDigest!,
              },
            })
          }
        >
          Publish retained sync receipt
        </Button>
      )}
      {finalize.isPending && (
        <p role="status">Publishing the retained receipt…</p>
      )}
      {finalize.isSuccess && (
        <p role="status">Receipt state read. No context request was resent.</p>
      )}
      {finalize.isError && (
        <p role="alert">
          Receipt publication could not be confirmed. No context request was
          resent.
        </p>
      )}
    </section>
  );
}

/** An explicit paid request, never automatic continuation after an unknown outcome. */
export function ReportGroupSyncForm({
  scope,
  group,
}: {
  scope: Scope;
  group: ReportGroupView;
}) {
  const sync = useSyncReportGroupContext(scope);
  const checkpoint = useReportGroupContextCheckpoint(scope);
  const [seatId, setSeatId] = useState(group.members[0]?.seatId ?? '');
  const [opened, setOpened] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [operationKey] = useState(() => `context:${randomCorrelationId()}`);
  const { DiscardModal } = useUnsavedGuard(dirty && sync.isIdle);
  const current = scope.isCurrent();
  const allowance = group.contextSyncAllowance;
  const checked =
    checkpoint.data?.groupId === group.groupId &&
    checkpoint.data.seatId === seatId &&
    checkpoint.data.revision === group.revision
      ? checkpoint.data
      : undefined;
  const pending =
    group.contextSyncs?.some(
      (operation) =>
        operation.state === 'pending' || operation.state === 'prepared',
    ) ?? false;
  const admissionOpen =
    group.topology.kind === 'flow' &&
    allowance !== undefined &&
    allowance.recordedOperations < allowance.maximumOperations &&
    !pending &&
    !group.authorityRevoked &&
    group.cancellation === 'none';
  return (
    <section aria-label="Report context and receipts">
      {group.contextSyncs?.map((operation) => (
        <Receipt
          key={operation.operationKey}
          scope={scope}
          group={group}
          sync={operation}
        />
      ))}
      {allowance && (
        <p>
          Context operations recorded: {allowance.recordedOperations} of{' '}
          {allowance.maximumOperations}. A declared allowance does not establish
          current admission.
        </p>
      )}
      {pending && (
        <p>
          A context operation is pending. Read its retained state before
          requesting more work.
        </p>
      )}
      {(admissionOpen || opened) && (
        <>
          <Button
            variant="secondary"
            disabled={!current || opened || !admissionOpen}
            onClick={() => setOpened(true)}
          >
            Send updated report context
          </Button>
          {opened && (
            <form
              className="report-groups__form"
              onChange={() => setDirty(true)}
              onSubmit={(event) => {
                event.preventDefault();
                if (!current || !sync.isIdle || !admissionOpen || !checked)
                  return;
                const values = new FormData(event.currentTarget);
                let command: ReturnType<
                  typeof parseReportGroupContextSyncInput
                >;
                try {
                  command = parseReportGroupContextSyncInput({
                    operationKey,
                    expectedRevision: group.revision,
                    seatId,
                    flowHead: checked.flowHead,
                    text: String(values.get('text') ?? ''),
                  });
                } catch {
                  setInvalid(true);
                  return;
                }
                setInvalid(false);
                setDirty(false);
                sync.mutate({ groupId: group.groupId, command });
              }}
            >
              <p>
                Paid context work uses the existing report Session and remaining
                group limits.
              </p>
              <details>
                <summary>Admission and outcomes</summary>
                <p>
                  Stale source, authority or checkpoints and unavailable
                  continuation may refuse.
                </p>
                <p>An ACK does not establish understanding or acceptance.</p>
                <p>
                  Closing stops waiting; it does not confirm provider
                  termination or refunds.
                </p>
              </details>
              <p>
                Operation key: <code>{operationKey}</code> · Displayed revision{' '}
                {group.revision}
              </p>
              {!admissionOpen && sync.isIdle && (
                <p role="alert">
                  Group admission changed. Your unsent draft remains here;
                  inspect the latest group state before continuing.
                </p>
              )}
              <fieldset disabled={!current || !sync.isIdle || !admissionOpen}>
                <legend>Updated context</legend>
                <label className="field">
                  Report seat
                  <select
                    className="control"
                    name="seat"
                    required
                    value={seatId}
                    onChange={(event) => setSeatId(event.target.value)}
                  >
                    {group.members.map((member) => (
                      <option key={member.seatId} value={member.seatId}>
                        {member.seatId}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="secondary"
                  disabled={checkpoint.isPending}
                  onClick={() =>
                    checkpoint.mutate({
                      groupId: group.groupId,
                      command: { seatId, expectedRevision: group.revision },
                    })
                  }
                >
                  Read current Flow checkpoint
                </Button>
                {checkpoint.isPending && (
                  <p role="status">
                    Reading the current source and Flow checkpoint…
                  </p>
                )}
                {checkpoint.isError && (
                  <p role="alert">
                    The current checkpoint is unavailable. No paid context
                    request was sent.
                  </p>
                )}
                {checked && (
                  <p>
                    Current Flow checkpoint read for {seatId}. Final admission
                    is checked again when sending.
                  </p>
                )}
                <label className="field">
                  Private context text
                  <textarea
                    className="control control--textarea"
                    name="text"
                    required
                    maxLength={65_536}
                  />
                </label>
                <Button
                  type="submit"
                  disabled={!checked || checkpoint.isPending}
                >
                  Send paid context request
                </Button>
              </fieldset>
              {invalid && (
                <p role="alert">
                  Check the seat, checkpoint and 64 KiB text limit.
                </p>
              )}
              {current && sync.isPending && (
                <p role="status">Waiting for the context operation…</p>
              )}
              {current && sync.isSuccess && (
                <p role="status">
                  Retained context state received. Acceptance remains
                  unassessed.
                </p>
              )}
              {current && sync.isError && (
                <p role="alert">
                  Context outcome unknown. Keep the operation key and inspect
                  the latest group; this request is not retried.
                </p>
              )}
              {!current && (
                <p role="alert">Station authority changed. Reopen this view.</p>
              )}
            </form>
          )}
        </>
      )}
      <DiscardModal />
    </section>
  );
}
