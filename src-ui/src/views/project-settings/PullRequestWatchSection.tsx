import { PULL_REQUEST_FEEDBACK_PREVIEW_ID } from '@kontourai/station-contracts/pull-request-feedback';
import {
  DEFAULT_PULL_REQUEST_FIX_ATTEMPTS,
  MAX_PULL_REQUEST_FIX_ATTEMPTS,
  type ProjectPullRequestWatchSettings,
} from '@kontourai/station-contracts/pull-request-watch';
import { useSetProjectPullRequestWatchMutation } from '@kontourai/station-sdk';
import type { ReactNode } from 'react';
import { PageRow } from '../../components/PageRow';
import { ErrorState } from '../../components/state';
import { Toggle } from '../../components/Toggle';
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
  children,
}: {
  slug: string;
  settings: ProjectPullRequestWatchSettings | undefined;
  onSaved(): void;
  children?: ReactNode;
}) {
  const preview = useSurfaceVisibilityFlags().has(
    PULL_REQUEST_FEEDBACK_PREVIEW_ID,
  );
  const current: ProjectPullRequestWatchSettings = settings ?? {
    enabled: false,
    maxFixAttempts: DEFAULT_PULL_REQUEST_FIX_ATTEMPTS,
  };
  const save = useSetProjectPullRequestWatchMutation(slug);
  const disabled = save.isPending || !preview;
  return (
    <>
      {!preview && (
        <p>
          Turn on Pull request agent feedback in Settings → Feature previews to
          use this.
        </p>
      )}
      <PageRow
        label="Watch Task pull requests"
        description="Send failing checks and review comments to the Task's agent. Each Task can override this."
        control={
          <Toggle
            id="project-pull-request-watch"
            label="Watch Task pull requests"
            checked={current.enabled}
            disabled={disabled}
            onChange={(enabled) =>
              save.mutate({ ...current, enabled }, { onSuccess: onSaved })
            }
          />
        }
      />
      <PageRow
        label="Fix attempts"
        description="Pause for you after this many attempts to fix failing checks."
        control={
          <select
            id="project-pull-request-fix-attempts"
            className="editor-input"
            aria-label="Fix attempts"
            value={current.maxFixAttempts}
            disabled={disabled}
            onChange={(event) =>
              save.mutate(
                { ...current, maxFixAttempts: Number(event.target.value) },
                { onSuccess: onSaved },
              )
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
      {children}
    </>
  );
}
