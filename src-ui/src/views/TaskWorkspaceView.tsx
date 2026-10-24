import { resolveWorkspaceBasisMcpPaneOccurrence } from '@kontourai/station-basis-pane/workspace-basis-mcp-pane';
import {
  createWholeTaskBasisPaneInstance,
  WORKSPACE_BASIS_PANE_DESCRIPTOR,
} from '@kontourai/station-basis-pane/workspace-basis-pane';
import { taskStatusLabel } from '@kontourai/station-contracts/task-graph';
import {
  gitHubIssueUrlFromWorkItemRef,
  WORK_ITEM_OBSERVATION_LIMITS,
} from '@kontourai/station-contracts/work-item-provider';
import { createWorkspacePaneHostBaselineDocument } from '@kontourai/station-contracts/workspace-pane-host';
import {
  bindStarterWork,
  type RelationGraphLink,
  type TaskGraph,
  type TaskRecord,
  type TaskWorkspaceBinding,
  telemetry,
  usePluginsQuery,
  useQueryClient,
  useTaskGraphQuery,
  useTaskWorkItemQuery,
} from '@kontourai/station-sdk';
import { useProjectTaskRoomDiscoveryQuery } from '@kontourai/station-sdk/project-task-rooms';
import { taskBasisQueries } from '@kontourai/station-sdk/task-basis';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '../components/Button';
import { DiffPanel } from '../components/coding-layout/DiffPanel';
import { FileContentViewer } from '../components/coding-layout/FileContentViewer';
import { usePageHeader } from '../components/page-frame';
import {
  Empty,
  ErrorState,
  SkeletonBlock,
  SkeletonList,
} from '../components/state';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../contexts/ApiBaseContext';
import {
  useNavigation,
  useNavigationActions,
} from '../contexts/NavigationContext';
import { useScopedProjectsQuery } from '../contexts/ProjectsContext';
import { clientOriginDetail } from '../utils/clientOrigin';
import { errorText } from '../utils/errorText';
import { ProjectTaskRoomProvider } from '../workspace-panes/ProjectTaskRoomContext';
import {
  ProjectTaskRoomConversation,
  TaskRoomHistoryDetails,
} from '../workspace-panes/ProjectTaskRoomConversation';
import { TaskRoomEditorPane } from '../workspace-panes/TaskRoomEditorPane';
import { WorkspacePaneHost } from '../workspace-panes/WorkspacePaneHost';
import {
  type WorkspacePaneHostOpenAction,
  WorkspacePaneHostOpenContext,
} from '../workspace-panes/WorkspacePaneHostOpenContext';
import { WorkspacePaneHostRuntime } from '../workspace-panes/workspacePaneHostRuntime';
import {
  observeTaskExperienceAvailability,
  type ResolvedTaskExperience,
  resolveTaskExperiences,
  type TaskExperienceId,
} from './task-experiences';
import { TaskLearningPanel } from './task-workspace/TaskLearningPanel';
import { TaskMemoryPanel } from './task-workspace/TaskMemoryPanel';
import {
  type TaskOutputPromotion,
  TaskOutputsSection,
} from './task-workspace/TaskOutputsSection';
import { TaskRelationships } from './task-workspace/TaskRelationships';
import {
  TaskRoomHeader,
  TaskRoomRail,
  TaskRoomResults,
} from './task-workspace/TaskRoomPage';
import { TaskTurnReferenceView } from './task-workspace/TaskTurnReferenceView';
import { TaskUserInputReferences } from './task-workspace/TaskUserInputReferences';
import './page-layout.css';
import './TaskWorkspaceView.css';

const TASK_VIEWS = {
  overview: 'Overview',
  conversation: 'Conversation',
  'work-chats': 'Work chats',
  plan: 'Plan',
  details: 'Details',
} as const;

type ReferenceKind = 'artifact' | 'receipt' | 'file' | 'external';

const LazyTaskBasisWorkspacePane = lazy(() =>
  import('../workspace-panes/BasisWorkspacePane').then(
    ({ BasisWorkspacePane }) => ({ default: BasisWorkspacePane }),
  ),
);
const LazyTaskBasisMcpWorkspacePane = lazy(() =>
  import('../workspace-panes/BasisMcpWorkspacePane').then(
    ({ BasisMcpWorkspacePane }) => ({ default: BasisMcpWorkspacePane }),
  ),
);

interface ReferenceItem {
  id: string;
  kind: ReferenceKind;
  link: RelationGraphLink;
}

interface ReferenceSelection {
  taskId: string;
  kind: 'reference' | 'diff';
  id?: string;
}

type OutputOperationIds = {
  get: (relativePath: string, title: string) => string;
  clear: (relativePath: string, title: string) => void;
};

const OUTPUT_OPERATION_PREFIX = 'station.task-output-operation.v1:';
function outputOperationKey(
  taskId: string,
  relativePath: string,
  title: string,
) {
  return `${OUTPUT_OPERATION_PREFIX}${encodeURIComponent(JSON.stringify({ taskId, relativePath, title }))}`;
}

function outputTitle(relativePath: string): string {
  return relativePath.split('/').at(-1) || relativePath;
}

function unavailable(value: string | undefined): string {
  return value?.trim() || 'Unavailable';
}

function metadataPath(link: RelationGraphLink): string | undefined {
  const path = link.metadata?.path;
  return typeof path === 'string' && path.trim() ? path.trim() : undefined;
}

function isOpaquePath(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value);
}

/**
 * Converts an explicit task reference into a workspace-relative path without
 * allowing a URI, traversal, or a path outside the exact bound workspace.
 */
