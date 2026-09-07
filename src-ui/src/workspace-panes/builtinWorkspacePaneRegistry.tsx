import { WORKSPACE_BASIS_PANE_RENDERER_NAME } from '@kontourai/station-basis-pane/workspace-basis-pane';
import { WORKSPACE_BOARD_PANE_RENDERER_NAME } from '@kontourai/station-board-pane/workspace-board-pane';
import { WORKSPACE_ACTIVITY_PANE_RENDERER_NAME } from '@kontourai/station-contracts/workspace-activity-pane';
import { WORKSPACE_BROWSER_PREVIEW_PANE_RENDERER_NAME } from '@kontourai/station-contracts/workspace-browser-preview';
import {
  isCanonicalWorkspaceChatPaneInstance,
  WORKSPACE_CHAT_PANE_RENDERER_NAME,
} from '@kontourai/station-contracts/workspace-chat-pane';
import {
  isCanonicalWorkspaceCodingDiffPaneInstance,
  isCanonicalWorkspaceCodingFileBrowserPaneInstance,
  isCanonicalWorkspaceCodingTerminalPaneInstance,
  WORKSPACE_CODING_DIFF_PANE_RENDERER_NAME,
  WORKSPACE_CODING_FILE_BROWSER_PANE_RENDERER_NAME,
  WORKSPACE_CODING_TERMINAL_PANE_RENDERER_NAME,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  isCanonicalWorkspacePlanPaneInstance,
  isCanonicalWorkspaceReadinessPaneInstance,
  isCanonicalWorkspaceTrustPaneInstance,
  WORKSPACE_PLAN_PANE_RENDERER_NAME,
  WORKSPACE_READINESS_PANE_RENDERER_NAME,
  WORKSPACE_TRUST_PANE_RENDERER_NAME,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import { WORKSPACE_FILE_PREVIEW_PANE_RENDERER_NAME } from '@kontourai/station-contracts/workspace-file-preview';
import { WORKSPACE_HOME_PANE_RENDERER_NAME } from '@kontourai/station-contracts/workspace-home-pane';
import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import {
  isCanonicalWorkspaceSpatialBoardPaneInstance,
  WORKSPACE_SPATIAL_BOARD_PANE_RENDERER_NAME,
} from '@kontourai/station-contracts/workspace-spatial-board';
import {
  isCanonicalTaskRoomWorkspacePaneInstance,
  WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR,
  WORKSPACE_TASK_ROOM_EDITOR_RENDERER_NAME,
} from '@kontourai/station-contracts/workspace-task-room';
import {
  useFlowDefinitionsQuery,
  useProjectLayoutQuery,
} from '@kontourai/station-sdk';
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Button } from '../components/Button';
import { ChatWorkspacePane } from '../components/chat-dock/ChatDock';
import { BranchToolbar } from '../components/coding-layout/BranchToolbar';
import {
  ReadinessInspectorContent,
  TrustInspectorContent,
  WorkflowPlanInspectorContent,
} from '../components/coding-layout/CodingInspectorPanel';
import { CodingTerminalPane } from '../components/coding-layout/CodingTerminalPane';
import { DiffPanel } from '../components/coding-layout/DiffPanel';
import { FileTreePanel } from '../components/coding-layout/FileTreePanel';
import { PullRequestsPanel } from '../components/coding-layout/PullRequestsPanel';
import { selectWorkflowPlanSession } from '../components/coding-layout/planSession';
import { FlowRunConsole } from '../components/flow/FlowRunConsole';
import {
  deriveWorkflowPlanArtifact,
  toWorkflowPlanArtifact,
} from '../components/flow/WorkflowPlanPanel';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  SkeletonBlock,
} from '../components/state';
import { useNavigation } from '../contexts/NavigationContext';
import { useDerivedSessions } from '../hooks/useDerivedSessions';
import { BrowserPreviewWorkspacePane } from './BrowserPreviewWorkspacePane';
import {
  type BuiltinWorkspacePaneRendererName,
  isCanonicalBuiltinCodingOccurrence,
  isCanonicalBuiltinWorkspacePaneDescriptor,
} from './builtinWorkspacePaneCanonical';
import { CodingChatPane } from './CodingChatPane';
import {
  createFilePreviewPaneInstance,
  isCanonicalFilePreviewPaneInstance,
} from './filePreviewPaneInstance';
import {
  createFilePreviewPaneStatePreparation,
  readFilePreviewPaneState,
} from './filePreviewPaneStateStorage';
import type { OpenFilePreviewIntent } from './openFilePreviewIntent';
import { ProjectTaskRoomConversation } from './ProjectTaskRoomConversation';
import { TaskRoomEditorPane } from './TaskRoomEditorPane';
import { useWorkspacePaneBoundIdentity } from './useWorkspacePaneBoundIdentity';
import { WorkspacePaneBindingUnavailable } from './WorkspacePaneBindingUnavailable';
import { useWorkspacePaneHostOpenAction } from './WorkspacePaneHostOpenContext';

