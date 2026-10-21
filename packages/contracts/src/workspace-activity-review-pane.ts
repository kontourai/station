import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

export const WORKSPACE_ACTIVITY_REVIEW_PANE_DESCRIPTOR_ID =
  'pane:builtin:activity-review';
export const WORKSPACE_ACTIVITY_REVIEW_PANE_RENDERER_NAME =
  'workspace-activity-review';
export const WORKSPACE_ACTIVITY_REVIEW_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-activity-review';
export const WORKSPACE_ACTIVITY_REVIEW_PANE_INSTANCE_PATTERN =
  /^activity-review:[0-9a-f]{32}$/;

const parsed = parseWorkspacePaneDescriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_ACTIVITY_REVIEW_PANE_DESCRIPTOR_ID,
  name: 'Activity review',
  description: 'Review one captured Activity item beside its source.',
  rendererId: WORKSPACE_ACTIVITY_REVIEW_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_ACTIVITY_REVIEW_PANE_RENDERER_NAME,
  },
  placement: { supportedRegions: ['docked'], preferredRegion: 'docked' },
  modes: [{ id: 'default' }],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});
if (!parsed)
  throw new Error('Canonical Activity review pane descriptor must be valid');
export const WORKSPACE_ACTIVITY_REVIEW_PANE_DESCRIPTOR = parsed;

export function createWorkspaceActivityReviewPaneInstance(
  id: string,
): WorkspacePaneInstance | null {
  if (!WORKSPACE_ACTIVITY_REVIEW_PANE_INSTANCE_PATTERN.test(id)) return null;
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_ACTIVITY_REVIEW_PANE_DESCRIPTOR_ID,
    instanceId: id,
    stateKey: id,
  });
}

export function isCanonicalWorkspaceActivityReviewPaneInstance(
  candidate: WorkspacePaneInstance,
): boolean {
  return (
    candidate.version === WORKSPACE_PANE_CONTRACT_VERSION &&
    candidate.descriptorId === WORKSPACE_ACTIVITY_REVIEW_PANE_DESCRIPTOR_ID &&
    WORKSPACE_ACTIVITY_REVIEW_PANE_INSTANCE_PATTERN.test(
      candidate.instanceId,
    ) &&
    String(candidate.stateKey) === String(candidate.instanceId) &&
    candidate.boundContext === undefined
  );
}
