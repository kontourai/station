import type { AgentNotificationLevel } from '@kontourai/station-contracts/notification-preferences';
import {
  TASK_OVERVIEW_AUTO_RESOLVE_DEFAULT_DAYS,
  taskOverviewAutoResolveDays,
} from '@kontourai/station-contracts/task-overview';
import {
  useNotificationPreferencesQuery,
  usePatchNotificationPreferencesMutation,
  useUpdateProjectMutation,
} from '@kontourai/station-sdk';
import { Select } from '@kontourai/ui/react';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { PageRow } from '../../components/PageRow';
import { PageSection } from '../../components/PageSection';
import { ErrorState } from '../../components/state';
import { userFacingErrorMessage } from '../../utils/errorText';

/** The quiet periods offered; a stored value outside them is shown too. */
const AUTO_RESOLVE_CHOICES = [0, 1, 3, 7, 14, 30] as const;

type ProjectNotificationChoice = 'station' | AgentNotificationLevel;

/**
 * What each per-Project level sends, in the person's words (#5072).
 * `attention-only` lets needs-input, approval and failure through and keeps
 * finished turns in the inbox; the inbox always keeps everything.
 */
const NOTIFICATION_CHOICES: readonly {
  value: ProjectNotificationChoice;
  label: string;
}[] = [
  { value: 'station', label: 'Use Station settings' },
  { value: 'attention-only', label: 'Only when blocked' },
  { value: 'all', label: 'Everything' },
  { value: 'off', label: 'Off' },
];

const NOTIFICATION_DESCRIPTIONS: Record<ProjectNotificationChoice, string> = {
  station: 'Follows your Station notification settings.',
  'attention-only':
    'When a Task needs input or approval, or fails. Finished turns stay in the inbox.',
  all: 'Also when any Task finishes a turn.',
  off: 'Nothing interrupts you. The inbox keeps everything.',
};

const daysLabel = (days: number) =>
  days === 0 ? 'Never' : days === 1 ? 'After 1 day' : `After ${days} days`;

/**
 * Per-Project Overview and notification settings (#5064, #5072). Each control
 * saves on its own, so neither waits on the page's Save.
 */
export function OverviewNotificationsSection({
  slug,
  projectId,
  autoResolveDays: storedDays,
}: {
  slug: string;
  projectId: string | undefined;
  autoResolveDays: number | undefined;
}) {
  const updateProject = useUpdateProjectMutation();
  const preferences = useNotificationPreferencesQuery();
  const patchPreferences = usePatchNotificationPreferencesMutation();
  const [saveError, setSaveError] = useState<string | null>(null);
  const days = taskOverviewAutoResolveDays(storedDays);
  const dayChoices = (AUTO_RESOLVE_CHOICES as readonly number[]).includes(days)
    ? AUTO_RESOLVE_CHOICES
    : [...AUTO_RESOLVE_CHOICES, days].sort((a, b) => a - b);
  const level: ProjectNotificationChoice =
    (projectId && preferences.data?.perProject[projectId]) || 'station';

  async function saveDays(next: number) {
    setSaveError(null);
    try {
      await updateProject.mutateAsync({
        slug,
        overviewAutoResolveDays: next,
      });
    } catch (error) {
      setSaveError(userFacingErrorMessage(error));
    }
  }

  async function saveLevel(next: ProjectNotificationChoice) {
    if (!projectId) return;
    setSaveError(null);
    try {
      await patchPreferences.mutateAsync({
        perProject: { [projectId]: next === 'station' ? null : next },
      });
    } catch (error) {
      setSaveError(userFacingErrorMessage(error));
    }
  }

  return (
    <PageSection
      id="section-overview"
      className="project-settings__section page-section--choice-rows"
      title="Overview and notifications"
      description="How this Project files finished work and when it interrupts you."
    >
      <PageRow
        className="page-row--choice"
        label={
          <label htmlFor="project-overview-auto-resolve">
            Resolve idle Tasks
          </label>
        }
        description={
          <span id="project-overview-auto-resolve-hint">{`Moves an Idle Task to Resolved after this long without activity. Default: ${TASK_OVERVIEW_AUTO_RESOLVE_DEFAULT_DAYS} days.`}</span>
        }
        control={
          <Select
            id="project-overview-auto-resolve"
            aria-describedby="project-overview-auto-resolve-hint"
            value={days}
            disabled={updateProject.isPending}
            onChange={(event) => void saveDays(Number(event.target.value))}
          >
            {dayChoices.map((choice) => (
              <option key={choice} value={choice}>
                {daysLabel(choice)}
              </option>
            ))}
          </Select>
        }
      />
      {preferences.isError ? (
        <ErrorState
          variant="compact"
          title="Could not load notification settings"
          description={userFacingErrorMessage(preferences.error)}
          action={
            <Button onClick={() => void preferences.refetch()}>Retry</Button>
          }
        />
      ) : (
        <PageRow
          className="page-row--choice"
          label={<label htmlFor="project-notification-level">Notify me</label>}
          description={
            <span id="project-notification-level-hint">{`${NOTIFICATION_DESCRIPTIONS[level]} Nothing is sent to a device while it shows this Project.`}</span>
          }
          control={
            <Select
              id="project-notification-level"
              aria-describedby="project-notification-level-hint"
              value={level}
              disabled={
                !projectId || !preferences.data || patchPreferences.isPending
              }
              onChange={(event) =>
                void saveLevel(event.target.value as ProjectNotificationChoice)
              }
            >
              {NOTIFICATION_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </Select>
          }
        />
      )}
      {saveError && (
        <ErrorState
          variant="compact"
          title="Could not save this setting"
          description={saveError}
        />
      )}
    </PageSection>
  );
}
