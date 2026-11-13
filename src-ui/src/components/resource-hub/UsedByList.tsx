import { useId } from 'react';
import { Button } from '../Button';
import { Empty, ErrorState, SkeletonList } from '../state';
import './resource-hub.css';

export interface UsedByEntry {
  /** Stable within the list. */
  key: string;
  name: string;
  /** What it is and how it selects the resource: "Agent · engine". */
  detail?: string;
  /** Opens the dependent; absent renders the name as text. */
  onOpen?: () => void;
}

/** The state of the read behind the list. The feature decides it. */
export type UsedByState =
  | { kind: 'ready'; entries: readonly UsedByEntry[] }
  | { kind: 'loading' }
  | { kind: 'error'; onRetry: () => void }
  /** The viewer may not see what depends on it. */
  | { kind: 'withheld' };

/**
 * What depends on a resource, one link per dependent. Presentation only: the
 * feature resolves dependents from explicit bindings and hands over names,
 * details and how to open each.
 */
export function UsedByList({
  state,
  emptyDescription,
  title = 'Used by',
}: {
  state: UsedByState;
  /** Says what would appear here once something selects the resource. */
  emptyDescription: string;
  title?: string;
}) {
  const headingId = useId();
  return (
    <section className="used-by" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      {state.kind === 'loading' ? (
        <SkeletonList count={2} label="Loading what uses this" />
      ) : state.kind === 'error' ? (
        <ErrorState
          variant="compact"
          title="Could not load what uses this"
          action={<Button onClick={state.onRetry}>Retry</Button>}
        />
      ) : state.kind === 'withheld' ? (
        <Empty
          variant="compact"
          label="Not shown"
          description="Only this Station's operator can see what uses it."
        />
      ) : state.entries.length === 0 ? (
        <Empty
          variant="compact"
          label="Not used yet"
          description={emptyDescription}
        />
      ) : (
        <ul>
          {state.entries.map((entry) => (
            <li key={entry.key}>
              {entry.onOpen ? (
                <Button variant="link" onClick={entry.onOpen}>
                  {entry.name}
                </Button>
              ) : (
                <span>{entry.name}</span>
              )}
              {entry.detail ? (
                <span className="used-by__detail">{entry.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
