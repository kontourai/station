import type {
  CliSessionGroupPresetIdentity,
  CliSessionGroupView,
} from '@kontourai/station-contracts/delegation-group';
import { surfaceDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { useCliSessionGroupsQuery } from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useId, useState } from 'react';
import { ActionRow } from '../components/ActionRow';
import { Button } from '../components/Button';
import { Empty, ErrorState, SkeletonList } from '../components/state';
import { useNavigationActions } from '../contexts/NavigationContext';
import './CliSessionGroupsPanel.css';

function memberStatus(member: CliSessionGroupView['members'][number]): string {
  if (
    member.state === 'terminal' &&
    member.outcome === 'failed' &&
    !member.handle &&
    member.dispatchFailure
  )
    return 'Launch refused';
  if (member.state === 'terminal')
    return member.outcome === 'completed'
      ? 'Turn completed'
      : member.outcome === 'failed'
        ? 'Turn failed'
        : 'Turn canceled';
  if (member.state === 'launch-intent')
    return member.dispatchFailure
      ? 'Start outcome unresolved'
      : 'Start reserved; not yet confirmed';
  if (member.attention)
    return member.attention.kind === 'needs-input'
      ? 'Needs input · last observed'
      : member.attention.kind === 'review-pending'
        ? 'Review pending · last observed'
        : 'Blocked · last observed';
  if (member.state === 'started')
    return member.handle?.initialTurnId
      ? 'Turn accepted; completion unconfirmed'
      : 'Session returned; turn unconfirmed';
  return 'Not dispatched';
}

function MemberLabel({
  seatId,
  preset,
}: {
  seatId: string;
  preset?: CliSessionGroupPresetIdentity;
}) {
  const identity = preset?.members?.find((member) => member.seatId === seatId);
  if (!identity) return seatId;
  return (
    <>
      <span
        className="cli-session-groups__member-name"
        style={{ borderInlineStartColor: identity.color }}
      >
        {identity.codename}
      </span>
      <small className="cli-session-groups__member-details">
        {identity.role} · Seat {seatId} · Color {identity.color}
      </small>
    </>
  );
}

function GroupTopology({ group }: { group: CliSessionGroupView }) {
  const arrowId = useId();
  const columns = 3;
  const rows = Math.ceil(group.members.length / columns);
  return (
    <figure className="cli-session-groups__topology">
      <figcaption>
        Dependency graph · Revision {group.revision}
        <p>
          Arrows show declared prerequisites → dependent seats; positions do not
          imply execution order.
        </p>
        <p>
          States are last observed; work acceptance is unassessed. Exact
          identities are in the table.
        </p>
      </figcaption>
      <section
        className="cli-session-groups__graph-scroll"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users scroll the dependency graph.
        tabIndex={0}
        aria-label={`Dependency graph for ${group.groupId}`}
      >
        <svg
          className="cli-session-groups__graph"
          viewBox={`0 0 900 ${rows * 220}`}
          role="img"
          aria-label={`Declared dependencies at revision ${group.revision}`}
        >
          <defs>
            <marker
              id={arrowId}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {group.members.flatMap((member, index) =>
            member.needs.map((need) => {
              const source = group.members.findIndex(
                (seat) => seat.seatId === need,
              );
              const sourceColumn = source % columns;
              const sourceRow = Math.floor(source / columns);
              const targetColumn = index % columns;
              const targetRow = Math.floor(index / columns);
              return (
                <path
                  key={`${need}:${member.seatId}`}
                  d={`M ${sourceColumn * 300 + 280} ${sourceRow * 220 + 100}
                    H ${sourceColumn * 300 + 290}
                    V ${sourceRow * 220 + 200}
                    H ${targetColumn * 300 + 10}
                    V ${targetRow * 220 + 100}
                    H ${targetColumn * 300 + 20}`}
                  fill="none"
                  markerEnd={`url(#${arrowId})`}
                >
                  <title>
                    {need} → {member.seatId}
                  </title>
                </path>
              );
            }),
          )}
          {group.members.map((member, index) => (
            <foreignObject
              key={member.seatId}
              x={(index % columns) * 300 + 20}
              y={Math.floor(index / columns) * 220 + 20}
              width="260"
              height="160"
            >
              <div className="cli-session-groups__graph-node">
                <strong>{member.seatId}</strong>
                <p>{memberStatus(member)}</p>
                <small>Needs: {member.needs.join(', ') || 'None'}</small>
              </div>
            </foreignObject>
          ))}
        </svg>
      </section>
    </figure>
  );
}

