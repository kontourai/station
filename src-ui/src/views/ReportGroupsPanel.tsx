import type { ReportGroupView } from '@kontourai/station-contracts/report-group';
import {
  useCancelReportGroup,
  useFinalizeReportGroupCancel,
  useReportGroupResultQuery,
  useReportGroupsQuery,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useState } from 'react';
import { Button } from '../components/Button';
import {
  Empty,
  ErrorState,
  SkeletonBlock,
  SkeletonList,
} from '../components/state';
import { ReportGroupCreateForm } from './ReportGroupCreateForm';
import { ReportGroupSyncForm } from './ReportGroupSyncForm';
import './CliSessionGroupsPanel.css';
import './ReportGroupsPanel.css';

type Scope = ApiRequestScope & { isCurrent(): boolean };

function Report({
  scope,
  groupId,
  seatId,
  invocationId,
}: {
  scope: Scope;
  groupId: string;
  seatId: string;
  invocationId: string;
}) {
  const result = useReportGroupResultQuery(
    scope,
    { groupId, seatId, invocationId },
    true,
  );
  if (!scope.isCurrent())
    return <p role="alert">Station authority changed. Reopen this view.</p>;
  if (result.isError)
    return (
      <p role="alert">Report unavailable for the current Station authority.</p>
    );
  if (result.isPending)
    return <SkeletonBlock count={2} label="Reading report" />;
  if (result.data?.kind === 'failure')
    return <p>The attempt did not retain a report.</p>;
  return result.data ? (
    <>
      <p>
        Reported model: {result.data.modelId}. This output has not been assessed
        for acceptance.
      </p>
      <pre className="report-groups__result">{result.data.text}</pre>
    </>
  ) : null;
}

function Group({ scope, group }: { scope: Scope; group: ReportGroupView }) {
  const [opened, setOpened] = useState<string>();
  const cancel = useCancelReportGroup(scope);
  const finalize = useFinalizeReportGroupCancel(scope);
  const [cancelKey, setCancelKey] = useState<string>();
  return (
    <article aria-label={`Report group ${group.groupId}`}>
      <h3>{group.operationId}</h3>
      <p>
        {group.topology.kind === 'flow'
          ? `Flow ${group.topology.runId}`
          : 'Independent advisory'}{' '}
        · Revision {group.revision} · Execution {group.execution} · Cancellation{' '}
        {group.cancellation}
      </p>
      <Button
        variant="secondary"
        disabled={
          !scope.isCurrent() || !cancel.isIdle || group.cancellation !== 'none'
        }
        onClick={() =>
          cancel.mutate({
            groupId: group.groupId,
            expectedRevision: group.revision,
            operationKey: `cancel:${randomCorrelationId()}`,
          })
        }
      >
        Request cancellation
      </Button>
      {cancel.isPending && <p role="status">Requesting cancellation…</p>}
      {cancel.isSuccess && (
        <p role="status">
          Cancellation {cancel.data.cancellation}. Termination and accounting
          remain separately recorded.
        </p>
      )}
      {cancel.isError && (
        <p role="alert">
          Cancellation outcome unknown. Read the latest group state before
          making another request.
        </p>
      )}
      {group.cancellation === 'pending' && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!scope.isCurrent() || !finalize.isIdle || cancel.isPending)
              return;
            finalize.mutate({
              groupId: group.groupId,
              expectedRevision: group.revision,
              operationKey: `finalize:${randomCorrelationId()}`,
              cancelOperationKey:
                cancelKey ?? cancel.variables?.operationKey ?? '',
            });
          }}
        >
          <p>
            Check the retained cancellation receipts. This does not resend
            interrupts or confirm physical termination.
          </p>
          <label>
            Original cancellation operation key
            <input
              required
              maxLength={128}
              pattern="[A-Za-z0-9][A-Za-z0-9._:-]*"
              value={cancelKey ?? cancel.variables?.operationKey ?? ''}
              disabled={!finalize.isIdle || cancel.isPending}
              onChange={(event) => setCancelKey(event.target.value)}
            />
          </label>
          <Button
            type="submit"
            variant="secondary"
            disabled={
              !scope.isCurrent() || !finalize.isIdle || cancel.isPending
            }
          >
            Check cancellation receipts
          </Button>
          {finalize.isPending && (
            <SkeletonBlock
              count={1}
              label="Checking retained cancellation receipts"
            />
          )}
          {finalize.isSuccess && (
            <p role="status">
              Cancellation {finalize.data.cancellation}. Physical termination
              and accounting remain separately recorded.
            </p>
          )}
          {finalize.isError && (
            <p role="alert">
              Cancellation receipts could not be confirmed. No interrupts were
              resent.
            </p>
          )}
        </form>
      )}
      {group.authorityRevoked && (
        <p>
          Execution authority revoked. Existing charges and unresolved
          reservations remain.
        </p>
      )}
      {group.accounting && (
        <section aria-label="Group inference accounting">
          <p>
            All invocations, including context sync:{' '}
            {group.accounting.invocationCount}. Unsettled:{' '}
            {group.accounting.unsettledInvocations}.
          </p>
          <p>
            Known terminal usage:{' '}
            {group.accounting.knownTerminalUsage.inputTokens} input tokens,{' '}
            {group.accounting.knownTerminalUsage.outputTokens} output tokens,{' '}
            {group.accounting.knownTerminalUsage.costMicros} inference
            microdollars.
          </p>
          <p>
            Unsettled allocations:{' '}
            {group.accounting.unsettledAllocation.inputTokens} input tokens,{' '}
            {group.accounting.unsettledAllocation.outputTokens} output tokens,{' '}
            {group.accounting.unsettledAllocation.costMicros} inference
            microdollars. These are retained holds, not refunds or provider
            invoices.
          </p>
        </section>
      )}
      <ReportGroupSyncForm scope={scope} group={group} />
      <ul>
        {group.members.map((member) => (
          <li key={member.seatId}>
            <strong>{member.seatId}</strong> · Agent {member.agentId} ·
            Requested model {member.requestedModelId}
            {!member.attempts.length && <p>Invocation unrecorded.</p>}
            {member.attempts.map((attempt) => (
              <section
                key={attempt.invocationId}
                aria-label={`Attempt ${attempt.invocationId}`}
              >
                <p>
                  {attempt.accountingTerminal
                    ? attempt.usage
                      ? 'Accounting reconciled'
                      : 'Accounting terminal recorded; usage unknown'
                    : attempt.allocation
                      ? 'Accounting unresolved; reservation retained'
                      : 'Accounting unresolved'}{' '}
                  ·{' '}
                  {attempt.terminal
                    ? 'Terminal receipt retained'
                    : 'Termination unconfirmed'}
                </p>
                {!attempt.allocation && <p>Reservation unconfirmed.</p>}
                {attempt.allocation && (
                  <p>
                    Reserved: {attempt.allocation.inputTokens} input tokens,{' '}
                    {attempt.allocation.outputTokens} output tokens,{' '}
                    {attempt.allocation.costMicros} inference microdollars.
                  </p>
                )}
                {attempt.usage && (
                  <p>
                    Recorded: {attempt.usage.inputTokens} input tokens,{' '}
                    {attempt.usage.outputTokens} output tokens,{' '}
                    {attempt.usage.costMicros} inference microdollars.
                  </p>
                )}
                {attempt.observation && (
                  <Button
                    variant="secondary"
                    aria-expanded={opened === attempt.invocationId}
                    onClick={() =>
                      setOpened(
                        opened === attempt.invocationId
                          ? undefined
                          : attempt.invocationId,
                      )
                    }
                  >
                    {opened === attempt.invocationId
                      ? 'Close report'
                      : `Read report for ${member.seatId}`}
                  </Button>
                )}
                {opened === attempt.invocationId && (
                  <Report
                    scope={scope}
                    groupId={group.groupId}
                    seatId={member.seatId}
                    invocationId={attempt.invocationId}
                  />
                )}
              </section>
            ))}
          </li>
        ))}
      </ul>
    </article>
  );
}

