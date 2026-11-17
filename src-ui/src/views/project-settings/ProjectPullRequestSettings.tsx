import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { usePullRequestContextQuery } from '@kontourai/station-sdk';
import { Button } from '../../components/Button';
import { PageSection } from '../../components/PageSection';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { AgentFeedbackDefaultsSection } from './AgentFeedbackDefaultsSection';
import { PullRequestWatchSection } from './PullRequestWatchSection';

export function ProjectPullRequestSettings({
  project,
  slug,
  active,
  feedbackAvailable,
  onSaved,
  onSources,
}: {
  project?: ProjectConfig;
  slug: string;
  active: boolean;
  feedbackAvailable: boolean;
  onSaved(): void;
  onSources(): void;
}) {
  const repository = usePullRequestContextQuery(
    { project: slug },
    { enabled: active && !!project, retry: false, keepPreviousData: false },
  );
  const context = repository.isError ? undefined : repository.data;
  if (context?.available && context.provider === 'github' && project)
    return (
      <PullRequestWatchSection
        slug={slug}
        settings={project.pullRequestWatch}
        onSaved={onSaved}
      >
        {feedbackAvailable && <AgentFeedbackDefaultsSection slug={slug} />}
      </PullRequestWatchSection>
    );
  return (
    <PageSection
      id="section-pull-requests"
      className="project-settings__section"
      title="Pull requests"
    >
      {repository.isPending || !project ? (
        <SkeletonBlock />
      ) : repository.isError ? (
        <ErrorState
          variant="compact"
          title="Could not check the Project's repository"
          action={
            <Button onClick={() => void repository.refetch()}>Retry</Button>
          }
        />
      ) : (
        <Empty
          variant="compact"
          label="Add a GitHub repository to use pull requests"
          description={
            context?.available === false
              ? context.reason
              : 'Choose a repository in Sources. Your saved settings are kept.'
          }
          action={<Button onClick={onSources}>Open Sources</Button>}
        />
      )}
    </PageSection>
  );
}
