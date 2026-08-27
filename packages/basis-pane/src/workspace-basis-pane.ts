import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';

export const WORKSPACE_BASIS_PANE_DESCRIPTOR_ID = 'pane:builtin:basis';
export const WORKSPACE_BASIS_PANE_RENDERER_NAME = 'workspace-basis';
export const WORKSPACE_BASIS_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-basis';
export const WORKSPACE_BASIS_DIRECT_SOURCE_ID =
  'builtin:workspace-basis:direct';
export const WORKSPACE_BASIS_TASK_ANSWER_SOURCE_ID =
  'builtin:workspace-basis:task-answer';
export const WORKSPACE_BASIS_WHOLE_TASK_SOURCE_ID =
  'builtin:workspace-basis:whole-task';

const parsed = parseWorkspacePaneDescriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_BASIS_PANE_DESCRIPTOR_ID,
  name: 'Basis',
  description:
    'What this answer or Task stands on, including current gaps and context.',
  rendererId: WORKSPACE_BASIS_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_BASIS_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['primary', 'secondary', 'standalone'],
    preferredRegion: 'secondary',
  },
  modes: [
    { id: 'answer', contextRequirement: { session: true } },
    { id: 'task', contextRequirement: { project: true, task: true } },
    {
      id: 'session-inventory',
      contextRequirement: { project: true, session: true },
    },
  ],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});
if (!parsed) throw new Error('Canonical Basis Workspace Pane must be valid');
export const WORKSPACE_BASIS_PANE_DESCRIPTOR: WorkspacePaneDescriptor = parsed;

const MAX_IDENTITY_LENGTH = 1024;

function isWellFormedIdentity(value: string): boolean {
  if (value.length === 0 || value.length > MAX_IDENTITY_LENGTH) return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

const component = (value: string): string | null =>
  isWellFormedIdentity(value)
    ? `${value.length}:${encodeURIComponent(value)}`
    : null;
const occurrence = (kind: string, values: readonly string[]): string | null => {
  const components = values.map(component);
  return components.some((value) => value === null)
    ? null
    : `basis:${kind}:${components.join('|')}`;
};

function createInstance(
  instanceId: string,
  stateKey: string,
  boundContext: WorkspacePaneInstance['boundContext'],
): WorkspacePaneInstance | null {
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_BASIS_PANE_DESCRIPTOR_ID,
    instanceId,
    stateKey,
    boundContext,
  });
}

export function createDirectAnswerBasisPaneInstance(
  projectId: string,
  sessionId: string,
  turnId: string,
): WorkspacePaneInstance | null {
  const identity = occurrence('direct', [projectId, sessionId, turnId]);
  if (!identity) return null;
  return createInstance(identity, identity, {
    projectId,
    sessionId,
    turnId,
    sourceId: WORKSPACE_BASIS_DIRECT_SOURCE_ID,
  });
}

export function createTaskAnswerBasisPaneInstance(
  projectId: string,
  taskId: string,
  answerReferenceId: string,
): WorkspacePaneInstance | null {
  const identity = occurrence('task-answer', [
    projectId,
    taskId,
    answerReferenceId,
  ]);
  if (!identity) return null;
  return createInstance(identity, identity, {
    projectId,
    taskId,
    answerReferenceId,
    sourceId: WORKSPACE_BASIS_TASK_ANSWER_SOURCE_ID,
  });
}

export function createWholeTaskBasisPaneInstance(
  projectId: string,
  taskId: string,
): WorkspacePaneInstance | null {
  const identity = occurrence('whole-task', [projectId, taskId]);
  if (!identity) return null;
  return createInstance(identity, identity, {
    projectId,
    taskId,
    sourceId: WORKSPACE_BASIS_WHOLE_TASK_SOURCE_ID,
  });
}

export function createSessionInventoryBasisPaneInstance(
  projectId: string,
  sessionId: string,
): WorkspacePaneInstance | null {
  const identity = occurrence('session-inventory', [projectId, sessionId]);
  if (!identity) return null;
  return createInstance(identity, identity, {
    projectId,
    sessionId,
    sourceId: WORKSPACE_BASIS_SESSION_INVENTORY_SOURCE_ID,
  });
}