export {
  builtinWorkspacePaneRendererPresence,
  isCanonicalBuiltinActivityDescriptor,
  isCanonicalBuiltinBoardDescriptor,
  isCanonicalBuiltinBrowserPreviewDescriptor,
  isCanonicalBuiltinChatDescriptor,
  isCanonicalBuiltinCodingDiffDescriptor,
  isCanonicalBuiltinCodingFileBrowserDescriptor,
  isCanonicalBuiltinCodingOccurrence,
  isCanonicalBuiltinCodingTerminalDescriptor,
  isCanonicalBuiltinFilePreviewDescriptor,
  isCanonicalBuiltinHomeDescriptor,
  isCanonicalBuiltinPlanDescriptor,
  isCanonicalBuiltinReadinessDescriptor,
  isCanonicalBuiltinSpatialBoardDescriptor,
  isCanonicalBuiltinTaskRoomChatDescriptor,
  isCanonicalBuiltinTaskRoomEditorDescriptor,
  isCanonicalBuiltinTrustDescriptor,
} from './builtinWorkspacePaneCanonical';

const LazyFilePreviewPane = lazy(() =>
  import('./FilePreviewPane').then(({ FilePreviewPane }) => ({
    default: FilePreviewPane,
  })),
);

export interface BuiltinWorkspacePaneProps {
  descriptor: WorkspacePaneDescriptor;
  instance: WorkspacePaneInstance;
  /** Catalog-resolved only; never inferred by a renderer from platform globals. */
  browserPreviewAvailability?: WorkspacePaneAvailability;
}

type BuiltinWorkspacePaneComponent = (
  props: BuiltinWorkspacePaneProps,
) => ReactNode;

function useResolvedPaneIdentity(
  instance: WorkspacePaneInstance,
  needsLayout: boolean,
) {
  return useWorkspacePaneBoundIdentity(instance, needsLayout);
}

function FlowRunConsolePane({ instance }: BuiltinWorkspacePaneProps) {
  const identity = useResolvedPaneIdentity(instance, false);
  // The console's own missing-descriptor check is intentionally left to archive#3261's follow-up.
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  return <FlowRunConsole projectSlug={identity.project.slug} />;
}

function ChatPane({ instance }: BuiltinWorkspacePaneProps) {
  const identity = useResolvedPaneIdentity(
    instance,
    Boolean(instance.boundContext?.layoutId),
  );
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  if (instance.descriptorId === WORKSPACE_TASK_ROOM_CHAT_DESCRIPTOR.id) {
    const taskId = instance.boundContext?.taskId;
    if (
      !taskId ||
      !isCanonicalTaskRoomWorkspacePaneInstance(
        identity.project.id,
        taskId,
        instance,
      )
    )
      return (
        <WorkspacePaneBindingUnavailable
          identity={{ state: 'pane-instance-invalid' }}
        />
      );
    return <ProjectTaskRoomConversation taskId={taskId} />;
  }
  if (!isCanonicalWorkspaceChatPaneInstance(instance))
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );
  return (
    <ChatWorkspacePane
      placement="fullscreen"
      projectSlug={identity.project.slug}
      {...(identity.layout ? { layoutSlug: identity.layout.slug } : {})}
    />
  );
}

function TaskRoomEditor({ instance }: BuiltinWorkspacePaneProps) {
  const identity = useResolvedPaneIdentity(instance, false);
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  const taskId = instance.boundContext?.taskId;
  if (
    !taskId ||
    !isCanonicalTaskRoomWorkspacePaneInstance(
      identity.project.id,
      taskId,
      instance,
    )
  )
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );
  return <TaskRoomEditorPane taskId={taskId} />;
}

