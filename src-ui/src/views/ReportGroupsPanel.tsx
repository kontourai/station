import type { ReportGroupView } from '@kontourai/station-contracts/report-group';
import {
  useReportGroupResultQuery,
  useReportGroupsQuery,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { Button } from '../components/Button';
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
  if (result.isPending) return <p role="status">Reading report…</p>;
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
  return (
    <article aria-label={`Report group ${group.groupId}`}>
      <h3>{group.operationId}</h3>
      <p>
        Independent advisory · Revision {group.revision} · Execution{' '}
        {group.execution} · Cancellation {group.cancellation}
      </p>
      {group.authorityRevoked && (
        <p>
          Execution authority revoked. Existing charges and unresolved
          reservations remain.
        </p>
      )}
      <ul>
        {group.members.map((member) => (
          <li key={member.seatId}>
            <strong>{member.seatId}</strong> · Agent {member.agentId} ·
            Requested model {member.requestedModelId}
            {!member.attempts.length && <p>No invocation recorded.</p>}
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
                {!attempt.allocation && (
                  <p>No accounting reservation confirmed.</p>
                )}
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
      <p>
        Observe retained advisory reports and inference accounting. These groups
        require a locally granted operator on a personal Station. Execution
        completion does not establish acceptance, physical stop or refunds.
      </p>
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
            <p role="status">Loading report groups…</p>
          )}
          {current && groups.isError && (
            <p role="alert">
              Report groups are unavailable for the current Station authority.
            </p>
          )}
          {page && !page.groups.length && <p>No retained report groups.</p>}
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