export function relativeWorkspacePath(
  candidate: string | undefined,
  workingDirectory: string | undefined,
): string | null {
  if (!candidate || !workingDirectory || isOpaquePath(candidate)) return null;

  const normalize = (value: string) =>
    value.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  const base = normalize(workingDirectory);
  let value = normalize(candidate);
  if (!base || !value) return null;

  const absolute = value.startsWith('/') || /^[a-z]:\//i.test(value);
  if (absolute) {
    const compareBase = /^[a-z]:\//i.test(base) ? base.toLowerCase() : base;
    const compareValue = /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
    if (compareValue === compareBase) return null;
    if (!compareValue.startsWith(`${compareBase}/`)) return null;
    value = value.slice(base.length + 1);
  }

  value = value.replace(/^\.\//, '');
  const parts = value.split('/');
  if (
    !value ||
    parts.some((part) => !part || part === '.' || part === '..') ||
    value.startsWith('../')
  ) {
    return null;
  }
  return value;
}

function workspaceDirectory(binding: TaskWorkspaceBinding | undefined) {
  if (binding?.availability !== 'available') return undefined;
  return (
    binding?.worktreePath?.trim() ||
    binding?.repoRoot?.trim() ||
    binding?.workingDirectory?.trim()
  );
}

function referencePath(item: ReferenceItem, workingDirectory?: string) {
  return (
    relativeWorkspacePath(metadataPath(item.link), workingDirectory) ??
    relativeWorkspacePath(item.link.targetId, workingDirectory)
  );
}

function referenceLabel(item: ReferenceItem): string {
  return metadataPath(item.link) ?? item.link.targetId;
}

function isTaskNotFound(error: unknown): boolean {
  return error instanceof Error && /\b404\b|not found/i.test(error.message);
}

export function TaskWorkspaceView({ taskId }: { taskId: string }) {
  const { apiBase } = useApiBase();
  const requestScope = useHostRequestAuthorityScope();
  // Navigation survives authority verification remounts; protected pane state does not.
  const requestedView = useNavigation(() =>
    new URLSearchParams(window.location.search).get('taskView'),
  );
  const { updateParams } = useNavigationActions();
  const { data: graph, isLoading, error, refetch } = useTaskGraphQuery(taskId);
  const setTab = useCallback(
    (tab: string) => {
      const view = Object.entries(TASK_VIEWS).find(
        ([, name]) => name === tab,
      )?.[0];
      if (view) updateParams({ taskView: view });
    },
    [updateParams],
  );
  const projectsQuery = useScopedProjectsQuery() as {
    data?: Array<{ id: string; slug: string }>;
    isLoading: boolean;
    error?: unknown;
    refetch: () => void;
  };
  const starterLinkUnverified =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('starterLink') ===
      'not-verified' &&
    new URLSearchParams(window.location.search).get('starter') === 'start-task';
  if (isLoading || projectsQuery.isLoading) return <TaskLoadingState />;
  if (error || !graph) {
    return (
      <TaskLoadError
        taskId={taskId}
        error={error}
        onRetry={() => void refetch()}
      />
    );
  }
  if (projectsQuery.error || !Array.isArray(projectsQuery.data)) {
    return (
      <TaskProjectCheckError
        task={graph.task}
        error={projectsQuery.error}
        onRetry={() => void projectsQuery.refetch()}
      />
    );
  }
  const tab =
    Object.entries(TASK_VIEWS).find(([view]) => view === requestedView)?.[1] ??
    'Overview';
  const taskProject = projectsQuery.data.find(
    (project) =>
      project.id === graph.task.projectId ||
      project.slug === graph.task.projectId,
  );
  if (!taskProject) return <DeletedProjectTaskState task={graph.task} />;
  return (
    <>
      {starterLinkUnverified && <StarterLinkRetry task={graph.task} />}
      <ProjectTaskRoomProvider
        key={JSON.stringify([
          apiBase,
          requestScope?.authorityKey,
          taskId,
          graph.task.createdAt,
        ])}
        taskId={taskId}
      >
        <TaskWorkspaceContent
          taskId={taskId}
          graph={graph}
          projectSlug={taskProject.slug}
          projectId={taskProject.id}
          tab={tab}
          setTab={setTab}
        />
      </ProjectTaskRoomProvider>
    </>
  );
}

function StarterLinkRetry({ task }: { task: TaskRecord }) {
  const taskId = task.id;
  const queryClient = useQueryClient();
  const { updateParams } = useNavigation();
  const [retrying, setRetrying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [failed, setFailed] = useState(false);
  if (verified) return null;
  async function retry() {
    setRetrying(true);
    setFailed(false);
    try {
      const outcome = await bindStarterWork({
        starterId: 'start-task',
        operationId: `task-create:${taskId}`,
        targetRef: { kind: 'task', id: taskId, projectId: task.projectId },
      });
      if (
        outcome.outcome !== 'bound' ||
        outcome.binding.targetRef.kind !== 'task' ||
        outcome.binding.targetRef.id !== taskId ||
        outcome.binding.targetRef.projectId !== task.projectId
      )
        throw new Error('Starter Work binding did not confirm the exact Task.');
      queryClient.setQueryData(['starter-work', 'start-task'], {
        state: 'bound',
        binding: outcome.binding,
      });
      await queryClient.invalidateQueries({
        queryKey: ['starter-work', 'start-task'],
      });
      setVerified(true);
      updateParams({ starter: null, starterLink: null });
    } catch {
      setFailed(true);
    } finally {
      setRetrying(false);
    }
  }
  return (
    <section
      className="task-workspace__section"
      role="status"
      aria-label="Starter work link"
    >
      {/* archive#3965: led with `NOT_VERIFIED` and buried the fact the reader
          cares about — the task exists. Outcome first, then the gap. */}
      <p>
        Your task was created. We couldn’t confirm it is linked to your
        first-task step, so that step may still look unfinished.
      </p>
      <Button size="sm" disabled={retrying} onClick={() => void retry()}>
        {retrying ? 'Linking…' : 'Link it now'}
      </Button>
      {failed && (
        <p>
          Still couldn’t link it. Your task is safe — try again later, and
          Station won’t create a second one.
        </p>
      )}
    </section>
  );
}

function taskReferences(graph: TaskGraph): ReferenceItem[] {
  return graph.links.flatMap<ReferenceItem>((link) => {
    if (
      link.targetType === 'artifact' &&
      link.relationType === 'references_artifact'
    )
      return [{ id: link.id, kind: 'artifact', link }];
    if (
      link.targetType === 'receipt' &&
      link.relationType === 'references_receipt'
    )
      return [{ id: link.id, kind: 'receipt', link }];
    if (link.targetType === 'file' && link.relationType === 'touches_file')
      return [{ id: link.id, kind: 'file', link }];
    if (
      link.targetType === 'external' &&
      link.relationType === 'references_external'
    )
      return [{ id: link.id, kind: 'external', link }];
    return [];
  });
}

function useReferenceSelection(taskId: string, references: ReferenceItem[]) {
  const [selection, setSelection] = useState<ReferenceSelection | null>(null);
  useEffect(() => {
    if (selection?.taskId !== taskId) setSelection(null);
  }, [selection?.taskId, taskId]);
  useEffect(() => {
    if (
      selection?.kind === 'reference' &&
      !references.some((reference) => reference.id === selection.id)
    )
      setSelection(null);
  }, [references, selection]);
  return [selection, setSelection] as const;
}

function useTaskExperienceSelection(taskId: string) {
  const [selection, setSelection] = useState<{
    taskId: string;
    experience: TaskExperienceId;
  }>({ taskId, experience: 'direct' });
  const experience =
    selection.taskId === taskId ? selection.experience : 'direct';

  function selectExperience(next: TaskExperienceId) {
    telemetry.track('ui.task_workspace.experience_selected', {
      experience: next,
    });
    setSelection({ taskId, experience: next });
  }

  return [experience, selectExperience] as const;
}

function TaskWorkspaceContent({
  taskId,
  graph,
  projectSlug,
  projectId,
  tab,
  setTab,
}: {
  taskId: string;
  graph: TaskGraph;
  projectSlug: string;
  projectId: string;
  tab: string;
  setTab: (tab: string) => void;
}) {
  const references = useMemo(() => taskReferences(graph), [graph]);
  // AW-4: the list is derived from what this Station has actually
  // installed, not from a hardcoded filter. An optional experience appears
  // only when an installed, ENABLED plugin declares it provides that
  // contract; everything else stays behind the one Add capabilities
  // affordance.
  const { data: plugins = [] } = usePluginsQuery() as {
    data: Array<{ enabled?: boolean; manifest?: { capabilities?: string[] } }>;
  };
  const experiences = useMemo(
    () => resolveTaskExperiences(observeTaskExperienceAvailability(plugins)),
    [plugins],
  );
  const [selection, setSelection] = useReferenceSelection(taskId, references);
  const [basisVisible, setBasisVisible] = useState(false);
  const [basisHostOpen, setBasisHostOpen] =
    useState<WorkspacePaneHostOpenAction | null>(null);
  const captureBasisHostOpen = useCallback(
    (action: WorkspacePaneHostOpenAction | null) =>
      setBasisHostOpen(
        action
          ? {
              ...action,
              open: (...args) => {
                const outcome = action.open(...args);
                if (outcome.ok) {
                  setBasisVisible(true);
                  setTab('Details');
                }
                return outcome;
              },
              focusExisting: (id) => {
                const focused = action.focusExisting?.(id) ?? false;
                if (focused) {
                  setBasisVisible(true);
                  setTab('Details');
                }
                return focused;
              },
            }
          : null,
      ),
    [setTab],
  );
  const [outputPromotion, setOutputPromotion] =
    useState<TaskOutputPromotion | null>(null);
  const outputOperationIds = useRef(new Map<string, string>());
  const operations = useMemo<OutputOperationIds>(
    () => ({
      get(relativePath, title) {
        const intent = JSON.stringify({ taskId, relativePath, title });
        const current = outputOperationIds.current.get(intent);
        if (current) return current;
        const key = outputOperationKey(taskId, relativePath, title);
        const persisted = window.sessionStorage.getItem(key);
        if (persisted && /^[A-Za-z0-9_-]{1,160}$/.test(persisted)) {
          outputOperationIds.current.set(intent, persisted);
          return persisted;
        }
        if (persisted) window.sessionStorage.removeItem(key);
        const operationId = randomCorrelationId();
        outputOperationIds.current.set(intent, operationId);
        window.sessionStorage.setItem(key, operationId);
        return operationId;
      },
      clear(relativePath, title) {
        const intent = JSON.stringify({ taskId, relativePath, title });
        outputOperationIds.current.delete(intent);
        window.sessionStorage.removeItem(
          outputOperationKey(taskId, relativePath, title),
        );
      },
    }),
    [taskId],
  );
  const [activeExperienceId, setActiveExperienceId] =
    useTaskExperienceSelection(taskId);
  const activeExperience =
    experiences.find((experience) => experience.id === activeExperienceId) ??
    experiences[0];
  const directory = workspaceDirectory(graph.task.workspaceBinding);
  const direct = references.filter(
    (reference) => reference.kind !== 'external',
  );
  const integrations = references.filter(
    (reference) => reference.kind === 'external',
  );
  return (
    <div className="page page--full task-workspace">
      <TaskRoomHeader
        task={graph.task}
        projectSlug={projectSlug}
        projectId={projectId}
        onDetails={() => setTab('Details')}
      />
      <div
        className="task-room-tabs page__tabs"
        role="tablist"
        aria-label="Task views"
      >
        {Object.values(TASK_VIEWS).map((name) => (
          <Button
            key={name}
            role="tab"
            tabIndex={tab === name ? 0 : -1}
            aria-selected={tab === name}
            aria-controls={`task-panel-${name.replaceAll(' ', '-')}`}
            id={`task-tab-${name.replaceAll(' ', '-')}`}
            className="page__tab"
            onClick={() => setTab(name)}
            onKeyDown={(event) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
              )
                return;
              const tabs = Array.from(
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                ) ?? [],
              ).filter((button) => button.offsetParent !== null);
              const index = tabs.indexOf(event.currentTarget);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : (index +
                        (event.key === 'ArrowRight' ? 1 : -1) +
                        tabs.length) %
                      tabs.length;
              event.preventDefault();
              tabs[next]?.focus();
              tabs[next]?.click();
            }}
          >
            {name}
          </Button>
        ))}
      </div>
      <div
        className="task-room-main"
        hidden={tab !== 'Conversation'}
        role="tabpanel"
        id="task-panel-Conversation"
        aria-labelledby="task-tab-Conversation"
      >
        <ProjectTaskRoomConversation
          taskId={taskId}
          projectSlug={projectSlug}
          taskCreatedAt={graph.task.createdAt}
        />
      </div>
      <div
        className="task-room-panel"
        hidden={tab !== 'Plan'}
        role="tabpanel"
        id="task-panel-Plan"
        aria-labelledby="task-tab-Plan"
      >
        {/* #4003: what a Session dispatched for this Task is briefed with:
            the linked item, the Task document, and Task memory. */}
        {graph.task.workItemRef ? (
          <TaskWorkItemHeader
            taskId={graph.task.id}
            workItemRef={graph.task.workItemRef}
          />
        ) : null}
        <TaskRoomEditorPane taskId={taskId} startInPreview />
        <TaskMemoryPanel taskId={graph.task.id} />
        {graph.task.status === 'done' ? (
          <TaskLearningPanel taskId={graph.task.id} />
        ) : null}
      </div>
      <div
        className="task-room-panel task-overview"
        hidden={tab !== 'Overview'}
        role="tabpanel"
        id="task-panel-Overview"
        aria-labelledby="task-tab-Overview"
      >
        <TaskRoomRail task={graph.task} onBrief={() => setTab('Plan')} />
        <TaskRelationships task={graph.task} kind="children" />
        <div id="task-deliverables">
          <TaskRoomResults task={graph.task} />
        </div>
      </div>
      <div
        className="task-room-panel"
        hidden={tab !== 'Work chats'}
        role="tabpanel"
        id="task-panel-Work-chats"
        aria-labelledby="task-tab-Work-chats"
      >
        <TaskRelationships task={graph.task} kind="work-chats" />
      </div>
      <div
        className="task-workspace__body"
        hidden={tab !== 'Details'}
        role="tabpanel"
        id="task-panel-Details"
        aria-labelledby="task-tab-Details"
      >
        <details className="task-workspace__record-details">
          <summary>Task identity and workspace</summary>
          <TaskIdentitySection task={graph.task} />
          <WorkspaceBindingSection task={graph.task} />
        </details>
        <TaskRoomWorkspaceSection
          task={graph.task}
          onOpenActionChange={captureBasisHostOpen}
          visible={basisVisible}
        />
        {/* #3883: Kept answers open Basis panes into the host just above, in
            the same panel, so an already-visible strip and focused tab can be
            revealed without moving the page. */}
        <details className="task-workspace__record-details">
          <summary>Answer details</summary>
          <WorkspacePaneHostOpenContext.Provider value={basisHostOpen}>
            <TaskTurnReferenceView
              taskId={taskId}
              projectId={graph.task.projectId}
            />
          </WorkspacePaneHostOpenContext.Provider>
        </details>
        <TaskUserInputReferences taskId={taskId} />
        <TaskOutputsSection
          task={graph.task}
          promotion={outputPromotion}
          onPromotionSettled={(promotion, success) => {
            if (success) {
              operations.clear(promotion.relativePath, promotion.title);
            }
            setOutputPromotion(null);
          }}
        />
        <TaskExperienceNavigation
          experiences={experiences}
          activeExperienceId={activeExperience.id}
          onSelect={setActiveExperienceId}
        />
        {activeExperience.id === 'direct' ? (
          <>
            <DirectExperienceBoundary experience={activeExperience} />
            <LocalReferencesSection
              taskId={taskId}
              projectSlug={graph.task.projectId}
              references={direct}
              directory={directory}
              selection={selection}
              onSelect={setSelection}
            />
            <IntegrationReferencesSection
              taskId={taskId}
              projectSlug={graph.task.projectId}
              references={integrations}
              selection={selection}
              onSelect={setSelection}
            />
            <InspectionSection
              taskId={taskId}
              projectSlug={graph.task.projectId}
              directory={directory}
              references={references}
              selection={selection}
              onSelect={setSelection}
              outputOperations={operations}
              promotionPending={outputPromotion !== null}
              onRequestOutput={(relativePath, title, operationId) => {
                setOutputPromotion({ relativePath, title, operationId });
              }}
            />
          </>
        ) : (
          <TaskExperienceBoundary experience={activeExperience} />
        )}
        <TaskRoomHistoryDetails taskId={taskId} />
      </div>
    </div>
  );
}

