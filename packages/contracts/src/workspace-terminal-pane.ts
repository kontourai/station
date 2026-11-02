import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

/**
 * One terminal session as its own dock pane: the closed built-in target a
 * plugin opens through related panes (docs/design/terminal.md, "Plugins").
 * The id is `terminal-pane:<nonce>`; which session it shows is the
 * occurrence's stored record, written by the host when it opens one.
 */
export const WORKSPACE_TERMINAL_PANE_DESCRIPTOR_ID =
  'pane:builtin:workspace-terminal';
export const WORKSPACE_TERMINAL_PANE_RENDERER_NAME = 'workspace-terminal';
export const WORKSPACE_TERMINAL_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-terminal';
export const WORKSPACE_TERMINAL_PANE_INSTANCE_PATTERN =
  /^terminal-pane:[0-9a-f]{32}$/;

const parsed = parseWorkspacePaneDescriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_TERMINAL_PANE_DESCRIPTOR_ID,
  name: 'Terminal session',
  description: 'One terminal session, opened beside the pane that asked.',
  rendererId: WORKSPACE_TERMINAL_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_TERMINAL_PANE_RENDERER_NAME,
  },
  placement: { supportedRegions: ['docked'], preferredRegion: 'docked' },
  modes: [{ id: 'default', contextRequirement: { project: true } }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});
if (!parsed)
  throw new Error('Canonical terminal pane descriptor must be valid');
export const WORKSPACE_TERMINAL_PANE_DESCRIPTOR = parsed;

/** The occurrence `id` names, bound to the Project its session belongs to. */
export function createWorkspaceTerminalPaneInstance(
  id: string,
  projectId: string,
): WorkspacePaneInstance | null {
  if (
    !WORKSPACE_TERMINAL_PANE_INSTANCE_PATTERN.test(id) ||
    !projectId ||
    projectId !== projectId.trim()
  )
    return null;
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_TERMINAL_PANE_DESCRIPTOR_ID,
    instanceId: id,
    stateKey: id,
    boundContext: { projectId },
  });
}

export function isCanonicalWorkspaceTerminalPaneInstance(
  candidate: WorkspacePaneInstance,
): boolean {
  const context = candidate.boundContext;
  return (
    candidate.version === WORKSPACE_PANE_CONTRACT_VERSION &&
    candidate.descriptorId === WORKSPACE_TERMINAL_PANE_DESCRIPTOR_ID &&
    WORKSPACE_TERMINAL_PANE_INSTANCE_PATTERN.test(candidate.instanceId) &&
    String(candidate.stateKey) === String(candidate.instanceId) &&
    typeof context?.projectId === 'string' &&
    context.projectId.length > 0 &&
    Object.keys(context).length === 1
  );
}
