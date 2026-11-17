import type { ProjectPullRequestFeedbackDefaults } from '@kontourai/station-contracts/pull-request-feedback';
import {
  getProjectPullRequestFeedbackDefaults,
  writeProjectPullRequestFeedbackDefaults,
} from '@kontourai/station-sdk/pull-request-feedback';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { PageRow } from '../../components/PageRow';
import { PageSection } from '../../components/PageSection';
import { ErrorState, Skeleton } from '../../components/state';
import { Toggle } from '../../components/Toggle';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { userFacingErrorMessage } from '../../utils/errorText';
import './AgentFeedbackDefaultsSection.css';

type Switches = Pick<
  ProjectPullRequestFeedbackDefaults['settings'],
  'fixFailingChecks' | 'addressReviewComments'
>;

const SWITCHES: Array<{
  key: keyof Switches;
  label: string;
  description: string;
}> = [
  {
    key: 'fixFailingChecks',
    label: 'Fix failing checks automatically',
    description:
      "Sends failing checks and merge conflicts to the Task's agent.",
  },
  {
    key: 'addressReviewComments',
    label: 'Address review comments automatically',
    description:
      "Sends unresolved review threads and change requests to the Task's agent.",
  },
];

/** "3 pull requests still get feedback. Turn them off from each chat." */
function stillOnLine(count: number): string {
  return count === 1
    ? '1 pull request still gets feedback. Turn it off from its chat.'
    : `${count} pull requests still get feedback. Turn them off from each chat.`;
}

/**
 * Project settings' Agent feedback: the switches Station turns on for a pull
 * request one of this Project's Tasks opens from its own branch. Each switch
 * saves at once, apart from the page's Save.
 */
export function AgentFeedbackDefaultsSection({ slug }: { slug: string }) {
  const scope = useHostRequestAuthorityScope();
  const queryClient = useQueryClient();
  const queryKey = [
    'pull-request-feedback-defaults',
    scope?.apiBase,
    scope?.authorityKey,
    slug,
  ];
  const defaults = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      getProjectPullRequestFeedbackDefaults(scope!.apiBase, slug, {
        signal,
        requestScope: scope!,
      }),
    enabled: !!scope?.isCurrent() && !!slug,
    retry: false,
  });
  const [pending, setPending] = useState(false);
  // Display text, already passed through userFacingErrorMessage.
  const [errorText, setErrorText] = useState<string | null>(null);

  const write = async (switches: Switches) => {
    if (!scope?.isCurrent() || pending) return;
    setPending(true);
    setErrorText(null);
    try {
      const saved = await writeProjectPullRequestFeedbackDefaults(
        scope.apiBase,
        slug,
        switches,
        { requestScope: scope },
      );
      if (scope.isCurrent()) queryClient.setQueryData(queryKey, saved);
    } catch (caught) {
      if (scope.isCurrent())
        setErrorText(
          caught instanceof Error
            ? userFacingErrorMessage(caught)
            : 'Station could not save these defaults.',
        );
    } finally {
      if (scope.isCurrent()) setPending(false);
    }
  };

  const data = defaults.data;
  const on =
    !!data &&
    (data.settings.fixFailingChecks || data.settings.addressReviewComments);

  return (
    <PageSection
      id="section-agent-feedback"
      className="project-settings__section"
      title="Agent feedback"
      description="For pull requests from this Project's Tasks. Pull requests already set up keep theirs."
    >
      {defaults.isPending ? (
        <Skeleton variant="block" />
      ) : defaults.isError || !data ? (
        <ErrorState
          variant="compact"
          title="Could not load agent feedback defaults"
          description={
            defaults.error ? userFacingErrorMessage(defaults.error) : undefined
          }
          action={
            <Button onClick={() => void defaults.refetch()}>Retry</Button>
          }
        />
      ) : (
        <>
          {SWITCHES.map((entry) => (
            <PageRow
              key={entry.key}
              title={entry.label}
              description={entry.description}
              control={
                <Toggle
                  checked={data.settings[entry.key]}
                  label={entry.label}
                  disabled={pending || !data.canChange}
                  onChange={(checked) =>
                    void write({
                      fixFailingChecks: data.settings.fixFailingChecks,
                      addressReviewComments:
                        data.settings.addressReviewComments,
                      [entry.key]: checked,
                    })
                  }
                />
              }
            />
          ))}
          {on && (
            <p className="agent-feedback-defaults__note">
              A pull request opened from a Task's own branch gets feedback
              without asking.
            </p>
          )}
          {!on && data.stillOn > 0 && (
            <p className="agent-feedback-defaults__note">
              {stillOnLine(data.stillOn)}
            </p>
          )}
          {!data.canChange && (
            <p className="agent-feedback-defaults__note">
              Only this Station's owner can change these.
            </p>
          )}
          {errorText && (
            <p className="agent-feedback-defaults__error" role="alert">
              {errorText}
            </p>
          )}
        </>
      )}
    </PageSection>
  );
}
