import {
  SESSION_SUMMARY_GENERATE_MUTATION_KEY,
  useDeleteSessionSummaryMutation,
  useDismissSessionSummaryMutation,
  useGenerateSessionSummaryMutation,
  useSessionSummaryQuery,
} from '@kontourai/station-sdk';
import { useMutationState } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ChatSession } from '../../types';
import { log } from '../../utils/logger';

interface GenerateRunState {
  status: 'pending' | 'error' | 'success' | 'idle';
  conversationId?: string;
  errorMessage?: string;
  submittedAt: number;
}

/**
 * A sibling of the transcript log, never a transcript row: this semantic
 * separation makes derived model output visibly distinct from source turns.
 *
 * kontourai/station#3310: where a host offers its OWN entry point, the
 * un-generated state renders NOTHING, so an unsummarized chat pays zero
 * transcript pixels for a feature it isn't using. That host opts in with
 * `hasSettingsEntryPoint` — today the chat dock, whose gear opens
 * `ChatSettingsPanel`.
 *
 * The default is FALSE on purpose. `ChatMessageList` has a second host
 * (`ACPChatPanel`) that renders no gear and no `ChatSettingsPanel`, and
 * demoting the button there would remove the only way to summarize an ACP
 * chat. A host that does not claim an entry point keeps the inline button, so
 * the affordance can never go missing by omission — including for a host
 * added later.
 *
 * When the host does claim one, the card appears only if a summary exists,
 * generation is in flight, or a generation the user asked for failed (Retry +
 * dismiss). A failed summary QUERY — nothing the user did — degrades
 * silently: logged, no alert band. Generation runs are observed via the shared
 * mutation key (`SESSION_SUMMARY_GENERATE_MUTATION_KEY`), so a generate
 * triggered from the menu shows its progress and failure here.
 */
