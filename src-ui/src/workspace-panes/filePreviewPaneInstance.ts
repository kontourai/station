import {
  parseWorkspaceFilePreviewPaneState,
  WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR,
  WORKSPACE_FILE_PREVIEW_PANE_SOURCE_ID,
  WORKSPACE_FILE_PREVIEW_PANE_VERSION,
  type WorkspaceFilePreviewPaneState,
} from '@kontourai/station-contracts/workspace-file-preview';
import {
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import {
  type FilePreviewPaneStateStorage,
  readFilePreviewPaneState,
  removeUnreferencedFilePreviewPaneState,
} from './filePreviewPaneStateStorage';

export const FILE_PREVIEW_PANE_DESCRIPTOR =
  WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR;

const FILE_PREVIEW_NONCE_PATTERN = /^[0-9a-f]{32}$/;

function randomNonce(): string | null {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID().replaceAll('-', '');
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) return null;
  const values = new Uint8Array(16);
  crypto.getRandomValues(values);
  return Array.from(values, (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

export function createFilePreviewPaneInstance(
  state: WorkspaceFilePreviewPaneState,
  projectId: string,
  nonce?: string,
): WorkspacePaneInstance | null {
  const normalized = parseWorkspaceFilePreviewPaneState(state);
  const opaqueNonce = nonce ?? randomNonce();
  if (
    !normalized ||
    !projectId ||
    projectId !== projectId.trim() ||
    !opaqueNonce ||
    !FILE_PREVIEW_NONCE_PATTERN.test(opaqueNonce)
  )
    return null;
  const identity = `file-preview:${opaqueNonce}`;
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: FILE_PREVIEW_PANE_DESCRIPTOR.id,
    instanceId: identity,
    stateKey: identity,
    boundContext: {
      projectId,
      sourceId: WORKSPACE_FILE_PREVIEW_PANE_SOURCE_ID,
    },
  });
}

export function isCanonicalFilePreviewPaneInstance(
  instance: WorkspacePaneInstance,
  state: WorkspaceFilePreviewPaneState | null,
): boolean {
  const identity = String(instance.instanceId);
  const context = instance.boundContext;
  return (
    state?.version === WORKSPACE_FILE_PREVIEW_PANE_VERSION &&
    instance.descriptorId === FILE_PREVIEW_PANE_DESCRIPTOR.id &&
    identity === instance.stateKey &&
    identity.startsWith('file-preview:') &&
    FILE_PREVIEW_NONCE_PATTERN.test(identity.slice('file-preview:'.length)) &&
    isCanonicalProjectContext(context) &&
    context.sourceId === WORKSPACE_FILE_PREVIEW_PANE_SOURCE_ID &&
    context.workspaceId === undefined &&
    context.taskId === undefined &&
    context.sessionId === undefined &&
    context.runId === undefined &&
    Object.keys(context).length === (context.layoutId === undefined ? 2 : 3)
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

/**
 * Restored host data can add only this code-owned builtin shape. The persisted
 * record never gets to select a renderer: its state key merely selects a
 * separately strict, project-scoped data record.
 */
export function admitRestoredFilePreviewPaneInstance(
  projectId: string,
  projectSlug: string,
  candidate: unknown,
  storage: FilePreviewPaneStateStorage,
): WorkspacePaneInstance | null {
  const instance = parseWorkspacePaneInstance(candidate);
  if (!instance) return null;
  const state = readFilePreviewPaneState(storage, instance.stateKey);
  return state?.projectSlug === projectSlug &&
    instance.boundContext?.projectId === projectId &&
    isCanonicalFilePreviewPaneInstance(instance, state)
    ? instance
    : null;
}

export function filePreviewPanePresentationLabel(
  projectId: string,
  projectSlug: string,
  instance: WorkspacePaneInstance,
  storage: FilePreviewPaneStateStorage,
): string | null {
  const state = readFilePreviewPaneState(storage, instance.stateKey);
  if (
    state?.projectSlug !== projectSlug ||
    instance.boundContext?.projectId !== projectId ||
    !isCanonicalFilePreviewPaneInstance(instance, state)
  )
    return null;
  const prefix = 'File Preview — ';
  const available = 160 - prefix.length;
  const path = state!.path;
  return `${prefix}${
    path.length <= available ? path : `…${path.slice(-(available - 1))}`
  }`;
}

/** Called only after the host has removed and lifecycle-tombstoned an instance. */
export function removeRemovedFilePreviewPaneState(
  projectId: string,
  projectSlug: string,
  instance: WorkspacePaneInstance,
  storage: FilePreviewPaneStateStorage,
): boolean {
  const state = readFilePreviewPaneState(storage, instance.stateKey);
  return state?.projectSlug === projectSlug &&
    instance.boundContext?.projectId === projectId &&
    isCanonicalFilePreviewPaneInstance(instance, state)
    ? removeUnreferencedFilePreviewPaneState(storage, instance.stateKey)
    : false;
}
