import { resolveWorkspaceBasisMcpPaneOccurrence } from '@kontourai/station-basis-pane/workspace-basis-mcp-pane';
import { WORKSPACE_BASIS_PANE_DESCRIPTOR } from '@kontourai/station-basis-pane/workspace-basis-pane';
import {
  WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR_ID,
  WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR_ID,
} from '@kontourai/station-contracts/workspace-task-room';
import { composeTaskRoomWorkspace } from '@kontourai/station-contracts/workspace-task-room-composition';
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
} from '@kontourai/station-sdk';
import { useProjectTaskRoomDiscoveryQuery } from '@kontourai/station-sdk/project-task-rooms';
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
import { DetailHeader } from '../components/DetailHeader';
import {
  Empty,
  ErrorState,
  SkeletonBlock,
  SkeletonList,
} from '../components/state';
import { useNavigation } from '../contexts/NavigationContext';
import { clientOriginDetail } from '../utils/clientOrigin';
import { ProjectTaskRoomProvider } from '../workspace-panes/ProjectTaskRoomContext';
import { ProjectTaskRoomConversation } from '../workspace-panes/ProjectTaskRoomConversation';
import { ProjectTaskRoomPresence } from '../workspace-panes/ProjectTaskRoomPresence';
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
import {
  type TaskOutputPromotion,
  TaskOutputsSection,
} from './task-workspace/TaskOutputsSection';
import { TaskTurnReferenceView } from './task-workspace/TaskTurnReferenceView';
import { TaskUserInputReferences } from './task-workspace/TaskUserInputReferences';
import './page-layout.css';
import './TaskWorkspaceView.css';

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

function statusBadgeVariant(status: string) {
  if (status === 'done') return 'success' as const;
  if (status === 'blocked' || status === 'canceled') return 'warning' as const;
  if (status === 'running') return 'info' as const;
  return 'muted' as const;
}

export function TaskWorkspaceView({ taskId }: { taskId: string }) {
  const { data: graph, isLoading, error, refetch } = useTaskGraphQuery(taskId);
  const starterLinkUnverified =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('starterLink') ===
      'not-verified' &&
    new URLSearchParams(window.location.search).get('starter') === 'start-task';
  if (isLoading) return <TaskLoadingState />;
  if (error || !graph) {
    return (
      <TaskLoadError
        taskId={taskId}
        error={error}
        onRetry={() => void refetch()}
      />
    );
  }
  return (
    <>
      {starterLinkUnverified && <StarterLinkRetry task={graph.task} />}
      <TaskWorkspaceContent taskId={taskId} graph={graph} />
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
}: {
  taskId: string;
  graph: TaskGraph;
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
  const [basisHostOpen, setBasisHostOpen] =
    useState<WorkspacePaneHostOpenAction | null>(null);
  const captureBasisHostOpen = useCallback(
    (action: WorkspacePaneHostOpenAction | null) => setBasisHostOpen(action),
    [],
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
        const operationId = crypto.randomUUID();
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
      <TaskHeader task={graph.task} />
      <div className="task-workspace__body">
        <TaskExperienceNavigation
          experiences={experiences}
          activeExperienceId={activeExperience.id}
          onSelect={setActiveExperienceId}
        />
        <TaskIdentitySection task={graph.task} />
        <WorkspacePaneHostOpenContext.Provider value={basisHostOpen}>
          <TaskTurnReferenceView
            taskId={taskId}
            projectId={graph.task.projectId}
          />
        </WorkspacePaneHostOpenContext.Provider>
        <TaskUserInputReferences taskId={taskId} />
        <WorkspaceBindingSection task={graph.task} />
        <TaskOutputsSection
          task={graph.task}
          promotion={outputPromotion}
          onPromotionSettled={(promotion, success) => {
            if (success)
              operations.clear(promotion.relativePath, promotion.title);
            setOutputPromotion(null);
          }}
        />
        {activeExperience.id === 'direct' ? (
          <>
            <DirectExperienceBoundary experience={activeExperience} />
            <TaskRoomWorkspaceSection
              task={graph.task}
              onOpenActionChange={captureBasisHostOpen}
            />
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
              onRequestOutput={(relativePath, title, operationId) =>
                setOutputPromotion({ relativePath, title, operationId })
              }
            />
          </>
        ) : (
          <TaskExperienceBoundary experience={activeExperience} />
        )}
      </div>
    </div>
  );
}

/** Durable promoted workspace-file snapshots; no RelationGraph mirror. */
function TaskRoomWorkspaceSection({
  task,
  onOpenActionChange,
}: {
  task: TaskRecord;
  onOpenActionChange(action: WorkspacePaneHostOpenAction | null): void;
}) {
  const discovery = useProjectTaskRoomDiscoveryQuery(task.id);
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
  const composition = composeTaskRoomWorkspace({
    projectId: task.projectId,
    taskId: task.id,
    layoutId: `task-${task.id}`,
    capabilities: {
      documentRead: workspaceCapabilities?.documentRead === true,
      documentWrite: workspaceCapabilities?.documentWrite === true,
      roomRead: workspaceCapabilities?.historyRead === true,
      roomLive: workspaceCapabilities?.live === true,
    },
  });
  if (discovery.isLoading)
    return <SkeletonBlock count={2} label="Checking Task room capabilities" />;
  if (!composition.document)
    return <p role="status">Task room document is unavailable.</p>;
  return (
    <section className="task-workspace__room" aria-label="Task room workspace">
      {composition.degradedCapabilities.length ? (
        <p role="status">
          Task room degraded: {composition.degradedCapabilities.join(', ')}.
        </p>
      ) : null}
      <ProjectTaskRoomProvider taskId={task.id}>
        <ProjectTaskRoomPresence taskId={task.id} />
        <WorkspacePaneHost
          document={composition.document}
          runtime={hostRuntime}
          onOpenActionChange={onOpenActionChange}
          presentationLabel={(instance) =>
            resolveWorkspaceBasisMcpPaneOccurrence(instance)?.descriptor.name ??
            null
          }
          renderPane={(instance) => {
            const mcpBasis = resolveWorkspaceBasisMcpPaneOccurrence(instance);
            return instance.descriptorId ===
              WORKSPACE_TASK_ROOM_EDITOR_DESCRIPTOR_ID ? (
              <TaskRoomEditorPane
                taskId={task.id}
                runtime={hostRuntime}
                instanceId={instance.instanceId}
              />
            ) : instance.descriptorId ===
              WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR_ID ? (
              <ProjectTaskRoomConversation taskId={task.id} />
            ) : instance.descriptorId === WORKSPACE_BASIS_PANE_DESCRIPTOR.id ? (
              <Suspense
                fallback={<SkeletonBlock count={3} label="Loading Basis" />}
              >
                <LazyTaskBasisWorkspacePane
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
      </ProjectTaskRoomProvider>
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
  return (
    <DetailHeader
      title={task.title}
      subtitle={`Task ${task.id}`}
      badge={{ label: task.status, variant: statusBadgeVariant(task.status) }}
    />
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
        <TaskDetail label="Status" value={task.status} />
        <TaskDetail label="Project" value={task.projectId} />
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
        <DiffPanel workingDir={props.directory} />
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
          Keep as output
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
