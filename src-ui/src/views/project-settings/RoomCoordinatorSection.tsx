import {
  effectiveProjectRoomCoordinatorSettings,
  MAX_COORDINATOR_CONCURRENT_TASKS,
  type ProjectRoomCoordinatorSettings,
} from '@kontourai/station-contracts/project-room-coordinator';
import { useSetProjectRoomCoordinatorSettingsMutation } from '@kontourai/station-sdk/project-room-coordinator';
import { PageRow } from '../../components/PageRow';
import { PageSection } from '../../components/PageSection';
import { ErrorState } from '../../components/state';
import { Toggle } from '../../components/Toggle';
import { userFacingErrorMessage } from '../../utils/errorText';

const LIMIT_CHOICES = Array.from(
  { length: MAX_COORDINATOR_CONCURRENT_TASKS },
  (_, index) => index + 1,
);

/**
 * The `#general` coordinator's limits (#5063). Station enforces each one;
 * it saves as soon as it changes, on its own route, apart from the page's
 * form. Shown only while the Coordinator in #general preview is on.
 */
export function RoomCoordinatorSection({
  slug,
  settings,
  onSaved,
}: {
  slug: string;
  settings: ProjectRoomCoordinatorSettings | undefined;
  onSaved(): void;
}) {
  const current = effectiveProjectRoomCoordinatorSettings(settings);
  const save = useSetProjectRoomCoordinatorSettingsMutation(slug);
  const update = (next: Partial<ProjectRoomCoordinatorSettings>) =>
    save.mutate({ ...current, ...next }, { onSuccess: onSaved });
  return (
    <PageSection
      id="section-coordinator"
      className="project-settings__section"
      title="Coordinator"
      description="The agent you ask in #general answers, proposes Tasks or passes your message to a running Task. Station holds it to these limits."
    >
      <PageRow
        label="Start without asking"
        description="Start proposed Tasks at once instead of showing them on a card first."
        control={
          <Toggle
            id="project-coordinator-start-without-asking"
            label="Start without asking"
            checked={current.startWithoutAsking}
            disabled={save.isPending}
            onChange={(startWithoutAsking) => update({ startWithoutAsking })}
          />
        }
      />
      <PageRow
        label="Tasks at once"
        description="More wait for a free slot and start as one finishes."
        control={
          <select
            id="project-coordinator-max-tasks"
            className="editor-input"
            aria-label="Tasks at once"
            value={current.maxConcurrentTasks}
            disabled={save.isPending}
            onChange={(event) =>
              update({ maxConcurrentTasks: Number(event.target.value) })
            }
          >
            {LIMIT_CHOICES.map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        }
      />
      <PageRow
        label="Pull requests"
        description="When a coordinator Task may open one. Station refuses the rest."
        control={
          <select
            id="project-coordinator-pull-requests"
            className="editor-input"
            aria-label="Pull requests"
            value={current.pullRequests}
            disabled={save.isPending}
            onChange={(event) =>
              update({
                pullRequests:
                  event.target.value === 'allowed' ? 'allowed' : 'when-asked',
              })
            }
          >
            <option value="when-asked">Only when you ask</option>
            <option value="allowed">Whenever the Task needs one</option>
          </select>
        }
      />
      {save.error && (
        <ErrorState
          variant="compact"
          title="Could not save the coordinator settings"
          description={userFacingErrorMessage(save.error)}
        />
      )}
    </PageSection>
  );
}