/** Space kept between the sticky page header and a revealed pane. */
const REVEAL_GAP_PX = 8;

/** Durable promoted workspace-file snapshots; no RelationGraph mirror. */
function TaskRoomWorkspaceSection({
  task,
  onOpenActionChange,
  visible,
}: {
  task: TaskRecord;
  visible: boolean;
  onOpenActionChange(action: WorkspacePaneHostOpenAction | null): void;
}) {
  const discovery = useProjectTaskRoomDiscoveryQuery(task.id);
  const queryClient = useQueryClient();
  const requestScope = useHostRequestAuthorityScope();
  const refreshBasis = useCallback(() => {
    if (requestScope)
      void queryClient.invalidateQueries({
        queryKey: taskBasisQueries.scope(task.id, requestScope),
      });
  }, [queryClient, requestScope, task.id]);
  const roomRef = useRef<HTMLElement>(null);
  // #3883: Results can open a pane while its Details host is hidden. The
  // page-published action selects the pane, focuses its tab after Details is
  // revealed, and scrolls only when the visible tab strips were out of view.
  // Panes opened inside this host keep the host's own open action.
  const revealFocusedPane = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    // The framed Task route owns its header outside the workspace; direct
    // legacy mounts can still supply a DetailHeader inside it.
    const header =
      room
        .closest('.task-workspace')
        ?.querySelector<HTMLElement>(':scope > .detail-header') ??
      room
        .closest('.page-frame')
        ?.querySelector<HTMLElement>(':scope > .page-frame__header');
    const inView = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.top >= Math.max(0, header?.getBoundingClientRect().bottom ?? 0) &&
        rect.bottom <= window.innerHeight
      );
    };
    // Measured now, before the host's focus frame scrolls the tab to the
    // nearest edge.
    const strips = [...room.querySelectorAll('[role="tablist"]')];
    const roomWasInView =
      room.getClientRects().length > 0 &&
      strips.length > 0 &&
      strips.every(inView);
    // After the host's own focus frame, which is scheduled first.
    requestAnimationFrame(() => {
      const activeElement = room.ownerDocument.activeElement;
      const tab = room.contains(activeElement) ? activeElement : null;
      if (roomWasInView && tab && inView(tab)) return;
      const target =
        tab?.closest<HTMLElement>('.workspace-pane-host__group') ?? room;
      // The margin holds the group below the header for this one scroll.
      target.style.scrollMarginTop = header
        ? `${header.getBoundingClientRect().height + REVEAL_GAP_PX}px`
        : '';
      target.scrollIntoView?.({ block: 'start' });
      target.style.scrollMarginTop = '';
    });
  }, []);
  const publishOpenAction = useCallback(
    (action: WorkspacePaneHostOpenAction | null) =>
      onOpenActionChange(
        action && {
          ...action,
          open(instance, preparation, placement) {
            const outcome = action.open(instance, preparation, placement);
            if (outcome.ok) {
              refreshBasis();
              if (action.focusExisting?.(instance.instanceId))
                revealFocusedPane();
            }
            return outcome;
          },
          focusExisting(instanceId) {
            const found = action.focusExisting?.(instanceId) ?? false;
            if (found) {
              refreshBasis();
              revealFocusedPane();
            }
            return found;
          },
        },
      ),
    [onOpenActionChange, refreshBasis, revealFocusedPane],
  );
  const runtime = useRef<WorkspacePaneHostRuntime | null>(null);
  if (!runtime.current) runtime.current = new WorkspacePaneHostRuntime();
  const hostRuntime = runtime.current;
  const capabilities =
    discovery.data?.kind === 'opened' || discovery.data?.kind === 'existing'
      ? discovery.data.capabilities
      : undefined;
  const retainedCapabilities = useRef<
    | {
        taskId: string;
        value: NonNullable<typeof capabilities>;
      }
    | undefined
  >(undefined);
  if (retainedCapabilities.current?.taskId !== task.id)
    retainedCapabilities.current = undefined;
  if (capabilities)
    retainedCapabilities.current = { taskId: task.id, value: capabilities };
  // Once this Task has proved a readable room contract, keep its historical
  // surface mounted through a reconnect or later authorization loss. The pane
  // children re-check live capability and become read-only; unmounting here
  // would discard the exact async context they are designed to preserve.
  const workspaceCapabilities =
    capabilities ?? retainedCapabilities.current?.value;
  const basis = createWholeTaskBasisPaneInstance(task.projectId, task.id);
  const document =
    basis && workspaceCapabilities?.documentRead
      ? createWorkspacePaneHostBaselineDocument(
          `task-details-${task.id}`,
          {
            kind: 'task',
            projectId: task.projectId,
            taskId: task.id,
            layoutId: `task-${task.id}`,
          },
          [basis],
        )
      : null;
  if (discovery.isLoading)
    return visible ? (
      <SkeletonBlock count={2} label="Checking Task room capabilities" />
    ) : null;
  if (!document)
    return visible ? (
      <p role="status">Task room document is unavailable.</p>
    ) : null;
  return (
    <section
      ref={roomRef}
      className="task-workspace__room"
      aria-label="Task room workspace"
      hidden={!visible}
    >
      <WorkspacePaneHost
        document={document}
        runtime={hostRuntime}
        onOpenActionChange={publishOpenAction}
        presentationLabel={(instance) =>
          resolveWorkspaceBasisMcpPaneOccurrence(instance)?.descriptor.name ??
          null
        }
        renderPane={(instance) => {
          if (!visible) return null;
          const mcpBasis = resolveWorkspaceBasisMcpPaneOccurrence(instance);
          return instance.descriptorId ===
            WORKSPACE_BASIS_PANE_DESCRIPTOR.id ? (
            <Suspense
              fallback={<SkeletonBlock count={3} label="Loading Basis" />}
            >
              <LazyTaskBasisWorkspacePane
                presentation="chromeless"
                descriptor={WORKSPACE_BASIS_PANE_DESCRIPTOR}
                instance={instance}
              />
            </Suspense>
          ) : mcpBasis ? (
            <Suspense
              fallback={<SkeletonBlock count={3} label="Loading Basis App" />}
            >
              <LazyTaskBasisMcpWorkspacePane
                descriptor={mcpBasis.descriptor}
                instance={instance}
              />
            </Suspense>
          ) : null;
        }}
      />
    </section>
  );
}