export function CliSessionGroupsPanel({
  scope,
}: {
  scope: ApiRequestScope & { isCurrent(): boolean };
}) {
  const [expanded, setExpanded] = useState(false);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const groups = useCliSessionGroupsQuery(scope, {
    enabled: expanded,
    afterGroupId: cursors.at(-1),
  });
  const { navigate } = useNavigationActions();
  const current = scope.isCurrent();
  const page = current && !groups.isError ? groups.data : undefined;
  return (
    <section className="cli-session-groups" aria-label="Live session groups">
      <h2>Session groups</h2>
      <p>Inspect member Sessions and Flow dependencies.</p>
      <details>
        <summary>Current limits</summary>
        <p>Session permissions apply; portable lineage remains incomplete.</p>
        <p>Hard dollar, token and physical-attempt caps are unavailable.</p>
      </details>
      <Button
        variant="secondary"
        aria-expanded={expanded}
        disabled={!current}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? 'Hide session groups' : 'Show session groups'}
      </Button>
      {expanded && (
        <>
          {!current && (
            <p role="alert">Station authority changed. Reopen this view.</p>
          )}
          {current && groups.isPending && (
            <SkeletonList count={3} label="Loading session groups" />
          )}
          {current && groups.isError && (
            <ErrorState
              variant="compact"
              title="Session groups are unavailable for the current Station authority."
              action={
                <Button
                  variant="secondary"
                  disabled={!current || groups.isFetching}
                  onClick={() => {
                    void groups.refetch();
                  }}
                >
                  Retry session groups
                </Button>
              }
            />
          )}
          {page && !page.groups.length && (
            <Empty variant="compact" label="Nothing on this page" />
          )}
          {page?.groups.map((group) => (
            <article
              key={group.groupId}
              aria-label={`Session group ${group.groupId}`}
            >
              <h3>{group.preset?.name ?? group.groupId}</h3>
              {group.preset && (
                <p>
                  Preset {group.preset.presetId} · Stationmaster{' '}
                  {group.preset.stationmaster}
                  <br />
                  Source <code>{group.preset.sha256}</code>
                  <br />
                  Group <code>{group.groupId}</code>
                </p>
              )}
              <p>
                Flow: {group.flow?.status ?? 'not prepared'} · Supervision:{' '}
                {group.supervision === 'active' ? 'active' : 'not running here'}
                {group.cancelled ? ' · Cancellation requested' : ''}
              </p>
              <p>
                Work acceptance: not assessed. Deadline requests interruption;
                it does not prove the engine stopped.
              </p>
              <p>
                {group.dispatchCount} of{' '}
                {group.maxDispatches ?? group.members.length} starts reserved ·
                At most {group.maxConcurrent} occupied seats
              </p>
              {group.admissionClosed === 'dispatch-limit-exhausted' && (
                <p role="status">
                  Dispatch allowance exhausted. No additional starts can be
                  reserved; existing reservations remain accounted for.
                </p>
              )}
              {group.contextSync && (
                <div>
                  <p role="status">
                    Context sync: {group.contextSync.status} ·{' '}
                    {group.contextSync.runId}
                  </p>
                  <p>{group.contextSync.contentHash}</p>
                  <ul aria-label="Context sync receipts">
                    {group.contextSync.members.map((member) => (
                      <li key={member.seatId}>
                        {member.seatId}: {member.status} · {member.attempts}{' '}
                        attempts reserved
                      </li>
                    ))}
                  </ul>
                  <p>
                    Acknowledgement records received context; it does not accept
                    the work. Unknown attempts are never resent automatically.
                  </p>
                </div>
              )}
              <GroupTopology group={group} />
              <section
                className="cli-session-groups__table"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users scroll this wide member table.
                tabIndex={0}
                aria-label={`Scrollable member table for ${group.groupId}`}
              >
                <table
                  aria-label={`Members and dependencies for ${group.groupId}`}
                >
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Depends on</th>
                      <th>Observed state</th>
                      <th>Session</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.members.map((member) => (
                      <tr key={member.seatId}>
                        <th scope="row">
                          <MemberLabel
                            seatId={member.seatId}
                            preset={group.preset}
                          />
                        </th>
                        <td>
                          {member.needs.length
                            ? member.needs.join(', ')
                            : 'None'}
                        </td>
                        <td>
                          {memberStatus(member)}
                          {member.attention && (
                            <p>
                              Open the member session to inspect its current
                              request. This observation grants no response
                              permission.
                            </p>
                          )}
                          {member.dispatchFailure && (
                            <span className="cli-session-groups__refusal">
                              Dispatch refused: {member.dispatchFailure.code} (
                              {member.dispatchFailure.status})
                            </span>
                          )}
                        </td>
                        <td>
                          {member.handle ? (
                            <>
                              <Button
                                variant="secondary"
                                disabled={!current}
                                onClick={() => {
                                  if (scope.isCurrent())
                                    navigate(
                                      surfaceDeepLink({
                                        surfaceId: 'activity',
                                        sessionId: member.handle!.sessionId,
                                      }),
                                    );
                                }}
                              >
                                Open {member.seatId} session
                              </Button>
                              <details>
                                <summary>Recorded identities</summary>
                                <dl>
                                  <dt>Session</dt>
                                  <dd>{member.handle.sessionId}</dd>
                                  <dt>Initial turn</dt>
                                  <dd>
                                    {member.handle.initialTurnId ??
                                      'Unconfirmed'}
                                  </dd>
                                  <dt>Completion event</dt>
                                  <dd>
                                    {member.terminalEvent?.eventId ??
                                      'Unconfirmed'}
                                  </dd>
                                </dl>
                              </details>
                            </>
                          ) : (
                            'No accepted session handle'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </article>
          ))}
          <ActionRow
            className="cli-session-groups__actions"
            overflowLabel="More session group actions"
            secondary={
              <Button
                variant="secondary"
                disabled={!current || groups.isFetching || cursors.length === 1}
                onClick={() => setCursors((value) => value.slice(0, -1))}
              >
                Previous groups
              </Button>
            }
            primary={
              <Button
                variant="secondary"
                disabled={
                  !current ||
                  groups.isFetching ||
                  !page?.hasMore ||
                  !page.nextGroupId
                }
                onClick={() => {
                  if (page?.nextGroupId)
                    setCursors((value) => [...value, page.nextGroupId!]);
                }}
              >
                More groups
              </Button>
            }
            overflow={[
              {
                key: 'refresh',
                label: 'Refresh groups',
                disabled: !current || groups.isFetching,
                onSelect: () => {
                  void groups.refetch();
                },
              },
            ]}
          />
        </>
      )}
    </section>
  );
}
