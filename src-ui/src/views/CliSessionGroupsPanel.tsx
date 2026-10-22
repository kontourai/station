import type {
  CliSessionGroupPresetIdentity,
  CliSessionGroupView,
} from '@kontourai/station-contracts/delegation-group';
import { surfaceDeepLink } from '@kontourai/station-contracts/surface-deep-link';
import { useCliSessionGroupsQuery } from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { Button } from '../components/Button';
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
      <p>
        Inspect actual members and Flow dependencies. Station session
        permissions apply; portable lineage is incomplete and hard dollar, token
        and physical attempt caps are unavailable.
      </p>
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
            <p role="status">Loading session groups…</p>
          )}
          {current && groups.isError && (
            <p role="alert">
              Session groups are unavailable for the current Station authority.
            </p>
          )}
          {page && !page.groups.length && <p>No visible session groups.</p>}
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
          <div className="cli-session-groups__actions">
            <Button
              variant="secondary"
              disabled={!current || groups.isFetching || cursors.length === 1}
              onClick={() => setCursors((value) => value.slice(0, -1))}
            >
              Previous groups
            </Button>
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
            <Button
              variant="secondary"
              disabled={!current || groups.isFetching}
              onClick={() => {
                void groups.refetch();
              }}
            >
              Refresh groups
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
