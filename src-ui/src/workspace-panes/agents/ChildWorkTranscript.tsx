import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  StationHttpError,
  useChildWorkTranscriptQuery,
} from '@kontourai/station-sdk';
import { useEffect, useRef } from 'react';
import { Button } from '../../components/Button';
import { ChatMessageList } from '../../components/chat/ChatMessageList';
import { useOptionalConversationConnection } from '../../components/conversation/ConversationConnectionContext';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import type { ChatSession } from '../../types';
import { describeStationFailure } from '../../utils/stationFailure';
import { childTranscriptMessages } from './childTranscriptMessages';
import './ChildWorkTranscript.css';

/**
 * #3163: an engine subagent's own transcript, read-only. The server resolves
 * it from the reporting session's persisted facts; this view names only the
 * session and the child. Running children poll; settlement stops polling.
 */

/** A reporting child's transcript re-reads at most this often. */
const TRANSCRIPT_REFRESH_THROTTLE_MS = 2_000;

function failureText(error: unknown): string {
  if (error instanceof StationHttpError && error.status === 503)
    return 'The engine no longer has this transcript.';
  if (error instanceof StationHttpError && error.status === 404)
    return 'No transcript is available for this subagent.';
  return describeStationFailure(error).body;
}

export function ChildWorkTranscript({
  id,
  threadId,
  childId,
  running,
  revision,
  title = 'Subagent',
  engineId,
}: {
  title?: string;
  engineId?: string;
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
  const target = useOptionalConversationConnection();
  const transcript = useChildWorkTranscriptQuery(
    { threadId, childId, running, requestScope: target?.requestScope },
    target?.apiBase,
  );
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
  const session: ChatSession = {
    id: JSON.stringify([
      'child-record',
      target?.station?.runtimeKey ?? target?.apiBase,
      threadId,
      childId,
    ]),
    agentSlug: agentId(engineId ?? 'record'),
    agentName: title,
    title,
    source: 'manual',
    messages: childTranscriptMessages(entries),
    input: '',
    attachments: [],
    queuedMessages: [],
    inputHistory: [],
    status: 'idle',
    error: null,
    createdAt: 0,
    updatedAt: 0,
  };
  return (
    <section
      id={id}
      className="child-work-transcript"
      aria-label="Subagent transcript"
    >
      {transcript.isPending && (
        <SkeletonBlock count={3} label="Loading transcript" />
      )}
      {transcript.isError && !transcript.isFetchNextPageError && (
        <ErrorState
          variant="compact"
          title={
            entries.length > 0
              ? 'Could not refresh the transcript'
              : 'Could not read the transcript'
          }
          description={failureText(transcript.error)}
          action={<Button onClick={() => void refetch()}>Retry</Button>}
        />
      )}
      {transcript.isSuccess && entries.length === 0 && (
        <Empty label="No messages in this transcript yet." />
      )}
      <ChatMessageList
        activeSession={session}
        emptyState={null}
        fontSize={14}
        showReasoning={false}
        showToolDetails
        suppressStreamingRow
      />
      {transcript.hasNextPage && (
        <Button
          size="sm"
          className="tap-target"
          pending={transcript.isFetchingNextPage}
          onClick={() => void transcript.fetchNextPage()}
        >
          Load more
        </Button>
      )}
      {running && !transcript.isPending && (
        <Button
          size="sm"
          className="tap-target"
          pending={transcript.isRefetching}
          onClick={() => void refetch()}
        >
          Refresh
        </Button>
      )}
      {transcript.isFetchNextPageError && (
        <ErrorState
          variant="compact"
          title={
            entries.length > 0
              ? 'Could not refresh the transcript'
              : 'Could not read the transcript'
          }
          description={failureText(transcript.error)}
          action={<Button onClick={() => void refetch()}>Retry</Button>}
        />
      )}
    </section>
  );
}