export function isCanonicalBasisWorkspacePaneInstance(
  instance: WorkspacePaneInstance,
): boolean {
  const context = instance.boundContext;
  if (!context) return false;
  const expected =
    context.projectId && context.sessionId && context.turnId
      ? createDirectAnswerBasisPaneInstance(
          context.projectId,
          context.sessionId,
          context.turnId,
        )
      : context.projectId && context.taskId && context.answerReferenceId
        ? createTaskAnswerBasisPaneInstance(
            context.projectId,
            context.taskId,
            context.answerReferenceId,
          )
        : context.projectId && context.taskId
          ? createWholeTaskBasisPaneInstance(context.projectId, context.taskId)
          : context.projectId && context.sessionId
            ? createSessionInventoryBasisPaneInstance(
                context.projectId,
                context.sessionId,
              )
            : null;
  return Boolean(
    expected &&
      instance.descriptorId === expected.descriptorId &&
      instance.instanceId === expected.instanceId &&
      instance.stateKey === expected.stateKey &&
      JSON.stringify(instance.boundContext) ===
        JSON.stringify(expected.boundContext),
  );
}

export function isCanonicalBasisWorkspacePaneDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  const exactKeys = (value: object, keys: readonly string[]) => {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length &&
      actual.every((key, index) => key === expected[index])
    );
  };
  const [answerMode, taskMode, sessionInventoryMode] = descriptor.modes;
  return (
    exactKeys(descriptor, [
      'version',
      'id',
      'name',
      'description',
      'rendererId',
      'renderer',
      'placement',
      'modes',
      'provenance',
      'lifecycle',
    ]) &&
    exactKeys(descriptor.renderer, ['kind', 'name']) &&
    exactKeys(descriptor.placement, ['supportedRegions', 'preferredRegion']) &&
    exactKeys(descriptor.provenance, ['origin']) &&
    exactKeys(descriptor.lifecycle, ['stage']) &&
    descriptor.modes.length === 3 &&
    Boolean(
      answerMode &&
        taskMode &&
        sessionInventoryMode &&
        exactKeys(answerMode, ['id', 'contextRequirement']) &&
        exactKeys(taskMode, ['id', 'contextRequirement']) &&
        exactKeys(sessionInventoryMode, ['id', 'contextRequirement']) &&
        answerMode.contextRequirement &&
        taskMode.contextRequirement &&
        sessionInventoryMode.contextRequirement &&
        exactKeys(answerMode.contextRequirement, ['session']) &&
        exactKeys(taskMode.contextRequirement, ['project', 'task']) &&
        exactKeys(sessionInventoryMode.contextRequirement, [
          'project',
          'session',
        ]),
    ) &&
    descriptor.version === WORKSPACE_BASIS_PANE_DESCRIPTOR.version &&
    descriptor.id === WORKSPACE_BASIS_PANE_DESCRIPTOR_ID &&
    descriptor.name === WORKSPACE_BASIS_PANE_DESCRIPTOR.name &&
    descriptor.description === WORKSPACE_BASIS_PANE_DESCRIPTOR.description &&
    descriptor.rendererId === WORKSPACE_BASIS_PANE_RENDERER_ID &&
    descriptor.renderer.kind === 'builtin-component' &&
    descriptor.renderer.name === WORKSPACE_BASIS_PANE_RENDERER_NAME &&
    descriptor.placement.preferredRegion === 'secondary' &&
    descriptor.placement.supportedRegions.join('|') ===
      WORKSPACE_BASIS_PANE_DESCRIPTOR.placement.supportedRegions.join('|') &&
    answerMode?.id === 'answer' &&
    answerMode.contextRequirement?.session === true &&
    taskMode?.id === 'task' &&
    taskMode.contextRequirement?.project === true &&
    taskMode.contextRequirement?.task === true &&
    sessionInventoryMode?.id === 'session-inventory' &&
    sessionInventoryMode.contextRequirement?.project === true &&
    sessionInventoryMode.contextRequirement?.session === true &&
    descriptor.provenance.origin === 'builtin' &&
    descriptor.lifecycle.stage === 'preview'
  );
}
const WORKSPACE_BASIS_SESSION_INVENTORY_SOURCE_ID =
  'builtin:workspace-basis:session-inventory';
