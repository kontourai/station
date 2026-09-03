import {
  type LayoutComponentProps,
  useApiBase,
  useNavigation,
} from '@kontourai/station-sdk';
import { useCallback, useMemo, useState } from 'react';
import { Feedback, LaunchCard, ReviewCard, RunsCard } from './components';
import {
  useCloseReview,
  useLaunchRun,
  useOpenedRunCleanup,
  useOpenReview,
  useReviewedOutput,
  useRuns,
} from './hooks';
import './fieldwork-review.css';

function EmptyProject() {
  return (
    <main
      className="fieldwork-review fieldwork-review--empty"
      data-testid="fieldwork-no-project"
    >
      <h2>Fieldwork Review</h2>
      <p>
        Open this pane inside a Project to keep task files, sources, and run
        artifacts project-scoped.
      </p>
    </main>
  );
}

function ProjectHeader({ projectSlug }: { projectSlug: string }) {
  return (
    <section
      className="fieldwork-review__intro"
      aria-labelledby="fieldwork-title"
    >
      <div>
        <p className="fieldwork-review__eyebrow">Project application</p>
        <h2 id="fieldwork-title">Fieldwork Review</h2>
        <p>
          Launch project-relative files, then review in Fieldwork&apos;s
          protected surface.
        </p>
      </div>
      <span className="fieldwork-review__project">
        <span className="fieldwork-review__sr-only">Selected project: </span>
        {projectSlug}
      </span>
    </section>
  );
}

function useReviewState() {
  const [taskPath, setTaskPath] = useState('task.json');
  const [sourcePath, setSourcePath] = useState('source.txt');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [openedRunId, setOpenedRunId] = useState<string | null>(null);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectRun = useCallback((runId: string | null) => {
    setSelectedRunId(runId);
    setOpenedRunId(null);
    setReviewUrl(null);
  }, []);
  return {
    notice,
    openedRunId,
    reviewUrl,
    selectRun,
    selectedRunId,
    setNotice,
    setOpenedRunId,
    setReviewUrl,
    setSelectedRunId,
    setSourcePath,
    setTaskPath,
    sourcePath,
    taskPath,
  };
}

function useProjectReviewModel(apiBase: string, projectSlug: string) {
  const context = useMemo(
    () => ({ apiBase, projectSlug }),
    [apiBase, projectSlug],
  );
  const state = useReviewState();
  const { selectRun, setNotice } = state;
  const runs = useRuns(context, state.selectedRunId, selectRun);
  const launch = useLaunchRun(
    context,
    state.taskPath,
    state.sourcePath,
    (run) => {
      selectRun(run.id);
      setNotice(
        'Fieldwork run created. Open the protected review surface when ready.',
      );
    },
  );
  const open = useOpenReview(context, (runId, url) => {
    state.setSelectedRunId(runId);
    state.setOpenedRunId(runId);
    state.setReviewUrl(url);
    setNotice('Review surface opened in the isolated Fieldwork frame.');
  });
  const close = useCloseReview(context, () => {
    state.setOpenedRunId(null);
    state.setReviewUrl(null);
    setNotice(
      'Review surface closed. The project-local run remains available.',
    );
  });
  const output = useReviewedOutput(
    context,
    state.selectedRunId,
    Boolean(state.reviewUrl),
  );
  useOpenedRunCleanup(context, state.openedRunId);
  const selectedRun =
    runs.data?.find((run) => run.id === state.selectedRunId) ?? null;
  const mutationError = launch.error || open.error || close.error;
  return {
    ...state,
    close,
    launch,
    mutationError,
    open,
    output,
    runs,
    selectedRun,
  };
}

type ReviewModel = ReturnType<typeof useProjectReviewModel>;

function ReviewWorkspace({ model }: { model: ReviewModel }) {
  return (
    <section
      className="fieldwork-review__workspace"
      aria-label="Fieldwork run workspace"
    >
      <RunsCard
        loading={model.runs.isLoading}
        refresh={() => void model.runs.refetch()}
        runs={model.runs.data}
        selectedRunId={model.selectedRunId}
        selectRun={model.selectRun}
      />
      <ReviewCard
        available={Boolean(model.output.data?.available)}
        close={() =>
          model.selectedRun && model.close.mutate(model.selectedRun.id)
        }
        closePending={model.close.isPending}
        open={() =>
          model.selectedRun && model.open.mutate(model.selectedRun.id)
        }
        openPending={model.open.isPending}
        reviewUrl={model.reviewUrl}
        selectedRun={model.selectedRun}
      />
    </section>
  );
}

function ProjectReview({
  apiBase,
  projectSlug,
}: {
  apiBase: string;
  projectSlug: string;
}) {
  const model = useProjectReviewModel(apiBase, projectSlug);
  return (
    <main className="fieldwork-review" data-testid="fieldwork-review">
      <ProjectHeader projectSlug={projectSlug} />
      <LaunchCard
        pending={model.launch.isPending}
        sourcePath={model.sourcePath}
        taskPath={model.taskPath}
        setSourcePath={model.setSourcePath}
        setTaskPath={model.setTaskPath}
        submit={(event) => {
          event.preventDefault();
          model.setNotice(null);
          model.launch.mutate();
        }}
      />
      <Feedback
        mutationError={model.mutationError}
        notice={model.notice}
        runsError={model.runs.error}
      />
      <ReviewWorkspace model={model} />
    </main>
  );
}

export function FieldworkReview(_props: LayoutComponentProps) {
  const { apiBase } = useApiBase();
  const navigation = useNavigation() as { selectedProject?: string | null };
  const projectSlug = navigation.selectedProject ?? null;
  return projectSlug ? (
    <ProjectReview
      key={projectSlug}
      apiBase={apiBase}
      projectSlug={projectSlug}
    />
  ) : (
    <EmptyProject />
  );
}

export const components = {
  'fieldwork-review-main': FieldworkReview,
};

export default FieldworkReview;
