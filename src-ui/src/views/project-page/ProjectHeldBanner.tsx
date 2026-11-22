import type { ProjectLifecycle } from '@kontourai/station-contracts/project-lifecycle';
import { useProjectLifecycleMutation } from '@kontourai/station-sdk';
import { Button } from '../../components/Button';
import { userFacingErrorMessage } from '../../utils/errorText';
import '../project-settings/ProjectLifecycleSection.css';

/**
 * #5069: a paused or archived Project says so at the top of its page, with
 * the one action that lifts the hold.
 */
export function ProjectHeldBanner({
  slug,
  lifecycle,
}: {
  slug: string;
  lifecycle: ProjectLifecycle | undefined;
}) {
  const mutation = useProjectLifecycleMutation(slug);
  if (!lifecycle) return null;
  const paused = lifecycle.state === 'paused';
  return (
    <div className="project-paused-banner" role="status">
      <p className="project-paused-banner__text">
        {paused
          ? 'Paused. Chats here take no messages and schedules wait.'
          : 'Archived. Chats here take no messages and schedules wait.'}
      </p>
      <Button
        variant="primary"
        pending={mutation.isPending}
        onClick={() => mutation.mutate(paused ? 'resume' : 'unarchive')}
      >
        {paused ? 'Resume' : 'Unarchive'}
      </Button>
      {mutation.error && (
        <p className="editor-error">{userFacingErrorMessage(mutation.error)}</p>
      )}
    </div>
  );
}
