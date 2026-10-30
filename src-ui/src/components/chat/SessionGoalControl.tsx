import type { SessionGoalCommand } from '@kontourai/station-contracts/session-goal';
import {
  useSessionGoalMutation,
  useSessionGoalQuery,
} from '@kontourai/station-sdk/session-goals';
import { StatusBadge } from '@kontourai/ui/react';
import { useId, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { Button } from '../Button';
import { ErrorState, SkeletonBlock } from '../state';

export function SessionGoalControl({ sessionId }: { sessionId: string }) {
  const flags = useSurfaceVisibilityFlags();
  const scope = useHostRequestAuthorityScope();
  if (!scope || !flags.has('session-goals') || !sessionId) return null;
  return (
    <GoalSurface
      key={`${scope.apiBase}:${scope.authorityKey}:${sessionId}`}
      sessionId={sessionId}
      scope={scope}
    />
  );
}

function GoalSurface({
  sessionId,
  scope,
}: {
  sessionId: string;
  scope: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const query = useSessionGoalQuery(sessionId, scope);
  const mutation = useSessionGoalMutation(sessionId, scope);
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState('');
  const [budget, setBudget] = useState('');
  const objectiveId = useId();
  const budgetId = useId();
  const submit = async (command: SessionGoalCommand) => {
    setMessage('');
    try {
      const result = await mutation.mutateAsync(command);
      if (result.state === 'applied') {
        setEditing(false);
        setMessage('Goal updated.');
      } else if (result.state === 'indeterminate') {
        setMessage(
          'The outcome is unconfirmed. Refresh and inspect before trying again.',
        );
      } else
        setMessage(
          result.state === 'unsupported'
            ? 'This operation is unsupported.'
            : 'The engine could not apply this operation.',
        );
    } catch {
      setMessage(
        'The outcome could not be confirmed. Refresh and inspect before trying again.',
      );
    }
  };
  const data = query.data;
  return (
    <section className="chat-settings-modal__section" aria-label="Session goal">
      <h4>Session goal</h4>
      {query.isFetching || query.isPending ? (
        <SkeletonBlock count={1} label="Reading Goal" />
      ) : query.error ? (
        <ErrorState
          variant="compact"
          title="Couldn’t read the Goal"
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
        />
      ) : data?.state === 'unsupported' ? (
        <p>Session goals are not available here.</p>
      ) : data?.state === 'unavailable' ? (
        <p>
          The engine session is unavailable. Continue the chat, then refresh.
        </p>
      ) : data?.state === 'available' ? (
        <>
          <p>
            {data.capability.implementation === 'engine'
              ? 'Engine-owned'
              : 'Station-owned'}
            {' · '}
            <StatusBadge status={data.goal?.status ?? 'No goal'} />
          </p>
          {data.goal && (
            <>
              <p>{data.goal.objective}</p>
              <p>
                {data.goal.tokensUsed} tokens used ·{' '}
                {data.goal.tokenBudget ?? 'No'} token budget ·{' '}
                {data.goal.timeUsedSeconds}s
              </p>
            </>
          )}
          <p>
            Save a paused objective. Automatic goal execution is not available
            in Station yet.
          </p>
          {editing ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const tokenBudget = budget.trim() ? Number(budget) : null;
                if (
                  tokenBudget !== null &&
                  (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
                ) {
                  setMessage('Enter a positive whole token budget.');
                  return;
                }
                void submit({ operation: 'set', objective, tokenBudget });
              }}
            >
              <label htmlFor={objectiveId}>Objective</label>
              <textarea
                id={objectiveId}
                className="editor-input"
                value={objective}
                maxLength={data.capability.maxObjectiveChars}
                required
                onChange={(event) => setObjective(event.target.value)}
              />
              <label htmlFor={budgetId}>Token budget (optional)</label>
              <input
                id={budgetId}
                className="editor-input"
                type="number"
                min="1"
                step="1"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
              />
              <div className="chat-settings-modal__control">
                <Button
                  type="submit"
                  disabled={mutation.isPending || !objective.trim()}
                >
                  Save paused goal
                </Button>
                <Button
                  type="button"
                  disabled={mutation.isPending}
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="chat-settings-modal__control">
              {data.capability.operations.includes('set') && (
                <Button
                  disabled={mutation.isPending}
                  onClick={() => {
                    setObjective(data.goal?.objective ?? '');
                    setBudget(data.goal?.tokenBudget?.toString() ?? '');
                    setEditing(true);
                  }}
                >
                  {data.goal ? 'Edit goal' : 'Set goal'}
                </Button>
              )}
              {data.goal &&
                data.capability.operations.includes('pause') &&
                data.goal.status !== 'paused' && (
                  <Button
                    disabled={mutation.isPending}
                    onClick={() => void submit({ operation: 'pause' })}
                  >
                    Pause goal
                  </Button>
                )}
              {data.goal && data.capability.operations.includes('clear') && (
                <Button
                  disabled={mutation.isPending}
                  onClick={() => void submit({ operation: 'clear' })}
                >
                  Clear goal
                </Button>
              )}
            </div>
          )}
        </>
      ) : null}
      <Button
        disabled={query.isFetching || mutation.isPending}
        onClick={() => void query.refetch()}
      >
        Refresh goal
      </Button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
