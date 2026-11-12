import { collectRuntimeEventContentRefs } from '@kontourai/station-contracts/runtime-event-content';
import { useResolvedRuntimeEventValueQuery } from '@kontourai/station-sdk/runtime-event-content';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '../Button';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { ErrorState, SkeletonBlock } from '../state';

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
  const target = useOptionalConversationConnection();
  // A value whose references change (a later event for the same row) is a
  // new value to load: the request and the result are keyed by its refs.
  const refs = collectRuntimeEventContentRefs(value)
    .map((ref) => ref.ref)
    .join(',');
  const refsKey = JSON.stringify([
    target?.apiBase,
    target?.requestScope?.authorityKey,
    refs,
  ]);
  const [requested, setRequested] = useState<string>();
  const [resolved, setResolved] = useState<{ key: string; value: T }>();
  const loadedRef = useRef<HTMLDivElement>(null);
  const focusOnLoad = useRef(false);
  const spilled = Boolean(threadId) && refs.length > 0;
  const loaded = resolved?.key === refsKey ? resolved : undefined;
  useEffect(() => {
    // The button the person pressed is gone once the content loads; focus
    // moves to what it loaded, not to the document body.
    if (loaded && focusOnLoad.current) {
      focusOnLoad.current = false;
      loadedRef.current?.focus();
    }
  }, [loaded]);
  if (!spilled) return <>{children(undefined)}</>;
  if (loaded)
    return (
      <div ref={loadedRef} tabIndex={-1} className="load-full-content__loaded">
        {children(loaded.value)}
      </div>
    );
  return (
    <>
      {children(undefined)}
      {requested === refsKey ? (
        <ResolvedValueLoader
          threadId={threadId!}
          value={value}
          onLoaded={(next) => setResolved({ key: refsKey, value: next })}
        />
      ) : (
        <Button
          className="load-full-content"
          onClick={() => {
            focusOnLoad.current = true;
            setRequested(refsKey);
          }}
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
  const target = useOptionalConversationConnection();
  const query = useResolvedRuntimeEventValueQuery({
    threadId,
    value,
    ...target,
  });
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
        action={<Button onClick={() => void refetch()}>Retry</Button>}
      />
    );
  return (
    <SkeletonBlock
      count={1}
      label="Loading the full content"
      className="load-full-content__status"
    />
  );
}
