import type { ChildWorkTranscriptEntry } from '@kontourai/station-contracts/child-work';
import {
  StationHttpError,
  useChildWorkTranscriptQuery,
} from '@kontourai/station-sdk';
import { useEffect, useRef } from 'react';
import { Button } from '../../components/Button';
import { SkeletonBlock } from '../../components/state';

/**
 * #3163: an engine subagent's own transcript, read-only. The server resolves
 * it from the reporting session's persisted facts; this view names only the
 * session and the child. Pages load on request, never by polling.
 */

/** A reporting child's transcript re-reads at most this often. */
const TRANSCRIPT_REFRESH_THROTTLE_MS = 2_000;

function failureText(error: unknown): string {
  if (error instanceof StationHttpError && error.status === 503)
    return 'The engine no longer has this transcript.';
  if (error instanceof StationHttpError && error.status === 404)
    return 'No transcript is available for this subagent.';
  return 'Could not load the transcript.';
}

function EntryLine({ entry }: { entry: ChildWorkTranscriptEntry }) {
  const cut = entry.truncated ? (
    <span className="child-work-transcript__cut"> (cut)</span>
  ) : null;
  switch (entry.kind) {
    case 'text':
      return (
        <li className="child-work-transcript__entry" data-role={entry.role}>
          <span className="child-work-transcript__label">
            {entry.role === 'user' ? 'Prompt' : 'Subagent'}
          </span>
          <p className="child-work-transcript__text">
            {entry.text}
            {cut}
          </p>
        </li>
      );
    case 'tool-call':
      return (
        <li className="child-work-transcript__entry" data-kind="tool-call">
          <span className="child-work-transcript__label">
            Tool · {entry.name}
          </span>
          {entry.input && (
            <code className="child-work-transcript__code">
              {entry.input}
              {cut}
            </code>
          )}
        </li>
      );
    case 'tool-result':
      return (
        <li className="child-work-transcript__entry" data-kind="tool-result">
          <span className="child-work-transcript__label">
            {entry.isError ? 'Tool error' : 'Tool result'}
          </span>
          {entry.text ? (
            <code className="child-work-transcript__code">
              {entry.text}
              {cut}
            </code>
          ) : (
            <p className="child-work-transcript__text">No text output.</p>
          )}
        </li>
      );
    case 'omitted':
      return (
        <li className="child-work-transcript__entry" data-kind="omitted">
          <p className="child-work-transcript__note">
            {entry.count} more {entry.count === 1 ? 'block' : 'blocks'} in this
            message not shown.
          </p>
        </li>
      );
    case 'too-large':
      return (
        <li className="child-work-transcript__entry" data-kind="too-large">
          <p className="child-work-transcript__note">
            An entry too large to show was left out.
          </p>
        </li>
      );
  }
}

export function ChildWorkTranscript({
  id,
  threadId,
  childId,
  running,
  revision,
}: {
  id: string;
  threadId: string;
  childId: string;
  /** The child is still running, so its transcript can still grow. */
  running: boolean;
  /**
   * Changes whenever the child's reported state does (progress, usage,
   * status). The transcript is re-read on each change, so a running child's
   * last page does not stay frozen at the moment the view opened.
   */
  revision: string;
}) {
  const transcript = useChildWorkTranscriptQuery({ threadId, childId });
  const { refetch } = transcript;
  const seenRevision = useRef(revision);
  const pendingRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    // Including the change that settles it: its last messages land then.
    // Throttled, not debounced: a chatty child reports progress every few
    // hundred ms, so one re-read at most every 2 s, and a change that lands
    // while one is pending rides on it (the read happens after it). A
    // debounce would reset on every report and never fire.
    if (pendingRefresh.current !== null) return;
    pendingRefresh.current = setTimeout(() => {
      pendingRefresh.current = null;
      void refetch();
    }, TRANSCRIPT_REFRESH_THROTTLE_MS);
  }, [revision, refetch]);
  useEffect(
    () => () => {
      if (pendingRefresh.current !== null) clearTimeout(pendingRefresh.current);
    },
    [],
  );
  const entries = transcript.data?.pages.flatMap((page) => page.entries) ?? [];
  return (
    <section
      id={id}
      className="child-work-transcript"
      aria-label="Subagent transcript"
    >
      {transcript.isPending && (
        <SkeletonBlock count={3} label="Loading transcript" />
      )}
      {transcript.isError && entries.length === 0 && (
        <p className="child-work-transcript__note" role="alert">
          {failureText(transcript.error)}
        </p>
      )}
      {transcript.isSuccess && entries.length === 0 && (
        <p className="child-work-transcript__note">The transcript is empty.</p>
      )}
      {entries.length > 0 && (
        <ol className="child-work-transcript__entries">
          {entries.map((entry, index) => (
            <EntryLine
              // Entries never reorder: a page only appends.
              key={index}
              entry={entry}
            />
          ))}
        </ol>
      )}
      {transcript.hasNextPage && (
        <Button
          size="sm"
          pending={transcript.isFetchingNextPage}
          onClick={() => void transcript.fetchNextPage()}
        >
          Load more
        </Button>
      )}
      {running && !transcript.isPending && (
        <Button
          size="sm"
          pending={transcript.isRefetching}
          onClick={() => void refetch()}
        >
          Refresh
        </Button>
      )}
      {transcript.isFetchNextPageError && (
        <p className="child-work-transcript__note" role="alert">
          {failureText(transcript.error)}
        </p>
      )}
    </section>
  );
}