function CodingPane({
  descriptor,
  instance,
  browserPreviewAvailability,
}: BuiltinWorkspacePaneProps) {
  const identity = useResolvedPaneIdentity(instance, true);
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  if (!isCanonicalBuiltinCodingOccurrence(instance, descriptor))
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );
  return (
    <CodingChatPane
      projectId={identity.project.id}
      projectSlug={identity.project.slug}
      browserPreviewAvailability={browserPreviewAvailability}
    />
  );
}

function codingWorkingDirectory(
  layout: { config?: Record<string, unknown> } | undefined,
): string {
  const value = layout?.config?.workingDirectory;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Review, and the sharpest instance of it in the app: a FAILED layout read
 * leaves `layout` undefined, `codingWorkingDirectory` returns `''`, and all
 * three coding panes rendered "Workspace directory needed — set this Project's
 * working directory". That is not merely an empty state, it is WRONG GUIDANCE:
 * it sends a user whose read hit a transient 500 off to reconfigure a project
 * that is already configured. Shared by the three panes so the distinction is
 * derived once, not re-decided per pane.
 */
function CodingLayoutReadFailure({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <ErrorState
      variant="compact"
      title="Unable to load this Project's layout"
      description={describeReadFailure(error)}
      action={
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      }
    />
  );
}

function CodingFileBrowserPane({ instance }: BuiltinWorkspacePaneProps) {
  const identity = useResolvedPaneIdentity(instance, true);
  const projectSlug =
    identity.state === 'resolved' ? identity.project.slug : '';
  const layoutSlug =
    identity.state === 'resolved' ? (identity.layout?.slug ?? '') : '';
  const projectId = identity.state === 'resolved' ? identity.project.id : '';
  const {
    data: layout,
    error: layoutError,
    refetch: refetchLayout,
  } = useProjectLayoutQuery(projectSlug, layoutSlug, {
    enabled: identity.state === 'resolved',
  });
  const paneHostOpen = useWorkspacePaneHostOpenAction();
  const { openFilePreviewIntent, setLayout } = useNavigation();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const workingDir = codingWorkingDirectory(layout);
  useEffect(() => {
    if (openFilePreviewIntent?.projectSlug === projectSlug)
      setSelectedPath(openFilePreviewIntent.path);
  }, [openFilePreviewIntent, projectSlug]);
  const openFile = useCallback(
    (intent: OpenFilePreviewIntent) => {
      setSelectedPath(intent.path);
      // Compact pane navigation unmounts inactive renderers. Keep the selected
      // file in the navigation contract so returning to this pane restores the
      // exact row while the host independently opens the preview occurrence.
      setLayout(projectSlug, layoutSlug, { openFilePreviewIntent: intent });
      if (!paneHostOpen) {
        return;
      }
      const preview = createFilePreviewPaneInstance(
        {
          version: '1.0',
          projectSlug: intent.projectSlug,
          path: intent.path,
          ...(intent.lineRange ? { lineRange: intent.lineRange } : {}),
          wrap: true,
        },
        projectId,
      );
      if (!preview) return;
      // #1596 names three click paths; this is not one of them, and its
      // outcome is deliberately still unsurfaced: the row selection and the
      // navigation intent above are what the reader sees, and they happen
      // whether or not the preview occurrence is admitted. Reporting a
      // refusal here needs a place in this pane's own chrome to put it.
      paneHostOpen.open(
        preview,
        createFilePreviewPaneStatePreparation(
          window.localStorage,
          preview.stateKey,
          {
            version: '1.0',
            projectSlug: intent.projectSlug,
            path: intent.path,
            ...(intent.lineRange ? { lineRange: intent.lineRange } : {}),
            wrap: true,
          },
        ),
      );
    },
    [layoutSlug, paneHostOpen, projectId, projectSlug, setLayout],
  );
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  if (!isCanonicalWorkspaceCodingFileBrowserPaneInstance(instance))
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );
  if (layoutError) {
    return (
      <CodingLayoutReadFailure
        error={layoutError}
        onRetry={() => void refetchLayout()}
      />
    );
  }
  if (!workingDir) {
    return (
      <Empty
        variant="compact"
        label="Workspace directory needed"
        description="Set this Project’s working directory before browsing files."
      />
    );
  }
  return (
    <FileTreePanel
      projectSlug={projectSlug}
      workingDir={workingDir}
      selectedPath={selectedPath}
      onFileSelect={openFile}
    />
  );
}

