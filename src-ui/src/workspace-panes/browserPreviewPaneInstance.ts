import {
  parseWorkspaceBrowserPreviewPaneState,
  WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR,
  WORKSPACE_BROWSER_PREVIEW_PANE_SOURCE_ID,
  type WorkspaceBrowserPreviewPaneState,
} from '@kontourai/station-contracts/workspace-browser-preview';
import {
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import type { BrowserPreviewPaneStateStorage } from './browserPreviewPaneStateStorage';
import {
  readBrowserPreviewPaneState,
  removeBrowserPreviewPaneState,
} from './browserPreviewPaneStateStorage';

const BROWSER_PREVIEW_NONCE_PATTERN = /^[0-9a-f]{32}$/;

function randomNonce(): string | null {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID().replaceAll('-', '');
  }
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) return null;
  const values = new Uint8Array(16);
  crypto.getRandomValues(values);
  return Array.from(values, (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}

export function createBrowserPreviewPaneInstance(
  state: WorkspaceBrowserPreviewPaneState,
  projectId: string,
  nonce?: string,
): WorkspacePaneInstance | null {
  const normalized = parseWorkspaceBrowserPreviewPaneState(state);
  const opaqueNonce = nonce ?? randomNonce();
  if (
    !normalized ||
    normalized.projectId !== projectId ||
    !opaqueNonce ||
    !BROWSER_PREVIEW_NONCE_PATTERN.test(opaqueNonce)
  ) {
    return null;
  }
  const identity = `browser-preview:${opaqueNonce}`;
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR.id,
    instanceId: identity,
    stateKey: identity,
    boundContext: {
      projectId,
      sourceId: WORKSPACE_BROWSER_PREVIEW_PANE_SOURCE_ID,
    },
  });
}

export function isCanonicalBrowserPreviewPaneInstance(
  instance: WorkspacePaneInstance,
  state: WorkspaceBrowserPreviewPaneState | null,
): boolean {
  const identity = String(instance.instanceId);
  const context = instance.boundContext;
  return (
    !!state?.projectId &&
    instance.descriptorId === WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR.id &&
    identity === instance.stateKey &&
    identity.startsWith('browser-preview:') &&
    BROWSER_PREVIEW_NONCE_PATTERN.test(
      identity.slice('browser-preview:'.length),
    ) &&
    isCanonicalProjectContext(context) &&
    context.projectId === state.projectId &&
    context.sourceId === WORKSPACE_BROWSER_PREVIEW_PANE_SOURCE_ID &&
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

export function admitRestoredBrowserPreviewPaneInstance(
  projectId: string,
  candidate: unknown,
  storage: BrowserPreviewPaneStateStorage,
): WorkspacePaneInstance | null {
  const instance = parseWorkspacePaneInstance(candidate);
  if (!instance) return null;
  const state = readBrowserPreviewPaneState(storage, instance.stateKey);
  return instance.boundContext?.projectId === projectId &&
    isCanonicalBrowserPreviewPaneInstance(instance, state)
    ? instance
    : null;
}

/**
 * Returns a stable, non-sensitive tab label. The local URL is deliberately not
 * exposed in pane chrome because the host has not verified renderer navigation.
 */
export function browserPreviewPanePresentationLabel(
  projectId: string,
  instance: WorkspacePaneInstance,
  storage: BrowserPreviewPaneStateStorage,
): string | null {
  const state = readBrowserPreviewPaneState(storage, instance.stateKey);
  return instance.boundContext?.projectId === projectId &&
    isCanonicalBrowserPreviewPaneInstance(instance, state)
    ? 'Browser Preview'
    : null;
}

export function removeRemovedBrowserPreviewPaneState(
  projectId: string,
  instance: WorkspacePaneInstance,
  storage: BrowserPreviewPaneStateStorage,
): boolean {
  const state = readBrowserPreviewPaneState(storage, instance.stateKey);
  if (
    instance.boundContext?.projectId !== projectId ||
    !isCanonicalBrowserPreviewPaneInstance(instance, state)
  ) {
    return false;
  }
  return removeBrowserPreviewPaneState(storage, instance.stateKey);
}
