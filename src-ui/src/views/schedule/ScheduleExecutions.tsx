import type { RunSummary } from '@kontourai/station-contracts/runs';
import { Button } from '../../components/Button';
import { Empty, SkeletonBlock } from '../../components/state';
import { useFetchRunOutputRef } from '../../hooks/useScheduler';

export function ScheduleExecutions({
  runs,
  loading,
  unavailable,
  selectedId,
  onSelect,
}: {
  runs: RunSummary[];
  loading: boolean;
  unavailable: boolean;
  selectedId: string | null;
  onSelect: (runId: string) => void;
}) {
  if (loading) return <SkeletonBlock label="Loading executions" />;
  if (unavailable)
    return <p role="status">Execution history is unavailable.</p>;
  const scheduled = runs
    .filter((run) => run.source === 'schedule')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const selected = scheduled.find((run) => run.runId === selectedId);
  return (
    <>
      {scheduled.length === 0 ? (
        <Empty
          variant="compact"
          label="Executions appear after an automation runs"
        />
      ) : (
        <ul className="schedule__executions" aria-label="Scheduled executions">
          {scheduled.map((run) => (
            <li key={run.runId}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onSelect(run.runId)}
              >
                View run for {run.sourceId ?? run.providerId}
              </Button>{' '}
              <time dateTime={run.startedAt}>
                {new Date(run.startedAt).toLocaleString()}
              </time>{' '}
              {run.status}
              {!run.outputRef &&
                run.status !== 'running' &&
                ' · Result unavailable'}
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <section
          className="schedule__execution-receipt"
          aria-label="Selected run details"
        >
          <h3>{selected.sourceId ?? 'Scheduled execution'}</h3>
          <p>
            {selected.status} · Attempt {selected.attempt}
          </p>
          <ExecutionResult key={selected.runId} run={selected} />
        </section>
      )}
    </>
  );
}

function ExecutionResult({ run }: { run: RunSummary }) {
  const result = useFetchRunOutputRef();
  const outputRef = run.outputRef;
  return (
    <>
      {run.failureMessage && <p>{run.failureMessage}</p>}
      {outputRef && (
        <Button
          variant="secondary"
          disabled={result.isPending}
          onClick={() => result.mutate(outputRef)}
        >
          Load result
        </Button>
      )}
      {result.isError && (
        <p role="status">The recorded result is unavailable.</p>
      )}
      {result.data && <pre>{result.data.content}</pre>}
    </>
  );
}
