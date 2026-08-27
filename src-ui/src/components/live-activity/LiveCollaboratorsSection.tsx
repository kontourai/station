import {
  type LiveActivityParticipant,
  useLiveActivityQuery,
} from '@kontourai/station-sdk/live-activity';
import { useNavigation } from '../../contexts/NavigationContext';
import { relativeTimeAgo } from '../../utils/relativeTime';

function actorKind(kind: LiveActivityParticipant['actor']['kind']): string {
  return kind === 'agent' ? 'Agent' : 'Human';
}
function workState(
  state: LiveActivityParticipant['work']['workState'],
): string {
  return state[0]!.toUpperCase() + state.slice(1);
}

/** The Activity-only host projection; task rooms remain the presence authority. */
export function LiveCollaboratorsSection() {
  const { data } = useLiveActivityQuery();
  const { navigate } = useNavigation();
  if (!data || (data.participants.length === 0 && data.connectedClients === 0))
    return null;
  const publishing = data.participants.length;
  const summary = `${data.connectedClients} connected client${data.connectedClients === 1 ? '' : 's'} · ${publishing} publishing live work`;
  return (
    <section
      className="live-collaborators"
      aria-labelledby="live-collaborators-title"
    >
      <div className="live-collaborators__header">
        <div>
          <h3 id="live-collaborators-title">Live collaborators</h3>
          <span className="live-collaborators__eyebrow">
            Published work across this host
          </span>
        </div>
        <span className="live-collaborators__summary">{summary}</span>
      </div>
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
                        navigate('/activity', {
                          session: participant.work.sessionId ?? null,
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
      {publishing === 0 && (
        <p className="live-collaborators__connected-only" role="status">
          Connected — activity not published.
        </p>
      )}
    </section>
  );
}
