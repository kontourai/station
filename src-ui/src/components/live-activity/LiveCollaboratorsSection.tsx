import {
  type LiveActivityParticipant,
  useLiveActivityQuery,
} from '@kontourai/station-sdk/live-activity';
import { useNavigation } from '../../contexts/NavigationContext';
import { useShowSurface } from '../../contexts/useShowSurface';
import { relativeTimeAgo } from '../../utils/relativeTime';

function actorKind(kind: LiveActivityParticipant['actor']['kind']): string {
  return kind === 'agent' ? 'Agent' : 'Human';
}
function workState(
  state: LiveActivityParticipant['work']['workState'],
): string {
  return state[0]!.toUpperCase() + state.slice(1);
}

/**
 * One sentence derived from the two counts the projection actually reports.
 * The panel used to stack four lines — a heading, a mono eyebrow, a mono count
 * pair and a status line — to say what is usually "nobody but you". Both
 * branches read the same two numbers, so the sentence is a derivation and not
 * a label: "just you" is exactly one connected client publishing nothing.
 */
export function liveCollaboratorSummary(
  connectedClients: number,
  publishing: number,
): string {
  if (connectedClients === 1 && publishing === 0)
    return 'Just you on this host';
  return `${connectedClients} client${connectedClients === 1 ? '' : 's'}, ${publishing} publishing live work`;
}

/** The Activity-only host projection; task rooms remain the presence authority. */
export function LiveCollaboratorsSection() {
  const { data } = useLiveActivityQuery();
  const { navigate } = useNavigation();
  const showSurface = useShowSurface();
  if (!data || (data.participants.length === 0 && data.connectedClients === 0))
    return null;
  const publishing = data.participants.length;
  const summary = liveCollaboratorSummary(data.connectedClients, publishing);
  return (
    <section
      className="live-collaborators"
      aria-labelledby="live-collaborators-title"
    >
      <div className="live-collaborators__header">
        <h3 id="live-collaborators-title">Live collaborators</h3>
        <p className="live-collaborators__summary">{summary}</p>
      </div>
      <details className="live-collaborators__details">
        <summary>What this counts</summary>
        <p className="live-collaborators__eyebrow">
          Published work across this host
        </p>
        <ul>
          <li>
            <strong>{data.connectedClients}</strong> connected client
            {data.connectedClients === 1 ? '' : 's'} — paired devices connected
            to this Station.
          </li>
          <li>
            <strong>{publishing}</strong> publishing live work — sessions that
            publish what they are doing to this host.
          </li>
        </ul>
      </details>
      {publishing > 0 && (
        <ul className="live-collaborators__rows">
          {data.participants.map((participant) => (
            <li className="live-collaborators__row" key={participant.id}>
              <div className="live-collaborators__identity">
                <span className="live-collaborators__kind">
                  {actorKind(participant.actor.kind)}
                </span>
                <strong>{participant.actor.label}</strong>
              </div>
              <div className="live-collaborators__work">
                <span>
                  {participant.scope.projectSlug} · Task{' '}
                  {participant.scope.taskId}
                </span>
                <strong>{participant.work.workName}</strong>
                <span>
                  {workState(participant.work.workState)} ·{' '}
                  {relativeTimeAgo(participant.work.startedAt, Date.now())}
                  {participant.watching
                    ? ` · ${participant.watching.state === 'following' ? 'Following' : 'Watching'} ${participant.watching.targetLabel}`
                    : ''}
                </span>
              </div>
              <div className="live-collaborators__actions">
                <button
                  type="button"
                  aria-label={`Jump in to ${participant.actor.label}'s ${participant.work.workName} on Task ${participant.scope.taskId}`}
                  onClick={() =>
                    navigate(
                      `/tasks/${encodeURIComponent(participant.scope.taskId)}`,
                    )
                  }
                >
                  Jump in
                </button>
                {participant.actor.kind === 'agent' &&
                  participant.work.sessionId && (
                    <button
                      type="button"
                      aria-label={`View ${participant.actor.label}'s session for ${participant.work.workName}`}
                      onClick={() =>
                        showSurface('activity', {
                          session: participant.work.sessionId,
                        })
                      }
                    >
                      View session
                    </button>
                  )}
                {participant.actor.kind === 'agent' &&
                  participant.work.runId && (
                    <button
                      type="button"
                      aria-label={`View ${participant.actor.label}'s run for ${participant.work.workName}`}
                      onClick={() =>
                        navigate(
                          `/projects/${encodeURIComponent(participant.scope.projectSlug)}/flow-console`,
                          { run: participant.work.runId ?? null },
                        )
                      }
                    >
                      View run
                    </button>
                  )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {/*
        The "Connected — activity not published." line is gone: the derived
        sentence above already states the same fact from the same counts, and
        two renderings of one number is how a surface starts disagreeing with
        itself. #1582 D5.
      */}
    </section>
  );
}
