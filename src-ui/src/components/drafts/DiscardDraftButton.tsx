import { dispatchOrchestrationCommandWithReceipt } from '@kontourai/station-sdk';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DiscardGlyph } from '../icons/Glyph';
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
  onDiscarded?: (action: HTMLButtonElement) => void,
) {
  const queryClient = useQueryClient();
  const refetchSessions = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['orchestration-sessions'] }),
      queryClient.invalidateQueries({
        queryKey: ['orchestration-sessions-loaded'],
      }),
    ]);
  return useMutation({
    mutationFn: ({
      threadId,
    }: {
      threadId: string;
      action: HTMLButtonElement;
    }) =>
      dispatchOrchestrationCommandWithReceipt({
        type: 'discardDraft',
        threadId,
      }),
    onSuccess: (_result, { action }) => {
      onDiscarded?.(action);
      return refetchSessions();
    },
    onError: () => refetchSessions(),
  });
}

export const DISCARD_DRAFT_FAILED =
  'Could not discard this draft. It may have started since this list was read.';

/**
 * The row action, shared by the dock inbox, the mobile switcher, Home and
 * Sessions. No confirmation: a Draft holds no transcript by the server's own
 * definition (it refuses anything that does), and the inbox's other row
 * actions (close, snooze) act at once too.
 */
export function DiscardDraftButton({
  threadId,
  title,
  className,
  onDiscarded,
}: {
  threadId: string;
  title: string;
  className: string;
  /**
   * After the server confirmed the discard. `action` is the pressed button,
   * still attached, for hosts that move focus before the row disappears.
   */
  onDiscarded?: (action: HTMLButtonElement) => void;
}) {
  const discard = useDiscardDraft(onDiscarded);
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={`Discard draft ${title}`}
        title="Discard draft"
        // aria-disabled, not disabled: a disabled button drops focus, and the
        // inbox shows its row actions only while the row holds focus or hover
        // — the pending state and a failure would vanish with it.
        aria-disabled={discard.isPending || undefined}
        onClick={(event) => {
          if (discard.isPending) return;
          discard.mutate({ threadId, action: event.currentTarget });
        }}
      >
        <DiscardGlyph />
      </button>
      {discard.isError && (
        <span className="discard-draft__error" role="alert">
          {DISCARD_DRAFT_FAILED}
        </span>
      )}
    </>
  );
}
