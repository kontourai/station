import { useEffect } from 'react';
import { useProjectsWaitingOnYou } from './useProjectsWaitingOnYou';
import { publishWaitingOnYou } from './waitingOnYouStore';

/**
 * Counts Tasks Waiting on you for every Project and publishes them for the
 * sidebar and the Room header (#5064). Loaded and mounted only while the
 * `project-overview` preview is on; renders nothing.
 */
export function ProjectWaitingOnYouSource() {
  const counts = useProjectsWaitingOnYou();
  useEffect(() => {
    publishWaitingOnYou(counts);
  }, [counts]);
  useEffect(() => () => publishWaitingOnYou(new Map()), []);
  return null;
}
