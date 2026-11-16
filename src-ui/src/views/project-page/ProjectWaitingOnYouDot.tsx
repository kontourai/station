import { useProjectsWaitingOnYou } from './useProjectsWaitingOnYou';

// Gated by `useProjectsWaitingOnYou`: with the preview off it counts nothing.

/**
 * The Room header's "Waiting on you" dot (#5064): the sidebar's signal, on
 * the Project the Room belongs to. Nothing renders when nothing waits.
 */
export function ProjectWaitingOnYouDot({ slug }: { slug: string }) {
  const count = useProjectsWaitingOnYou().get(slug) ?? 0;
  if (count === 0) return null;
  return (
    <span className="project-room__waiting">
      <span className="project-room__waiting-dot" aria-hidden="true" />
      <span className="project-room__waiting-label">
        {count === 1
          ? '1 Task waiting on you'
          : `${count} Tasks waiting on you`}
      </span>
    </span>
  );
}
