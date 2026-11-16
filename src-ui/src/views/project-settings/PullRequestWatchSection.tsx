import { PULL_REQUEST_FEEDBACK_PREVIEW_ID } from '@kontourai/station-contracts/pull-request-feedback';
import {
  DEFAULT_PULL_REQUEST_FIX_ATTEMPTS,
  MAX_PULL_REQUEST_FIX_ATTEMPTS,
  type ProjectPullRequestWatchSettings,
} from '@kontourai/station-contracts/pull-request-watch';
import { setProjectPullRequestWatch } from '@kontourai/station-sdk/pull-request-watch';
import { useMutation } from '@tanstack/react-query';
import { PageRow } from '../../components/PageRow';
import { PageSection } from '../../components/PageSection';
import { ErrorState } from '../../components/state';
import { Toggle } from '../../components/Toggle';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { userFacingErrorMessage } from '../../utils/errorText';

const ATTEMPT_CHOICES = Array.from(
  { length: MAX_PULL_REQUEST_FIX_ATTEMPTS },
  (_, index) => index + 1,
);

/**
 * Whether this Project's Tasks watch the pull requests they keep (#5066).
 * It saves as soon as it changes, on its own route, apart from the page's
 * form. A Task's own choice overrides it.
 */
export function PullRequestWatchSection({
  slug,
  settings,
  onSaved,
}: {
  slug: string;
  settings: ProjectPullRequestWatchSettings | undefined;
  onSaved(): void;
}) {
  const scope = useHostRequestAuthorityScope();
  const preview = useSurfaceVisibilityFlags().has(
    PULL_REQUEST_FEEDBACK_PREVIEW_ID,
  );
  const current: ProjectPullRequestWatchSettings = settings ?? {
    enabled: false,
    maxFixAttempts: DEFAULT_PULL_REQUEST_FIX_ATTEMPTS,
  };
  const save = useMutation({
    mutationFn: (next: ProjectPullRequestWatchSettings) => {
      if (!scope?.isCurrent()) throw new Error('Project connection changed.');
      return setProjectPullRequestWatch(scope.apiBase, slug, next, {
        requestScope: scope,
      });
    },
    onSuccess: () => {
      if (scope?.isCurrent()) onSaved();
    },
  });
  const disabled = save.isPending || !preview;
  return (
    <PageSection
      id="section-pull-requests"
      className="project-settings__section"
      title="Pull requests"
      description="Tasks watch the pull requests they open and report when each is ready. Merging stays with you."
    >
      {!preview && (
        <p>
          Turn on Pull request agent feedback in Settings → Feature previews to
          use this.
        </p>
      )}
      <PageRow
        label="Watch Task pull requests"
        description="Wake the Task's agent when CI fails or a reviewer writes. Changes reach Tasks without their own choice."
        control={
          <Toggle
            id="project-pull-request-watch"
            label="Watch Task pull requests"
            checked={current.enabled}
            disabled={disabled}
            onChange={(enabled) => save.mutate({ ...current, enabled })}
          />
        }
      />
      <PageRow
        label="Fix attempts"
        description="After this many, the Task waits for you with the failing check named."
        control={
          <select
            id="project-pull-request-fix-attempts"
            className="editor-input"
            aria-label="Fix attempts"
            value={current.maxFixAttempts}
            disabled={disabled}
            onChange={(event) =>
              save.mutate({
                ...current,
                maxFixAttempts: Number(event.target.value),
              })
            }
          >
            {ATTEMPT_CHOICES.map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        }
      />
      {save.error && (
        <ErrorState
          variant="compact"
          title="Could not save the pull request setting"
          description={userFacingErrorMessage(save.error)}
        />
      )}
    </PageSection>
  );
}
