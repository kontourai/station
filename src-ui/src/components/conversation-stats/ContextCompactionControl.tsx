import { useId, useState } from 'react';
import { useContextCompaction } from '../../hooks/useContextCompaction';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { errorText } from '../../utils/errorText';
import { Button } from '../Button';
import { ErrorState, SkeletonBlock } from '../state';

/** Mounted within the existing conversation stats/context surface, not new composer chrome. */
export function ContextCompactionControl({
  apiBase,
  conversationId,
}: {
  apiBase: string;
  conversationId: string;
}) {
  const { enabled, query, compact, policy } = useContextCompaction(
    apiBase,
    conversationId,
  );
  const [draft, setDraft] = useState<{
    threshold: number;
    autoEnabled: boolean;
  } | null>(null);
  const value = draft ?? {
    threshold: query.data?.threshold ?? 90,
    autoEnabled: query.data?.autoEnabled ?? false,
  };
  const dirty =
    draft !== null &&
    (draft.threshold !== query.data?.threshold ||
      draft.autoEnabled !== query.data?.autoEnabled);
  const { DiscardModal } = useUnsavedGuard(dirty);
  const id = useId();
  if (!enabled) return null;
  return (
    <section aria-label="Context compaction">
      <h3>Context compaction</h3>
      <p>
        Retain a model-generated summary for the next cold start. Generating it
        can spend model credits.
      </p>
      {query.isLoading && <SkeletonBlock />}
      {query.isError && (
        <ErrorState
          variant="compact"
          title={errorText(query.error)}
          action={
            <Button onClick={() => void query.refetch()}>
              Reload context policy
            </Button>
          }
        />
      )}
      {query.data && (
        <>
          <p role="status">
            {query.data.state}
            {query.data.reason ? `: ${query.data.reason}` : ''}
          </p>
          <label htmlFor={`${id}-automatic`}>
            <input
              id={`${id}-automatic`}
              type="checkbox"
              checked={value.autoEnabled}
              disabled={policy.isPending}
              onChange={(event) =>
                setDraft({ ...value, autoEnabled: event.target.checked })
              }
            />{' '}
            Compact automatically after an eligible completed turn
          </label>
          <label htmlFor={`${id}-threshold`}>
            Confirmed context threshold (5–90%)
          </label>
          <input
            className="editor-input"
            id={`${id}-threshold`}
            type="number"
            min={5}
            max={90}
            step={1}
            value={value.threshold}
            disabled={policy.isPending}
            onChange={(event) =>
              setDraft({ ...value, threshold: Number(event.target.value) })
            }
          />
          <Button
            disabled={
              !dirty ||
              policy.isPending ||
              !Number.isInteger(value.threshold) ||
              value.threshold < 5 ||
              value.threshold > 90
            }
            onClick={() =>
              policy.mutate(value, { onSuccess: () => setDraft(null) })
            }
          >
            Save context policy
          </Button>
          <Button
            variant="primary"
            disabled={compact.isPending || query.data.state !== 'ready'}
            onClick={() => compact.mutate()}
          >
            Compact context
          </Button>
          {query.data.operation && (
            <p>
              Operation: {query.data.operation.state}
              {query.data.operation.reason
                ? ` · ${query.data.operation.reason}`
                : ''}
            </p>
          )}
          <details>
            <summary>What the next context keeps</summary>
            <p>
              Raw history stays readable. Earlier tools, approvals and
              attachments are omitted from engine context.
            </p>
          </details>
        </>
      )}
      {(compact.isError || policy.isError) && (
        <ErrorState
          variant="compact"
          title={errorText(compact.error ?? policy.error)}
          action={
            <Button onClick={() => void query.refetch()}>
              Check retained outcome
            </Button>
          }
        />
      )}
      <DiscardModal />
    </section>
  );
}
