import type { ComponentProps } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useScopedProjectRunLocationsQuery } from '../../contexts/ProjectsContext';
import type { ProjectChatComposerDraft } from '../../lib/projectChatEvents';
import { NewChatModal, type NewChatModalMode } from '../modals/NewChatModal';

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

export const FORK_REPLAY_ONLY_DISCLOSURE =
  'Station replays the selected transcript only. Engine cursor, tool state, and approval state do not carry.';

export type DockStartComposerProps = Omit<
  NewChatProps,
  | 'projectRunLocations'
  | 'requestAuthority'
  | 'startSurface'
  | 'draftContext'
  | 'mode'
> & {
  /** The Project a sidebar or plugin request named, with its draft. */
  newChatProjectOverride?: {
    slug: string | null;
    name: string;
    composerDraft?: ProjectChatComposerDraft;
  } | null;
  /** Set while forking: the draft offers the fork's Agent list instead. */
  forkMode?: Omit<NewChatModalMode, 'disclosure'>;
  onForkAgentSelect?: NewChatProps['onSelect'];
};

/**
 * The dock's New chat draft: the one start surface (`NewChatModal`) in the
 * dock's chat body, for a chat, a Task or a fork. This maps the dock's
 * request onto it: a fork carries none of a start's hand-over (files,
 * choices, draft) and picks through its own handler.
 *
 * #3391: the run-locations read lives here, not in the dock, so it is
 * mounted only while the draft is: the dock and the Project list never wait
 * on a project folder, and the composer names the stored folder until it
 * answers.
 */
export function DockStartComposer({
  newChatProjectOverride,
  forkMode,
  onForkAgentSelect,
  activeProjectSlug,
  initialFiles,
  startSelection,
  handoff,
  selectionInvalid,
  onSelect,
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
      initialFiles={forkMode ? undefined : initialFiles}
      startSelection={forkMode ? undefined : startSelection}
      handoff={forkMode ? undefined : handoff}
      selectionInvalid={forkMode ? false : selectionInvalid}
      draftContext={
        forkMode
          ? undefined
          : composerDraftContext(newChatProjectOverride?.composerDraft)
      }
      mode={
        forkMode
          ? { ...forkMode, disclosure: FORK_REPLAY_ONLY_DISCLOSURE }
          : undefined
      }
      onSelect={forkMode && onForkAgentSelect ? onForkAgentSelect : onSelect}
    />
  );
}