function CodingDiffPane({ instance }: BuiltinWorkspacePaneProps) {
  const identity = useResolvedPaneIdentity(instance, true);
  const projectSlug =
    identity.state === 'resolved' ? identity.project.slug : '';
  const layoutSlug =
    identity.state === 'resolved' ? (identity.layout?.slug ?? '') : '';
  const {
    data: layout,
    error: layoutError,
    refetch: refetchLayout,
  } = useProjectLayoutQuery(projectSlug, layoutSlug, {
    enabled: identity.state === 'resolved',
  });
  const [activeRepoRoot, setActiveRepoRoot] = useState<string | null>(null);
  const workingDir = codingWorkingDirectory(layout);
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  if (!isCanonicalWorkspaceCodingDiffPaneInstance(instance))
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );
  if (layoutError) {
    return (
      <CodingLayoutReadFailure
        error={layoutError}
        onRetry={() => void refetchLayout()}
      />
    );
  }
  if (!workingDir) {
    return (
      <Empty
        variant="compact"
        label="Workspace directory needed"
        description="Set this Project’s working directory before reviewing its diff."
      />
    );
  }
  return (
    <div className="workspace-coding-diff-pane">
      <BranchToolbar
        workingDir={workingDir}
        onActiveRepoChange={setActiveRepoRoot}
      />
      <div className="workspace-coding-review-panels">
        <PullRequestsPanel
          projectSlug={projectSlug}
          activeRepoRoot={activeRepoRoot ?? workingDir}
        />
        <DiffPanel
          workingDir={activeRepoRoot ?? workingDir}
          projectSlug={projectSlug}
        />
      </div>
    </div>
  );
}

function CodingTerminalWorkspacePane({ instance }: BuiltinWorkspacePaneProps) {
  const identity = useResolvedPaneIdentity(instance, true);
  const projectSlug =
    identity.state === 'resolved' ? identity.project.slug : '';
  const layoutSlug =
    identity.state === 'resolved' ? (identity.layout?.slug ?? '') : '';
  const {
    data: layout,
    error: layoutError,
    refetch: refetchLayout,
  } = useProjectLayoutQuery(projectSlug, layoutSlug, {
    enabled: identity.state === 'resolved',
  });
  const workingDir = codingWorkingDirectory(layout);
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  if (!isCanonicalWorkspaceCodingTerminalPaneInstance(instance))
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );
  if (layoutError) {
    return (
      <CodingLayoutReadFailure
        error={layoutError}
        onRetry={() => void refetchLayout()}
      />
    );
  }
  if (!workingDir) {
    return (
      <Empty
        variant="compact"
        label="Workspace directory needed"
        description="Set this Project’s working directory before opening a terminal."
      />
    );
  }
  return (
    <CodingTerminalPane
      presentation="pane"
      projectSlug={projectSlug}
      workingDir={workingDir}
    />
  );
}

function WorkspacePlanPane({ instance }: BuiltinWorkspacePaneProps) {
  const identity = useResolvedPaneIdentity(instance, false);
  const projectSlug =
    identity.state === 'resolved' ? identity.project.slug : '';
  const { activeChat } = useNavigation();
  const projectSessions = useDerivedSessions('', null, projectSlug);
  const flow = useFlowDefinitionsQuery(projectSlug);
  const planSession = useMemo(
    () => selectWorkflowPlanSession(projectSessions, activeChat),
    [activeChat, projectSessions],
  );
  const artifact = useMemo(
    () =>
      toWorkflowPlanArtifact(planSession?.planArtifact) ??
      deriveWorkflowPlanArtifact(planSession?.messages || []),
    [planSession],
  );
  const runtimeState = useMemo(
    () => ({
      status: planSession?.orchestrationStatus ?? planSession?.status ?? null,
      pendingApprovals: planSession?.pendingApprovals?.length ?? 0,
      isProcessingStep: planSession?.isProcessingStep ?? false,
    }),
    [planSession],
  );

  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  if (!isCanonicalWorkspacePlanPaneInstance(instance))
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );
  return (
    <WorkflowPlanInspectorContent
      projectSlug={projectSlug}
      artifact={artifact}
      sessionTitle={planSession?.title ?? null}
      runtimeState={runtimeState}
      configured={Boolean(flow.data?.initialized)}
    />
  );
}

