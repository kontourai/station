import { hasRuntimeEventContentRefs } from '@kontourai/station-contracts/runtime-event-content';
import { useResolvedRuntimeEventValueQuery } from '@kontourai/station-sdk/runtime-event-content';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '../Button';
import { ErrorState } from '../state';

/**
 * docs/design/event-content-spill.md: a value Station stored out of line
 * shows as its marked preview until the person asks for the rest. This owns
 * that request: a "Load full content" action, its loading and failure
 * states, and the resolved value handed to `children` once loaded. The
 * query runs only after the click, so a transcript mounts none.
 */
export function LoadFullContent<T>({
  threadId,
  value,
  children,
}: {
  threadId?: string;
  value: T;
  children: (resolved: T | undefined) => ReactNode;
}) {
  const [requested, setRequested] = useState(false);
  const [resolved, setResolved] = useState<{ value: T }>();
  const spilled = Boolean(threadId) && hasRuntimeEventContentRefs(value);
  if (!spilled || resolved) return <>{children(resolved?.value)}</>;
  return (
    <>
      {children(undefined)}
      {requested ? (
        <ResolvedValueLoader
          threadId={threadId!}
          value={value}
          onLoaded={(next) => setResolved({ value: next })}
        />
      ) : (
        <Button
          className="load-full-content"
          onClick={() => setRequested(true)}
        >
          Load full content
        </Button>
      )}
    </>
  );
}

function ResolvedValueLoader<T>({
  threadId,
  value,
  onLoaded,
}: {
  threadId: string;
  value: T;
  onLoaded: (resolved: T) => void;
}) {
  const query = useResolvedRuntimeEventValueQuery({ threadId, value });
  const { data, isError, refetch } = query;
  // biome-ignore lint/correctness/useExhaustiveDependencies: onLoaded is a fresh closure per render; the loaded data is what matters.
  useEffect(() => {
    if (data !== undefined) onLoaded(data);
  }, [data]);
  if (isError)
    return (
      <ErrorState
        variant="compact"
        title="The full content could not be loaded"
        action={<Button onClick={() => void refetch()}>Try again</Button>}
      />
    );
  return (
    <p className="load-full-content__status" role="status">
      Loading the full content…
    </p>
  );
}
