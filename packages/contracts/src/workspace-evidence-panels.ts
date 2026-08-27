import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

export const WORKSPACE_PLAN_PANE_DESCRIPTOR_ID = 'pane:builtin:evidence:plan';
export const WORKSPACE_PLAN_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-plan';
export const WORKSPACE_PLAN_PANE_RENDERER_NAME = 'workspace-plan';
export const WORKSPACE_PLAN_PANE_SOURCE_ID = 'builtin:workspace-plan';
export const WORKSPACE_PLAN_PANE_INSTANCE_ID = 'workspace-plan';

export const WORKSPACE_READINESS_PANE_DESCRIPTOR_ID =
  'pane:builtin:evidence:readiness';
export const WORKSPACE_READINESS_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-readiness';
export const WORKSPACE_READINESS_PANE_RENDERER_NAME = 'workspace-readiness';
export const WORKSPACE_READINESS_PANE_SOURCE_ID = 'builtin:workspace-readiness';
export const WORKSPACE_READINESS_PANE_INSTANCE_ID = 'workspace-readiness';

export const WORKSPACE_TRUST_PANE_DESCRIPTOR_ID = 'pane:builtin:evidence:trust';
export const WORKSPACE_TRUST_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-trust';
export const WORKSPACE_TRUST_PANE_RENDERER_NAME = 'workspace-trust';
export const WORKSPACE_TRUST_PANE_SOURCE_ID = 'builtin:workspace-trust';
export const WORKSPACE_TRUST_PANE_INSTANCE_ID = 'workspace-trust';

function descriptor(value: unknown): WorkspacePaneDescriptor {
  const parsed = parseWorkspacePaneDescriptor(value);
  if (!parsed) throw new Error('Invalid built-in evidence Workspace Pane');
  return parsed;
}

function evidenceDescriptor(
  id: string,
  name: string,
  description: string,
  rendererId: string,
  rendererName: string,
): WorkspacePaneDescriptor {
  return descriptor({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    id,
    name,
    description,
    rendererId,
    renderer: { kind: 'builtin-component', name: rendererName },
    placement: {
      supportedRegions: ['primary', 'secondary', 'standalone'],
      preferredRegion: 'secondary',
    },
    // Plan observes the Project-selected conversation through the existing
    // navigation store. It never turns an absent Task or Flow run into pane
    // context; Readiness and Trust are likewise Project projections.
    modes: [{ id: 'default', contextRequirement: { project: true } }],
    provenance: { origin: 'builtin' },
    lifecycle: { stage: 'preview' },
  });
}

export const WORKSPACE_PLAN_PANE_DESCRIPTOR = evidenceDescriptor(
  WORKSPACE_PLAN_PANE_DESCRIPTOR_ID,
  'Plan',
  'Inspect the selected conversation’s Flow plan and delivery state.',
  WORKSPACE_PLAN_PANE_RENDERER_ID,
  WORKSPACE_PLAN_PANE_RENDERER_NAME,
);

export const WORKSPACE_READINESS_PANE_DESCRIPTOR = evidenceDescriptor(
  WORKSPACE_READINESS_PANE_DESCRIPTOR_ID,
  'Readiness',
  'Inspect Veritas merge readiness and its evidence for this Project.',
  WORKSPACE_READINESS_PANE_RENDERER_ID,
  WORKSPACE_READINESS_PANE_RENDERER_NAME,
);

export const WORKSPACE_TRUST_PANE_DESCRIPTOR = evidenceDescriptor(
  WORKSPACE_TRUST_PANE_DESCRIPTOR_ID,
  'Trust',
  'Inspect Surface trust bundles and reports for this Project.',
  WORKSPACE_TRUST_PANE_RENDERER_ID,
  WORKSPACE_TRUST_PANE_RENDERER_NAME,
);

