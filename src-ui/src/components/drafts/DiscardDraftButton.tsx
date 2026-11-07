import { dispatchOrchestrationCommandWithReceipt } from '@kontourai/station-sdk';
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { Button } from '../Button';
import { DiscardGlyph, ReturnGlyph } from '../icons/Glyph';
import './DiscardDraftButton.css';

/**
 * #2312: discarding a Draft is a SERVER action (`discardDraft`), so every
 * device agrees — never a local hide. Success and failure both re-read the
 * session lists: success so this device drops the row, failure because the
 * usual reason is that the row was no longer a Draft (a send landed from
 * another device), and the re-read shows what it is now.
 *
 * `onDiscarded` runs in the mutation's own `onSuccess`, BEFORE the re-read:
 * the re-read removes the row that rendered the button, and a per-call
 * `mutate(…, { onSuccess })` callback does not fire once its component has
 * unmounted — the host's focus move and tab teardown would silently not run.
 */
function useDiscardDraft(
  threadId: string,
  onDiscarded: ((action: HTMLButtonElement) => void) | undefined,
  closeSessionIds: readonly string[],
) {
  const queryClient = useQueryClient();
  const scope = useHostRequestAuthorityScope();
  const mutationKey = [
    'discard-draft',
    scope?.apiBase,
    scope?.authorityKey,
    threadId,
  ];
  const pending = useIsMutating({ mutationKey, exact: true }) > 0;
  const [waiting, setWaiting] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const delay = useRef<{
    timer: ReturnType<typeof setTimeout>;
    finish: (proceed: boolean) => void;
  } | null>(null);
  const cancel = useCallback(() => {
    const current = delay.current;
    delay.current = null;
    if (current) {
      clearTimeout(current.timer);
      current.finish(false);
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: ownership changes cancel the previous authority's deferred delete.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      cancel();
    };
  }, [cancel, scope?.apiBase, scope?.authorityKey, threadId]);
  const refetchSessions = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['orchestration-sessions'] }),
      queryClient.invalidateQueries({
        queryKey: ['orchestration-sessions-loaded'],
      }),
    ]);
  const mutation = useMutation({
    mutationKey,
    mutationFn: async ({
      threadId,
      scope: captured,
      generation: started,
    }: {
      threadId: string;
      action: HTMLButtonElement;
      scope: NonNullable<typeof scope>;
      generation: number;
      closeSessionIds: readonly string[];
    }) => {
      if (
        !mounted.current ||
        generation.current !== started ||
        !captured.isCurrent()
      )
        return false;
      setWaiting(true);
      const proceed = await new Promise<boolean>((finish) => {
        delay.current = {
          timer: setTimeout(() => {
            delay.current = null;
            finish(true);
          }, 8000),
          finish,
        };
      });
      if (mounted.current && generation.current === started) setWaiting(false);
      if (
        !proceed ||
        !mounted.current ||
        generation.current !== started ||
        !captured.isCurrent()
      )
        return false;
      await dispatchOrchestrationCommandWithReceipt(
        { type: 'discardDraft', threadId },
        captured.apiBase,
        undefined,
        { requestScope: captured },
      );
      return true;
    },
    onSuccess: (
      discarded,
      {
        threadId,
        action,
        scope: captured,
        generation: started,
        closeSessionIds,
      },
    ) => {
      if (!discarded || !captured.isCurrent()) return;
      if (
        mounted.current &&
        generation.current === started &&
        action.isConnected
      )
        onDiscarded?.(action);
      // #2312 review: whichever surface discarded it, a tab this device
      // still has open on the Draft now names a deleted session — and a send
      // from it would silently start a new one. The dock hosts close it with
      // their own bookkeeping in `onDiscarded`; this catches the rest (Home,
      // Sessions) and is a no-op once a host already closed it.
      // Verifier L6: every Session of the discarded conversation, and every
      // chat bound to any of them — not only the first match.
      // Bounded: each pass removes the chat it found, and the cap keeps a
      // store that failed to remove one from spinning.
      for (const sessionId of new Set([threadId, ...closeSessionIds])) {
        for (let pass = 0; pass < MAX_CHATS_CLOSED_PER_SESSION; pass += 1) {
          const key = activeChatsStore.getChatKeyForExecutionSession(sessionId);
          if (key === undefined) break;
          activeChatsStore.removeChat(key);
        }
      }
      return refetchSessions();
    },
    onError: (_error, { scope: captured }) => {
      if (captured.isCurrent()) return refetchSessions();
    },
  });
  return {
    ...mutation,
    waiting:
      waiting &&
      mutation.variables?.scope.apiBase === scope?.apiBase &&
      mutation.variables?.scope.authorityKey === scope?.authorityKey &&
      mutation.variables?.threadId === threadId,
    pending,
    available: !!scope?.isCurrent(),
    undo: cancel,
    start: (action: HTMLButtonElement) => {
      if (
        !scope?.isCurrent() ||
        queryClient.isMutating({ mutationKey, exact: true })
      )
        return;
      mutation.mutate({
        threadId,
        action,
        scope,
        generation: generation.current,
        closeSessionIds,
      });
    },
  };
}

