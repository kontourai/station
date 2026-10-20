import type { ComponentProps } from 'react';
import { useScopedProjectRunLocationsQuery } from '../../contexts/ProjectsContext';
import { NewChatModal } from '../modals/NewChatModal';

/**
 * The dock's start composer with where each project's chats run (#3391).
 * The run-locations read lives here, not in the dock, so it is mounted only
 * while the composer is open: the dock and the Project list never wait on a
 * project folder, and the composer names the stored folder until it answers.
 */
export function DockStartComposer(
  props: Omit<ComponentProps<typeof NewChatModal>, 'projectRunLocations'>,
) {
  const projectRunLocations = useScopedProjectRunLocationsQuery().data;
  return <NewChatModal {...props} projectRunLocations={projectRunLocations} />;
}
