import {
  agentId,
  parseEngineId,
} from '@kontourai/station-contracts/agent-identity';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import {
  StationHttpError,
  useChildWorkTranscriptTailQuery,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useRef } from 'react';
import { Button } from '../../components/Button';
import { ChatMessageList } from '../../components/chat/ChatMessageList';
import { TranscriptToolRecordLive } from '../../components/chat/useObservedRunningToolCalls';
import { useOptionalConversationConnection } from '../../components/conversation/ConversationConnectionContext';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import type { ChatSession } from '../../types';
import { describeStationFailure } from '../../utils/stationFailure';
import { childTranscriptMessages } from './childTranscriptMessages';
import './ChildWorkTranscript.css';

/**
 * #3163: an engine subagent's own transcript, read-only. The server resolves
 * it from the reporting session's persisted facts; this view names only the
 * session and the child. It opens on the latest messages; older ones load
 * above as the reader scrolls up, as in the main chat. A running child reads
 * only what follows its last message; settlement stops that.
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
  const transcript = useChildWorkTranscriptTailQuery(
    { threadId, childId, running, requestScope: target?.requestScope },
    target?.apiBase,
  );
  const { refreshLatest, reload } = transcript;
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
      refreshLatest();
    }, TRANSCRIPT_REFRESH_THROTTLE_MS);
  }, [revision, refreshLatest]);
  useEffect(
    () => () => {
      if (pendingRefresh.current !== null) clearTimeout(pendingRefresh.current);
    },
    [],
  );
  const pages = transcript.data?.pages;
  const entries = useMemo(
    () => pages?.flatMap((page) => page.entries) ?? [],
    [pages],
  );
  const messages = useMemo(() => childTranscriptMessages(entries), [entries]);
  const {
    hasPreviousPage,
    isFetchingPreviousPage,
    isFetching,
    fetchPreviousPage,
    hasLaterPage,
    isFetchingNextPage,
    fetchNextPage,
  } = transcript;
  const engine = parseEngineId(engineId);
  const session: ChatSession = {
    id: JSON.stringify([
      'child-record',
      target?.station?.runtimeKey ?? target?.apiBase,
      threadId,
      childId,
    ]),
    agentSlug: agentId(engineId ?? 'record'),
    // Each reply is the engine's, as in the main chat; the breadcrumb
    // already names this subagent, so its rows do not repeat the title.
    agentName: (engine && engineDisplayLabel(engine)) || title,
    title,
    source: 'manual',
    messages,
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
      {transcript.isError && (
        <ErrorState
          variant="compact"
          title={
            entries.length > 0
              ? 'Could not load earlier messages'
              : 'Could not read the transcript'
          }
          description={failureText(transcript.error)}
          action={
            <Button
              onClick={() =>
                entries.length > 0 ? void fetchPreviousPage() : reload()
              }
            >
              Retry
            </Button>
          }
        />
      )}
      {transcript.isSuccess && entries.length === 0 && (
        <Empty label="No messages in this transcript yet." />
      )}
      {/* A settled child's calls are a record: none may read as running
          from the parent chat's live tool record. */}
      <TranscriptToolRecordLive.Provider value={running}>
        <ChatMessageList
          activeSession={session}
          emptyState={null}
          fontSize={14}
          showReasoning={false}
          showToolDetails
          suppressStreamingRow
          hasOlderMessages={hasPreviousPage}
          historyLoading={isFetchingPreviousPage}
          onLoadOlder={async () => {
            // A read already in flight would be cancelled by a new one.
            if (isFetching) return;
            await fetchPreviousPage({ cancelRefetch: false });
          }}
        />
      </TranscriptToolRecordLive.Provider>
      {/* Only from a Station that pages forward from the first message:
          its later messages are read on request, as that Station did. */}
      {hasLaterPage && (
        <Button
          size="sm"
          className="tap-target"
          pending={isFetchingNextPage}
          onClick={() => {
            if (!isFetching) void fetchNextPage({ cancelRefetch: false });
          }}
        >
          Show later messages
        </Button>
      )}
      {transcript.latestError && (
        <ErrorState
          variant="compact"
          title="Could not read the latest messages"
          description={failureText(transcript.latestError)}
          action={<Button onClick={() => refreshLatest()}>Retry</Button>}
        />
      )}
    </section>
  );
}