function WorkspaceReadinessPane({ instance }: BuiltinWorkspacePaneProps) {
  const identity = useResolvedPaneIdentity(instance, false);
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  if (!isCanonicalWorkspaceReadinessPaneInstance(instance))
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );
  return <ReadinessInspectorContent projectSlug={identity.project.slug} />;
}

function WorkspaceTrustPane({ instance }: BuiltinWorkspacePaneProps) {
  const identity = useResolvedPaneIdentity(instance, false);
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  if (!isCanonicalWorkspaceTrustPaneInstance(instance))
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-instance-invalid' }}
      />
    );
  return <TrustInspectorContent projectSlug={identity.project.slug} />;
}

function FilePreviewWorkspacePane({ instance }: BuiltinWorkspacePaneProps) {
  const identity = useResolvedPaneIdentity(instance, false);
  const state = readFilePreviewPaneState(
    window.localStorage,
    instance.stateKey,
  );
  if (identity.state !== 'resolved')
    return <WorkspacePaneBindingUnavailable identity={identity} />;
  if (
    !state ||
    !isCanonicalFilePreviewPaneInstance(instance, state) ||
    state.projectSlug !== identity.project.slug
  )
    return (
      <WorkspacePaneBindingUnavailable
        identity={{ state: 'pane-state-mismatch' }}
      />
    );
  return (
    <Suspense
      fallback={
        <SkeletonBlock count={3} label="Loading bounded file preview" />
      }
    >
      <LazyFilePreviewPane
        projectSlug={identity.project.slug}
        stateKey={instance.stateKey}
        state={state}
      />
    </Suspense>
  );
}

const LazyHomeWorkspacePane = lazy(() =>
  import('../views/home/HomeWorkspacePane').then(({ HomeWorkspacePane }) => ({
    default: HomeWorkspacePane,
  })),
);

const LazyActivityWorkspacePane = lazy(() =>
  import('../views/activity/ActivityWorkspacePane').then(
    ({ ActivityWorkspacePane }) => ({
      default: ActivityWorkspacePane,
    }),
  ),
);

const LazyBoardWorkspacePane = lazy(() =>
  import('../views/board/BoardWorkspacePane').then(
    ({ BoardWorkspacePane }) => ({
      default: BoardWorkspacePane,
    }),
  ),
);

const LazySpatialBoardWorkspacePane = lazy(() =>
  import('./SpatialBoardWorkspacePane').then(
    ({ SpatialBoardWorkspacePane }) => ({
      default: SpatialBoardWorkspacePane,
    }),
  ),
);

// Basis is a task-local disclosure pane. Keep its Surface viewer and SDK
// dependencies out of every workspace host that merely enumerates built-ins.
const LazyBasisWorkspacePane = lazy(() =>
  import('./BasisWorkspacePane').then(({ BasisWorkspacePane }) => ({
    default: BasisWorkspacePane,
  })),
);

function BasisWorkspacePaneEntry(props: BuiltinWorkspacePaneProps) {
  return (
    <Suspense fallback={<SkeletonBlock count={3} label="Loading Basis" />}>
      <LazyBasisWorkspacePane {...props} />
    </Suspense>
  );
}

function SpatialBoardWorkspacePaneEntry(props: BuiltinWorkspacePaneProps) {
  if (!isCanonicalWorkspaceSpatialBoardPaneInstance(props.instance))
    return (
      <ErrorState
        title="Work Board is unavailable"
        description="This pane isn’t set up as the Work Board."
      />
    );
  return (
    <Suspense fallback={<SkeletonBlock count={3} label="Loading Work Board" />}>
      <LazySpatialBoardWorkspacePane {...props} />
    </Suspense>
  );
}

// Home binds no Project, so it never consults `useWorkspacePaneBoundIdentity`
// there is no captured identity to resolve. Its own renderer still refuses
// a non-canonical occurrence. It is lazy for the same reason the file preview
// is: Home is the root route's own chunk, and a Project host that never
// mounts Home should not download it to have it in the table.
function HomeWorkspacePaneEntry(props: BuiltinWorkspacePaneProps) {
  return (
    <Suspense fallback={<SkeletonBlock count={3} label="Loading Home" />}>
      <LazyHomeWorkspacePane {...props} />
    </Suspense>
  );
}