function fixedEvidencePaneInstance(
  projectId: string,
  descriptorId: string,
  instanceId: string,
  sourceId: string,
): WorkspacePaneInstance | null {
  if (!projectId || projectId !== projectId.trim()) return null;
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId,
    instanceId,
    stateKey: instanceId,
    boundContext: { projectId, workspaceId: projectId, sourceId },
  });
}

export function createWorkspacePlanPaneInstance(
  projectId: string,
): WorkspacePaneInstance | null {
  return fixedEvidencePaneInstance(
    projectId,
    WORKSPACE_PLAN_PANE_DESCRIPTOR.id,
    WORKSPACE_PLAN_PANE_INSTANCE_ID,
    WORKSPACE_PLAN_PANE_SOURCE_ID,
  );
}

export function createWorkspaceReadinessPaneInstance(
  projectId: string,
): WorkspacePaneInstance | null {
  return fixedEvidencePaneInstance(
    projectId,
    WORKSPACE_READINESS_PANE_DESCRIPTOR.id,
    WORKSPACE_READINESS_PANE_INSTANCE_ID,
    WORKSPACE_READINESS_PANE_SOURCE_ID,
  );
}

export function createWorkspaceTrustPaneInstance(
  projectId: string,
): WorkspacePaneInstance | null {
  return fixedEvidencePaneInstance(
    projectId,
    WORKSPACE_TRUST_PANE_DESCRIPTOR.id,
    WORKSPACE_TRUST_PANE_INSTANCE_ID,
    WORKSPACE_TRUST_PANE_SOURCE_ID,
  );
}

function isCanonicalFixedEvidencePaneInstance(
  instance: WorkspacePaneInstance,
  descriptorId: string,
  instanceId: string,
  sourceId: string,
): boolean {
  const context = instance.boundContext;
  return (
    instance.descriptorId === descriptorId &&
    instance.instanceId === instanceId &&
    instance.stateKey === instanceId &&
    isCanonicalProjectContext(context) &&
    context.sourceId === sourceId &&
    context.workspaceId === context.projectId &&
    context.taskId === undefined &&
    context.sessionId === undefined &&
    context.runId === undefined &&
    Object.keys(context).length === 3 + (context.layoutId === undefined ? 0 : 1)
  );
}

function isCanonicalProjectContext(
  context: WorkspacePaneInstance['boundContext'],
): context is NonNullable<WorkspacePaneInstance['boundContext']> {
  return (
    typeof context?.projectId === 'string' &&
    context.projectId.length > 0 &&
    context.projectId === context.projectId.trim() &&
    (context.layoutId === undefined ||
      (typeof context.layoutId === 'string' &&
        context.layoutId.length > 0 &&
        context.layoutId === context.layoutId.trim()))
  );
}

export function isCanonicalWorkspacePlanPaneInstance(
  instance: WorkspacePaneInstance,
): boolean {
  return isCanonicalFixedEvidencePaneInstance(
    instance,
    WORKSPACE_PLAN_PANE_DESCRIPTOR.id,
    WORKSPACE_PLAN_PANE_INSTANCE_ID,
    WORKSPACE_PLAN_PANE_SOURCE_ID,
  );
}

export function isCanonicalWorkspaceReadinessPaneInstance(
  instance: WorkspacePaneInstance,
): boolean {
  return isCanonicalFixedEvidencePaneInstance(
    instance,
    WORKSPACE_READINESS_PANE_DESCRIPTOR.id,
    WORKSPACE_READINESS_PANE_INSTANCE_ID,
    WORKSPACE_READINESS_PANE_SOURCE_ID,
  );
}

export function isCanonicalWorkspaceTrustPaneInstance(
  instance: WorkspacePaneInstance,
): boolean {
  return isCanonicalFixedEvidencePaneInstance(
    instance,
    WORKSPACE_TRUST_PANE_DESCRIPTOR.id,
    WORKSPACE_TRUST_PANE_INSTANCE_ID,
    WORKSPACE_TRUST_PANE_SOURCE_ID,
  );
}
