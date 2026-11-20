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
    { project: slug, workingDirectory: project?.workingDirectory },
    {
      enabled: active && !!project,
      retry: false,
      keepPreviousData: false,
      staleTime: 0,
      refetchOnMount: 'always',
    },
  );
  if (!active) return null;

  const context =
    repository.isError || repository.isFetching ? undefined : repository.data;
  const controlsAvailable =
    context?.available && context.automation?.feedback === true && project;
  return (
    <PageSection
      id="section-pull-requests"
      className="project-settings__section"
      title="Pull requests"
      description={
        controlsAvailable
          ? 'Tasks push fixes and report when ready. You decide when to merge.'
          : undefined
      }
    >
      {controlsAvailable ? (
        <PullRequestWatchSection
          slug={slug}
          settings={project.pullRequestWatch}
          onSaved={onSaved}
        >
          {feedbackAvailable &&
            context?.available &&
            context.automation?.taskBranchDiscovery && (
              <AgentFeedbackDefaultsSection slug={slug} />
            )}
        </PullRequestWatchSection>
      ) : repository.isPending || repository.isFetching || !project ? (
        <SkeletonBlock />
      ) : repository.isError ? (
        <ErrorState
          variant="compact"
          title="Could not check the Project's repository"
          action={
            <Button onClick={() => void repository.refetch()}>Retry</Button>
          }
        />
      ) : context?.available ? (
        <Empty
          variant="compact"
          label={`Automatic feedback is not available for ${context.providerLabel ?? 'this repository'}`}
          description={
            context.automation
              ? 'You can use this repository for code work and open its pull requests. Saved settings are kept.'
              : 'Update this Station to check its automatic feedback support. Saved settings are kept.'
          }
        />
      ) : context?.cause === 'unsupported-forge' ? (
        <Empty
          variant="compact"
          label="Pull request integration is not available for this remote"
          description="Your repository is still available for code work. Saved settings are kept."
          action={<Button onClick={onSources}>Open Sources</Button>}
        />
      ) : (
        <Empty
          variant="compact"
          label="Add a repository to use pull requests"
          description="Choose a repository in Sources. Your saved settings are kept."
          action={<Button onClick={onSources}>Open Sources</Button>}
        />
      )}
    </PageSection>
  );
}
