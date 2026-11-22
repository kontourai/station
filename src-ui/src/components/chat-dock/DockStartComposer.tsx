import type { ComponentProps } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useScopedProjectRunLocationsQuery } from '../../contexts/ProjectsContext';
import type { ProjectChatComposerDraft } from '../../lib/projectChatEvents';
import { NewChatModal } from '../modals/NewChatModal';

type NewChatProps = ComponentProps<typeof NewChatModal>;

/**
 * A requested composer draft, as the New Chat picker's removable context
 * item. `verbatim` so the text lands exactly as the requester wrote it.
 */
export function composerDraftContext(
  draft: ProjectChatComposerDraft | undefined,
): NewChatProps['draftContext'] {
  if (!draft) return undefined;
  return {
    title: draft.title,
    description: draft.description,
    framing: 'verbatim',
    items: [
      {
        id: 'composer-draft',
        label: draft.label,
        detail: draft.detail,
        messageLine: draft.message,
      },
    ],
  };
}

export type DockStartComposerProps = Omit<
  NewChatProps,
  'projectRunLocations' | 'requestAuthority' | 'startSurface' | 'draftContext'
> & {
  /** The Project a sidebar or plugin request named, with its draft. */
  newChatProjectOverride?: {
    slug: string | null;
    name: string;
    composerDraft?: ProjectChatComposerDraft;
  } | null;
};

/**
 * The dock's New chat draft: the one start surface (`NewChatModal`) in the
 * dock's chat body, for a chat or a Task. Forks pick in
 * `ConversationForkDialog` instead.
 *
 * #3391: the run-locations read lives here, not in the dock, so it is
 * mounted only while the draft is: the dock and the Project list never wait
 * on a project folder, and the composer names the stored folder until it
 * answers.
 */
export function DockStartComposer({
  newChatProjectOverride,
  activeProjectSlug,
  ...props
}: DockStartComposerProps) {
  const projectRunLocations = useScopedProjectRunLocationsQuery().data;
  const requestAuthority = useHostRequestAuthorityScope();
  return (
    <NewChatModal
      {...props}
      startSurface
      requestAuthority={requestAuthority}
      projectRunLocations={projectRunLocations}
      activeProjectSlug={
        newChatProjectOverride ? newChatProjectOverride.slug : activeProjectSlug
      }
      draftContext={composerDraftContext(newChatProjectOverride?.composerDraft)}
    />
  );
}