export function ReportGroupsPanel({ scope }: { scope: Scope }) {
  const [expanded, setExpanded] = useState(false);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const groups = useReportGroupsQuery(scope, {
    enabled: expanded,
    afterGroupId: cursors.at(-1),
  });
  const current = scope.isCurrent();
  const page = current && !groups.isError ? groups.data : undefined;
  return (
    <section
      className="cli-session-groups report-groups"
      aria-label="Report groups"
    >
      <h2>Report groups</h2>
      <ReportGroupCreateForm scope={scope} />
      <p>Retained advisory reports and inference accounting.</p>
      <details>
        <summary>Access and outcomes</summary>
        <p>A locally granted operator on a personal Station is required.</p>
        <p>
          Execution completion establishes neither acceptance, physical stop nor
          refunds.
        </p>
      </details>
      <Button
        variant="secondary"
        aria-expanded={expanded}
        disabled={!current}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? 'Hide report groups' : 'Show report groups'}
      </Button>
      {expanded && (
        <>
          {!current && (
            <p role="alert">Station authority changed. Reopen this view.</p>
          )}
          {current && groups.isPending && (
            <SkeletonList count={3} label="Loading report groups" />
          )}
          {current && groups.isError && (
            <ErrorState
              variant="compact"
              title="Report groups are unavailable for the current Station authority."
              action={
                <Button
                  variant="secondary"
                  disabled={!current || groups.isFetching}
                  onClick={() => {
                    void groups.refetch();
                  }}
                >
                  Retry report groups
                </Button>
              }
            />
          )}
          {page && !page.groups.length && (
            <Empty variant="compact" label="Nothing on this page" />
          )}
          {page?.groups.map((group) => (
            <Group key={group.groupId} scope={scope} group={group} />
          ))}
          {page && (
            <div className="cli-session-groups__actions">
              <Button
                variant="secondary"
                disabled={cursors.length === 1 || groups.isFetching}
                onClick={() => setCursors(cursors.slice(0, -1))}
              >
                Previous report groups
              </Button>
              <Button
                variant="secondary"
                disabled={
                  !page.hasMore || !page.nextGroupId || groups.isFetching
                }
                onClick={() => {
                  if (page.nextGroupId)
                    setCursors([...cursors, page.nextGroupId]);
                }}
              >
                Next report groups
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