function DirectExperienceBoundary({
  experience,
}: {
  experience: ResolvedTaskExperience;
}) {
  return (
    <aside
      className="task-workspace__direct-boundary"
      aria-label="Direct experience authority"
    >
      <strong>Authority: {experience.authority}</strong>
      <span>{experience.description}</span>
    </aside>
  );
}

function TaskExperienceNavigation({
  experiences,
  activeExperienceId,
  onSelect,
}: {
  experiences: ResolvedTaskExperience[];
  activeExperienceId: TaskExperienceId;
  onSelect: (id: TaskExperienceId) => void;
}) {
  if (experiences.length === 1) {
    return (
      <section
        className="task-workspace__experiences"
        aria-labelledby="task-inspection-heading"
      >
        <div className="task-workspace__experience-heading">
          <div>
            <h3 id="task-inspection-heading">Task inspection</h3>
            <p>
              Inspect this Task's recorded workspace and references. Additional
              product capabilities appear here only when their owner attaches a
              verified contract.
            </p>
          </div>
          <a className="editor-btn" href="/plugins">
            Add capabilities
          </a>
        </div>
      </section>
    );
  }
  return (
    <nav className="task-workspace__experiences" aria-label="Task experiences">
      <div className="task-workspace__experience-heading">
        <div>
          <h3>Task experiences</h3>
          <p>
            Task identity stays in Station; each experience keeps its owning
            product authority.
          </p>
        </div>
      </div>
      <div className="task-workspace__experience-list">
        {experiences.map((experience) => (
          <button
            key={experience.id}
            type="button"
            className={`task-workspace__experience${
              activeExperienceId === experience.id
                ? ' task-workspace__experience--active'
                : ''
            }`}
            aria-label={`${experience.label} ${experience.authority} ${experience.availability}`}
            aria-pressed={activeExperienceId === experience.id}
            onClick={() => onSelect(experience.id)}
          >
            <span className="task-workspace__experience-name">
              {experience.label}
            </span>
            <span className="task-workspace__experience-owner">
              {experience.authority}
            </span>
            <span
              className={`task-workspace__experience-status task-workspace__experience-status--${experience.availability}`}
            >
              {experience.availability}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function TaskExperienceBoundary({
  experience,
}: {
  experience: ResolvedTaskExperience;
}) {
  const isExternalAlternative = experience.alternativeHref?.startsWith('http');
  return (
    <section
      className="task-workspace__section task-workspace__experience-boundary"
      aria-labelledby={`task-experience-${experience.id}`}
    >
      <div className="task-workspace__section-heading">
        <div>
          <p className="task-workspace__experience-eyebrow">
            Authority: {experience.authority}
          </p>
          <h3
            id={`task-experience-${experience.id}`}
            className="task-workspace__section-title"
          >
            {experience.label} experience
          </h3>
          <p>{experience.description}</p>
        </div>
      </div>
      <div className="task-workspace__experience-callout">
        <p>{experience.unavailableDescription}</p>
        {experience.alternativeHref && experience.alternativeLabel ? (
          <a
            className="editor-btn"
            href={experience.alternativeHref}
            target={isExternalAlternative ? '_blank' : undefined}
            rel={isExternalAlternative ? 'noreferrer' : undefined}
          >
            {experience.alternativeLabel}
          </a>
        ) : null}
      </div>
      <p className="task-workspace__experience-boundary-note">
        Station preserves Task identity and availability disclosure;{' '}
        {experience.authority} remains authoritative for this experience.
      </p>
    </section>
  );
}

function TaskHeader({ task }: { task: TaskRecord }) {
  usePageHeader({ title: task.title, subtitle: `Task ${task.id}` });
  return null;
}

/**
 * The Task's linked tracker item (#4003), re-read every time the Task opens.
 * The tracker owns state and labels; Station shows them as read, never syncs
 * them. "New comments" are those created after the Task last recorded the
 * item (`workItemObservedAt`).
 */
function TaskWorkItemHeader({
  taskId,
  workItemRef,
}: {
  taskId: string;
  workItemRef: string;
}) {
  const { data, error, isLoading } = useTaskWorkItemQuery(taskId);
  const observation = data?.status === 'observed' ? data.observation : null;
  const url = observation?.url ?? gitHubIssueUrlFromWorkItemRef(workItemRef);
  const newComments =
    observation && data?.commentsSince !== undefined
      ? (observation.comments?.length ?? 0)
      : undefined;
  const newCommentLabel =
    newComments === undefined
      ? null
      : newComments === 0
        ? 'No new comments'
        : `${newComments}${newComments >= WORK_ITEM_OBSERVATION_LIMITS.comments ? '+' : ''} new comment${newComments === 1 ? '' : 's'}`;
  return (
    <section
      className="task-workspace__work-item"
      aria-label="Linked work item"
      data-testid="task-work-item-header"
    >
      {url ? (
        <a
          className="task-workspace__work-item-ref"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          {workItemRef}
        </a>
      ) : (
        <span className="task-workspace__work-item-ref">{workItemRef}</span>
      )}
      {observation ? (
        <>
          <span
            className={`task-workspace__work-item-state task-workspace__work-item-state--${observation.state}`}
          >
            {observation.state === 'open' ? 'Open' : 'Closed'}
            {observation.stateReason && observation.state === 'closed'
              ? ` · ${observation.stateReason.replaceAll('_', ' ')}`
              : ''}
          </span>
          {observation.labels.map((label) => (
            <span className="task-workspace__work-item-label" key={label}>
              {label}
            </span>
          ))}
          {newCommentLabel ? (
            <span className="task-workspace__work-item-comments">
              {newCommentLabel}
            </span>
          ) : null}
        </>
      ) : isLoading ? (
        <span className="task-workspace__work-item-note">
          Reading the item…
        </span>
      ) : (
        <span className="task-workspace__work-item-note" role="status">
          Couldn’t read the item.{' '}
          {data && data.status !== 'observed'
            ? data.reason
            : error
              ? errorText(error)
              : ''}
        </span>
      )}
    </section>
  );
}

function TaskIdentitySection({ task }: { task: TaskRecord }) {
  const origin = task.updatedClientOrigin ?? task.createdClientOrigin;
  const originDetail = clientOriginDetail(origin);
  return (
    <section
      className="task-workspace__section"
      aria-labelledby="task-identity"
    >
      <h3 id="task-identity" className="task-workspace__section-title">
        Task identity
      </h3>
      <dl className="task-workspace__details">
        <TaskDetail label="Task ID" value={task.id} />
        <TaskDetail label="Title" value={task.title} />
        <TaskDetail label="Status" value={taskStatusLabel(task.status)} />
        <TaskDetail label="Project" value={task.projectId} />
        {task.workItemRef ? (
          <TaskDetail label="Work item" value={task.workItemRef} />
        ) : null}
        <TaskDetail label="Last action origin" value={originDetail} />
      </dl>
    </section>
  );
}

function WorkspaceBindingSection({ task }: { task: TaskRecord }) {
  const binding = task.workspaceBinding;
  const availability = binding?.availability ?? 'unavailable';
  return (
    <section
      className="task-workspace__section"
      aria-labelledby="task-workspace-binding"
    >
      <h3 id="task-workspace-binding" className="task-workspace__section-title">
        Local workspace
      </h3>
      <dl className="task-workspace__details">
        <TaskDetail label="Workspace availability" value={availability} />
        <TaskDetail
          label="Project working directory"
          value={binding?.workingDirectory}
        />
        <TaskDetail
          label="Git top-level/repository root"
          value={binding?.repoRoot}
        />
        <TaskDetail label="Task worktree" value={binding?.worktreePath} />
        <TaskDetail label="Branch" value={binding?.branch} />
        <TaskDetail label="Session" value={task.sessionId} />
        <TaskDetail label="Agent" value={task.agentId} />
      </dl>
      {availability !== 'available' ? (
        <WorkspaceAvailabilityNotice availability={availability} />
      ) : null}
    </section>
  );
}

function WorkspaceAvailabilityNotice({
  availability,
}: {
  availability: 'ambiguous' | 'unavailable';
}) {
  const description =
    availability === 'ambiguous'
      ? 'Stored workspace facts disagree with the current Project or Git state. Local inspection is disabled.'
      : 'The exact stored workspace is no longer available. Snapshot identity remains visible, but local inspection is disabled.';
  return (
    <Empty
      variant="compact"
      label={`Task workspace is ${availability}`}
      description={description}
    />
  );
}

interface ReferenceSectionProps {
  taskId: string;
  projectSlug: string;
  references: ReferenceItem[];
  selection: ReferenceSelection | null;
  onSelect: (selection: ReferenceSelection | null) => void;
}

function ReferenceList({
  taskId,
  references,
  selection,
  onSelect,
}: ReferenceSectionProps) {
  return (
    <div className="task-workspace__reference-list">
      {references.map((reference) => (
        <ReferenceButton
          key={reference.id}
          reference={reference}
          selected={
            selection?.taskId === taskId &&
            selection.kind === 'reference' &&
            selection.id === reference.id
          }
          onSelect={() =>
            onSelect({ taskId, kind: 'reference', id: reference.id })
          }
        />
      ))}
    </div>
  );
}

function LocalReferencesSection(
  props: ReferenceSectionProps & { directory?: string },
) {
  return (
    <section
      className="task-workspace__section"
      aria-labelledby="task-references"
    >
      <div className="task-workspace__section-heading">
        <div>
          <h3 id="task-references" className="task-workspace__section-title">
            Local references
          </h3>
          <p>
            Artifact, receipt, and changed-file references remain in this Task
            workspace.
          </p>
        </div>
        {props.directory ? (
          <button
            className="editor-btn"
            type="button"
            onClick={() =>
              props.onSelect({ taskId: props.taskId, kind: 'diff' })
            }
          >
            Inspect worktree diff
          </button>
        ) : null}
      </div>
      {props.references.length ? (
        <ReferenceList {...props} />
      ) : (
        <Empty
          variant="compact"
          label="References not recorded yet"
          description="Artifacts, receipts, and changed files will appear here when this Task records them."
        />
      )}
    </section>
  );
}

function IntegrationReferencesSection(props: ReferenceSectionProps) {
  return (
    <section
      className="task-workspace__section"
      aria-labelledby="task-integrations"
    >
      <h3 id="task-integrations" className="task-workspace__section-title">
        Optional integration references
      </h3>
      {props.references.length ? (
        <ReferenceList {...props} />
      ) : (
        <Empty
          variant="compact"
          label="Optional integrations not attached"
          description="Direct local workspace inspection remains available without Builder, Knowledge, or Console integrations."
        />
      )}
    </section>
  );
}

function InspectionSection(
  props: ReferenceSectionProps & {
    directory?: string;
    outputOperations: OutputOperationIds;
    promotionPending: boolean;
    onRequestOutput: (
      relativePath: string,
      title: string,
      operationId: string,
    ) => void;
  },
) {
  const selected =
    props.selection?.taskId === props.taskId ? props.selection : null;
  const reference =
    selected?.kind === 'reference'
      ? props.references.find((item) => item.id === selected.id)
      : undefined;
  return (
    <section
      className="task-workspace__section task-workspace__inspection"
      aria-labelledby="task-inspection"
    >
      <h3 id="task-inspection" className="task-workspace__section-title">
        Inspection
      </h3>
      <InspectionContent
        {...props}
        selection={selected}
        reference={reference}
      />
    </section>
  );
}

function InspectionContent(
  props: ReferenceSectionProps & {
    directory?: string;
    reference?: ReferenceItem;
    outputOperations: OutputOperationIds;
    promotionPending: boolean;
    onRequestOutput: (
      relativePath: string,
      title: string,
      operationId: string,
    ) => void;
  },
) {
  if (props.selection?.kind === 'diff')
    return props.directory ? (
      <div className="task-workspace__diff">
        <DiffPanel
          workingDir={props.directory}
          projectSlug={props.projectSlug}
        />
      </div>
    ) : (
      <UnavailableInspection />
    );
  if (!props.reference) return <NoSelectionInspection {...props} />;
  if (props.reference.kind === 'external')
    return (
      <Empty
        variant="compact"
        label="External reference is opaque"
        description="Station does not read opaque external references as local files."
      />
    );
  // Two causes, and the condition that used to name both at once already
  // separates them: with no bound workspace there is nothing to resolve a
  // reference against, which is a property of the Task, not of the reference
  // the user just picked (archive#3158).
  if (!props.directory)
    return (
      <Empty
        variant="compact"
        label="Reference content is unavailable"
        description="This Task has no available workspace, so Station cannot resolve any reference to a local file."
      />
    );
  const path = referencePath(props.reference, props.directory);
  // What remains is the one thing `referencePath` actually decided: no safe
  // relative path inside the workspace. It does not report WHY (opaque
  // target, outside the workspace, unsafe segments), so this does not guess.
  if (!path)
    return (
      <Empty
        variant="compact"
        label="Reference content is unavailable"
        description="Station could not resolve this reference to a safe file path inside the exact Task workspace."
      />
    );
  return (
    <LocalReferenceContent
      {...props}
      reference={props.reference}
      path={path}
      directory={props.directory}
    />
  );
}

function NoSelectionInspection({ directory }: { directory?: string }) {
  return (
    <Empty
      variant="compact"
      label="Select a reference to inspect"
      description={
        directory
          ? 'Choose a local reference or inspect the exact bound worktree diff.'
          : 'No exact Task workspace is available for local file or diff inspection.'
      }
    />
  );
}

function LocalReferenceContent(
  props: ReferenceSectionProps & {
    reference: ReferenceItem;
    path: string;
    directory: string;
    outputOperations: OutputOperationIds;
    promotionPending: boolean;
    onRequestOutput: (
      relativePath: string,
      title: string,
      operationId: string,
    ) => void;
  },
) {
  const title = outputTitle(props.path);
  function keepAsOutput() {
    const operationId = props.outputOperations.get(props.path, title);
    props.onRequestOutput(props.path, title, operationId);
  }
  return (
    <div className="task-workspace__content">
      <div className="task-workspace__content-actions">
        <Button
          size="sm"
          onClick={keepAsOutput}
          pending={props.promotionPending}
          pendingLabel="Keeping output…"
          aria-label={`Keep ${props.path} as output`}
        >
          Keep
        </Button>
        <span>{props.path}</span>
      </div>
      {props.reference.kind === 'file' ? (
        <button
          className="editor-btn"
          type="button"
          onClick={() => props.onSelect({ taskId: props.taskId, kind: 'diff' })}
        >
          View worktree diff
        </button>
      ) : null}
      <FileContentViewer
        workingDir={props.directory}
        filePath={props.path}
        onClose={() => props.onSelect(null)}
        projectSlug={props.projectSlug}
      />
    </div>
  );
}

function TaskLoadingState() {
  return (
    <div className="page page--full task-workspace">
      <SkeletonList count={5} label="Loading task workspace" />
    </div>
  );
}

function DeletedProjectTaskState({ task }: { task: TaskRecord }) {
  return (
    <div className="page page--full task-workspace">
      <TaskHeader task={task} />
      <div className="task-workspace__body">
        <ErrorState
          title="Project deleted"
          description={`This Task is retained in history, but its Project (${task.projectId}) no longer exists. Chats and recorded Task details remain; live Project workspace controls are unavailable.`}
        />
        <TaskIdentitySection task={task} />
      </div>
    </div>
  );
}

function TaskProjectCheckError({
  task,
  error,
  onRetry,
}: {
  task: TaskRecord;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="page page--full task-workspace">
      <TaskHeader task={task} />
      <div className="task-workspace__body">
        <ErrorState
          title="Unable to verify Task project"
          description={errorText(error)}
          action={
            <button
              className="editor-btn editor-btn--primary"
              type="button"
              onClick={onRetry}
            >
              Retry
            </button>
          }
        />
      </div>
    </div>
  );
}

function TaskLoadError({
  taskId,
  error,
  onRetry,
}: {
  taskId: string;
  error: unknown;
  onRetry: () => void;
}) {
  const notFound = isTaskNotFound(error);
  const description = notFound
    ? `Task ${taskId} is unavailable or no longer exists.`
    : error instanceof Error
      ? error.message
      : 'Task data was not returned.';
  return (
    <div className="page page--full task-workspace task-workspace__state">
      <ErrorState
        title={notFound ? 'Task not found' : 'Unable to load task'}
        description={description}
        action={
          <button
            className="editor-btn editor-btn--primary"
            type="button"
            onClick={onRetry}
          >
            Retry
          </button>
        }
      />
    </div>
  );
}

function TaskDetail({ label, value }: { label: string; value?: string }) {
  return (
    <div className="task-workspace__detail">
      <dt>{label}</dt>
      <dd>{unavailable(value)}</dd>
    </div>
  );
}

function ReferenceButton({
  reference,
  selected,
  onSelect,
}: {
  reference: ReferenceItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-pressed={selected}
      className={`task-workspace__reference${
        selected ? ' task-workspace__reference--selected' : ''
      }`}
      type="button"
      onClick={onSelect}
    >
      <span className="task-workspace__reference-kind">{reference.kind}</span>
      <span className="task-workspace__reference-label">
        {referenceLabel(reference)}
      </span>
    </button>
  );
}

function UnavailableInspection() {
  return (
    <Empty
      variant="compact"
      label="Task workspace is unavailable"
      description="A worktree, repository root, or working directory was not captured for this Task."
    />
  );
}