// Activity binds no Project either (its list aggregates every host session),
// so it never consults `useWorkspacePaneBoundIdentity`; its own renderer
// still refuses a non-canonical occurrence. Lazy for the same reason Home
// is: the sessions surface is Activity's own chunk, and a host
// that never mounts Activity should not download it to have it in the table.
function ActivityWorkspacePaneEntry(props: BuiltinWorkspacePaneProps) {
  return (
    <Suspense fallback={<SkeletonBlock count={3} label="Loading Activity" />}>
      <LazyActivityWorkspacePane {...props} />
    </Suspense>
  );
}

// The Console Board (archive#4142): the component lives in
// `@kontourai/station-board-pane`, and this lazy entry — via the wrapper
// that supplies its shell affordances — is core's ONE import of that
// package's component (`board-surface-single-mounter.test.ts`). Lazy for
// the same reason Home and Activity are: the Board is its own route's
// chunk (Console Kit's BoardView and board.css ride in it), and a host
// that never mounts it should not download it to have it in the table.
function BoardWorkspacePaneEntry(props: BuiltinWorkspacePaneProps) {
  return (
    <Suspense fallback={<SkeletonBlock count={3} label="Loading the Board" />}>
      <LazyBoardWorkspacePane {...props} />
    </Suspense>
  );
}

const builtinWorkspacePaneRegistry: Record<
  BuiltinWorkspacePaneRendererName,
  BuiltinWorkspacePaneComponent
> = {
  'flow-run-console': FlowRunConsolePane,
  [WORKSPACE_CHAT_PANE_RENDERER_NAME]: ChatPane,
  [WORKSPACE_TASK_ROOM_EDITOR_RENDERER_NAME]: TaskRoomEditor,
  coding: CodingPane,
  [WORKSPACE_CODING_FILE_BROWSER_PANE_RENDERER_NAME]: CodingFileBrowserPane,
  [WORKSPACE_CODING_DIFF_PANE_RENDERER_NAME]: CodingDiffPane,
  [WORKSPACE_CODING_TERMINAL_PANE_RENDERER_NAME]: CodingTerminalWorkspacePane,
  [WORKSPACE_PLAN_PANE_RENDERER_NAME]: WorkspacePlanPane,
  [WORKSPACE_READINESS_PANE_RENDERER_NAME]: WorkspaceReadinessPane,
  [WORKSPACE_TRUST_PANE_RENDERER_NAME]: WorkspaceTrustPane,
  [WORKSPACE_BROWSER_PREVIEW_PANE_RENDERER_NAME]: BrowserPreviewWorkspacePane,
  [WORKSPACE_FILE_PREVIEW_PANE_RENDERER_NAME]: FilePreviewWorkspacePane,
  [WORKSPACE_HOME_PANE_RENDERER_NAME]: HomeWorkspacePaneEntry,
  [WORKSPACE_ACTIVITY_PANE_RENDERER_NAME]: ActivityWorkspacePaneEntry,
  [WORKSPACE_SPATIAL_BOARD_PANE_RENDERER_NAME]: SpatialBoardWorkspacePaneEntry,
  [WORKSPACE_BOARD_PANE_RENDERER_NAME]: BoardWorkspacePaneEntry,
  [WORKSPACE_BASIS_PANE_RENDERER_NAME]: BasisWorkspacePaneEntry,
};

/** The host admits only direct, stable built-ins; plugin and MCP hosting wait for their own boundary. */
export function getBuiltinWorkspacePaneRenderer(
  descriptor: WorkspacePaneDescriptor,
  instance?: WorkspacePaneInstance,
): BuiltinWorkspacePaneComponent | null {
  if (descriptor.renderer.kind !== 'builtin-component') return null;
  if (!isCanonicalBuiltinWorkspacePaneDescriptor(descriptor, instance)) {
    return null;
  }
  return (
    builtinWorkspacePaneRegistry[
      descriptor.renderer.name as BuiltinWorkspacePaneRendererName
    ] ?? null
  );
}