/** More local chats than one device ever holds for one session. */
const MAX_CHATS_CLOSED_PER_SESSION = 64;

/**
 * `draft_busy` is the one refusal worth its own words: it is retryable
 * (a start was underway on another device or tab), and the server's
 * sentence says so. Anything else reads as the generic failure.
 */
function discardFailureText(error: unknown): string {
  return error instanceof Error &&
    (error as { code?: unknown }).code === 'draft_busy' &&
    error.message.trim()
    ? error.message
    : DISCARD_DRAFT_FAILED;
}

export const DISCARD_DRAFT_FAILED =
  'Could not discard this draft. It may have started since this list was read.';

/**
 * The row action, shared by the dock inbox, the mobile switcher, Home and
 * Sessions. Undo cancels an eight-second wait before the server delete;
 * leaving the surface or changing authority cancels that wait too.
 */
export function DiscardDraftButton({
  threadId,
  title,
  className,
  closeSessionIds = [],
  onDiscarded,
  label,
}: {
  /** Visible words beside the icon, for a host that lists it as a button
   *  among other labelled buttons rather than as an icon in a row. */
  label?: string;
  threadId: string;
  title: string;
  className: string;
  /**
   * The row's other identities — its conversation id and every Session
   * folded into it. The server deletes the whole conversation, so a tab
   * bound to any of them is closed.
   */
  closeSessionIds?: readonly string[];
  /**
   * After the server confirmed the discard. `action` is the pressed button,
   * still attached, for hosts that move focus before the row disappears.
   */
  onDiscarded?: (action: HTMLButtonElement) => void;
}) {
  const discard = useDiscardDraft(threadId, onDiscarded, closeSessionIds);
  return (
    <>
      <Button
        className={`${className}${discard.waiting ? ' discard-draft__cancel' : ''}`}
        aria-label={
          discard.waiting
            ? `Undo discard of ${title}`
            : `Discard draft ${title}`
        }
        title={
          discard.waiting
            ? 'Undo draft discard'
            : discard.available
              ? 'Discard draft'
              : 'Connect to this Station to discard the draft'
        }
        // aria-disabled, not disabled: a disabled button drops focus, and the
        // inbox shows its row actions only while the row holds focus or hover
        // — the pending state and a failure would vanish with it.
        aria-disabled={
          (!discard.waiting && discard.pending) ||
          !discard.available ||
          undefined
        }
        aria-busy={(!discard.waiting && discard.isPending) || undefined}
        onClick={(event) => {
          if (discard.waiting) {
            discard.undo();
            event.currentTarget.focus();
          } else discard.start(event.currentTarget);
        }}
      >
        {discard.waiting ? <ReturnGlyph /> : <DiscardGlyph />}
        {discard.waiting ? 'Undo' : label}
      </Button>
      {discard.waiting && (
        <span
          className={label ? 'discard-draft__undo' : 'sr-only'}
          role="status"
        >
          Draft will be discarded
        </span>
      )}
      {discard.isError && discard.variables?.scope.isCurrent() && (
        <span className="discard-draft__error" role="alert">
          {discardFailureText(discard.error)}
        </span>
      )}
    </>
  );
}