export function SessionSummaryCard({
  activeSession,
  hasSettingsEntryPoint = false,
}: {
  activeSession: ChatSession;
  /** The host offers its own Summarize entry point (a gear opening `ChatSettingsPanel`). */
  hasSettingsEntryPoint?: boolean;
}) {
  const agentSlug = activeSession.agentSlug;
  const conversationId = activeSession.conversationId;
  const messages = activeSession.messages ?? [];
  const latestMessage = messages.at(-1);
  // This reaches the query key through the same active transcript projection
  // rendered below, making stale refresh when a real later turn arrives.
  const transcriptExtent = `${activeSession.orchestrationHistoryRevision ?? 0}:${latestMessage?.id ?? messages.length}`;
  const summary = useSessionSummaryQuery(
    agentSlug,
    conversationId,
    transcriptExtent,
  );
  const generate = useGenerateSessionSummaryMutation();
  const dismiss = useDismissSessionSummaryMutation();
  const remove = useDeleteSessionSummaryMutation();
  const generateRuns = useMutationState<GenerateRunState>({
    filters: { mutationKey: SESSION_SUMMARY_GENERATE_MUTATION_KEY },
    select: (mutation) => ({
      status: mutation.state.status,
      conversationId: (
        mutation.state.variables as { conversationId?: string } | undefined
      )?.conversationId,
      errorMessage:
        mutation.state.error instanceof Error
          ? mutation.state.error.message
          : undefined,
      submittedAt: mutation.state.submittedAt ?? 0,
    }),
  });
  // A failed generation is dismissible without dismissing the feature; a NEW
  // failure after the dismissal shows again (submittedAt moves forward).
  // Keyed BY CONVERSATION: this component mounts once per host and is not
  // re-keyed when the active chat changes, and `submittedAt` is wall-clock, so
  // a single scalar let a dismissal in one chat hide an OLDER, never-seen
  // failure in another — that chat would render nothing at all, with no Retry.
  const [errorDismissedAt, setErrorDismissedAt] = useState<
    Record<string, number>
  >({});
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);

  const queryError = summary.error;
  useEffect(() => {
    if (!queryError) return;
    // The user did nothing — degrade silently instead of injecting an alert
    // band into the chat (#3310). The menu entry point still works.
    log.chat('session summary query failed: %o', queryError);
  }, [queryError]);
  const dismissError = dismiss.error;
  useEffect(() => {
    if (!dismissError) return;
    // A failed dismiss leaves the card visible with its buttons re-enabled —
    // the state speaks for itself; log the cause for diagnosis.
    log.chat('session summary dismiss failed: %o', dismissError);
  }, [dismissError]);

  if (!conversationId || summary.isLoading) return null;
  const data = summary.data;
  const runsForConversation = generateRuns.filter(
    (run) => run.conversationId === conversationId,
  );
  const isGenerating = runsForConversation.some(
    (run) => run.status === 'pending',
  );
  const latestRun = runsForConversation.at(-1);
  const failedGeneration =
    !isGenerating &&
    latestRun?.status === 'error' &&
    latestRun.submittedAt > (errorDismissedAt[conversationId] ?? 0)
      ? latestRun
      : null;
  const pending = isGenerating || dismiss.isPending || remove.isPending;
  const observedVerificationRefs = data?.verificationRefs?.filter(
    (reference) => reference.state === 'observed',
  );

  if (!data && !isGenerating && !failedGeneration) {
    // No host entry point: keep the inline button, or this host loses the
    // only way to summarize (#3310 review — ACPChatPanel).
    if (hasSettingsEntryPoint) return null;
    return (
      <aside className="session-summary" aria-label="Derived session summary">
        <button
          type="button"
          disabled={pending}
          onClick={() => generate.mutate({ agentSlug, conversationId })}
        >
          Summarize session
        </button>
      </aside>
    );
  }

  return (
    <aside className="session-summary" aria-label="Derived session summary">
      {data ? (
        <>
          <div className="session-summary__header">
            <strong>Session summary</strong>
            <span>Derived, not evidence</span>
            {data.stale && (
              <span className="session-summary__stale">
                Stale — newer turns exist
              </span>
            )}
          </div>
          <p className="session-summary__text">{data.overview ?? data.text}</p>
          {data.goals?.length ? (
            <SummarySection title="Goals" items={data.goals} />
          ) : null}
          {data.constraints?.length ? (
            <SummarySection title="Constraints" items={data.constraints} />
          ) : null}
          {data.progress?.length ? (
            <SummarySection title="Progress" items={data.progress} />
          ) : null}
          {data.nextSteps?.length ? (
            <SummarySection title="Next steps" items={data.nextSteps} />
          ) : null}
          {data.reportedCompletion?.length ? (
            <section className="session-summary__section">
              <strong>Reported completion — not independently verified</strong>
              <ul>
                {data.reportedCompletion.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {data.sourceRanges?.length || data.sourceRange ? (
            <section className="session-summary__section">
              <strong>Related transcript evidence</strong>
              <ul>
                {(data.sourceRanges?.length
                  ? data.sourceRanges
                  : [data.sourceRange]
                ).map((range, index) => (
                  <li
                    key={`${range.fromMessageId}:${range.throughMessageId}:${index}`}
                  >
                    <a
                      href={`#station-message=${encodeURIComponent(range.fromMessageId)}`}
                    >
                      Messages {range.fromMessageId} through{' '}
                      {range.throughMessageId}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {data.relatedEvidenceRefs?.length ? (
            <section className="session-summary__section">
              <strong>
                Related Task/turn evidence — does not verify completion
              </strong>
              <ul>
                {data.relatedEvidenceRefs.map((reference, index) => (
                  <li key={`${reference.eventId}:${index}`}>
                    <a href={`/tasks/${encodeURIComponent(reference.taskId)}`}>
                      Task reference
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <p className="session-summary__verification">
            Independent verification:{' '}
            {observedVerificationRefs?.length
              ? 'server-observed verification is listed below.'
              : 'unavailable — this derived summary cannot verify completion.'}
          </p>
          {observedVerificationRefs?.length ? (
            <section className="session-summary__section">
              <strong>Independent verification</strong>
              <ul>
                {observedVerificationRefs.map((reference) => (
                  <li key={reference.eventId}>
                    <a href={`/tasks/${encodeURIComponent(reference.taskId)}`}>
                      Task verification
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {data.contextBoundaries?.length ? (
            <section className="session-summary__section">
              <strong>Context boundary disclosure</strong>
              <ul>
                {data.contextBoundaries.map((boundary) => (
                  <li key={boundary.boundaryId}>
                    {boundary.policy === 'empty-next-cold-start'
                      ? 'Prior transcript not injected. Summary separately reads canonical history.'
                      : 'Prior transcript re-anchored and injected.'}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <p className="session-summary__coverage">
            Latest{' '}
            {data.sourceRange?.messageCount ?? data.summarizedMessageCount} of{' '}
            {data.sourceMessageCount} messages summarized. Source range{' '}
            {data.sourceRange?.fromMessageId ?? data.summarizedFromMessageId}{' '}
            through{' '}
            {data.sourceRange?.throughMessageId ??
              data.summarizedThroughMessageId}
            {data.partialMessageIncluded
              ? '; final message partially included'
              : ''}
          </p>
          <p className="session-summary__attribution">
            Generated by {data.model} at{' '}
            <time dateTime={data.generatedAt}>
              {new Date(data.generatedAt).toLocaleString()}
            </time>
          </p>
          <div className="session-summary__actions">
            <button
              type="button"
              disabled={pending}
              onClick={() => generate.mutate({ agentSlug, conversationId })}
            >
              Regenerate
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => dismiss.mutate({ agentSlug, conversationId })}
            >
              Dismiss summary
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setDeleteConfirmation(true)}
            >
              Delete
            </button>
          </div>
          {deleteConfirmation ? (
            <div role="alertdialog" aria-label="Delete derived summary">
              <p>
                Delete this derived summary? The transcript and Task evidence
                stay unchanged.
              </p>
              <button
                type="button"
                onClick={() => {
                  remove.mutate({ agentSlug, conversationId });
                  setDeleteConfirmation(false);
                }}
              >
                Delete summary
              </button>
              <button
                type="button"
                onClick={() => setDeleteConfirmation(false)}
              >
                Cancel
              </button>
            </div>
          ) : null}
        </>
      ) : isGenerating ? (
        <p className="session-summary__generating" role="status">
          Generating summary…
        </p>
      ) : null}
      {failedGeneration && (
        <div className="session-summary__failure" role="alert">
          <p>
            Summary generation failed
            {failedGeneration.errorMessage
              ? `: ${failedGeneration.errorMessage}`
              : '.'}
          </p>
          <div className="session-summary__actions">
            <button
              type="button"
              disabled={pending}
              onClick={() => generate.mutate({ agentSlug, conversationId })}
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() =>
                setErrorDismissedAt((dismissed) => ({
                  ...dismissed,
                  [conversationId]: failedGeneration.submittedAt,
                }))
              }
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function SummarySection({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="session-summary__section">
      <strong>{title}</strong>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
