import { useCopyToClipboardToast } from '../../hooks/useCopyToClipboardToast';
import { triggerHaptic } from '../../platform/native/haptics';
import type { DockMoreAction } from './ChatDockHeaderMoreMenu';

/**
 * The dock header's two clipboard rows (#1536 F).
 *
 * Both facts used to be chrome in the header bar: "Copy ID" as a 44px labelled
 * button inside the identity row, and the project's full path as a
 * start-truncated segment that a 110-character worktree path let eat the
 * conversation title. Neither is a thing you read continuously; both are things
 * you occasionally need to paste.
 *
 * The outcome is a toast, not an inline label, because a menu row is gone by the
 * time the write resolves. archive#3341's contract is unchanged and is what the
 * shared hook already implements: a refused write says so and never claims a
 * copy — and here it never buzzes either.
 */
export function useDockCopyActions(input: {
  /**
   * The durable Station thread id from the conversation route. NEVER the local
   * tab/store key (`session.id`): a copied value has to stay usable by the CLI
   * and by receipt readers, so an absent conversation id omits the row rather
   * than falling back.
   */
  conversationId?: string | null;
  /** The directory this dock's active session actually resolved to. */
  workingDirectory?: string | null;
}): DockMoreAction[] {
  const copyWithToast = useCopyToClipboardToast();
  const copy = async (value: string) => {
    if (await copyWithToast(value)) triggerHaptic('light');
  };
  return [
    ...(input.conversationId
      ? [
          {
            key: 'copy-thread-id',
            label: 'Copy thread ID',
            onSelect: () => {
              void copy(input.conversationId as string);
            },
          },
        ]
      : []),
    ...(input.workingDirectory
      ? [
          {
            key: 'copy-project-path',
            label: 'Copy project path',
            onSelect: () => {
              void copy(input.workingDirectory as string);
            },
          },
        ]
      : []),
  ];
}
