import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import type {
  WorkspacePaneAvailability,
  WorkspacePaneAvailabilityAction,
  WorkspacePaneAvailabilityReasonCode,
  WorkspacePaneAvailabilityState,
} from '@kontourai/station-contracts/workspace-pane-availability';

/**
 * The catalog record consumed by availability presentations. The host joins
 * the resolver's availability result to its known descriptor and instance;
 * this component never infers a pane's renderer, host, or authorization.
 */
export interface WorkspacePaneAvailabilityCatalogEntry {
  descriptor: Pick<
    WorkspacePaneDescriptor,
    'id' | 'name' | 'description' | 'icon' | 'previewImage'
  > &
    /**
     * #765 F4: optional so hosts joining partial descriptor projections keep
     * compiling; when the full descriptor flows through (the resolved
     * catalog), the card uses it to pick the built-in pane's real tile glyph
     * instead of a first-letter placeholder. Display-only, exactly like
     * `icon`/`previewImage` — never used to infer host or authorization.
     */
    Partial<Pick<WorkspacePaneDescriptor, 'renderer'>>;
  /** Present only after this descriptor has a real placed occurrence. */
  instance?: Pick<WorkspacePaneInstance, 'instanceId'>;
  availability: WorkspacePaneAvailability;
  /** A UI-local registry fact; it never changes the availability contract. */
  rendererGate?: 'remote-isolation';
}

export interface WorkspacePaneAvailabilityPresentation {
  state: WorkspacePaneAvailabilityState;
  stateLabel: string;
  reasonCode: WorkspacePaneAvailabilityReasonCode;
  reasonLabel: string;
  action?: WorkspacePaneAvailabilityAction;
  actionLabel?: string;
  reviewInRegistry?: boolean;
}

const STATE_LABELS: Record<WorkspacePaneAvailabilityState, string> = {
  available: 'Available',
  'coming-soon': 'Coming soon',
  'not-configured': 'Setup needed',
  unsupported: 'Not supported here',
  'permission-required': 'Permission needed',
  'temporarily-unavailable': 'Temporarily unavailable',
};

const REASON_LABELS: Record<WorkspacePaneAvailabilityReasonCode, string> = {
  ready: 'This pane is ready to open.',
  'coming-soon': 'This pane has not rolled out yet.',
  'rollout-unknown': 'This pane’s rollout status has not been confirmed.',
  'installation-pending':
    'Plugin activation is pending. Review recovery in Plugins.',
  'installation-unavailable':
    'The plugin installation is unavailable. Check its status in Plugins.',
  'distribution-disabled': 'This pane is disabled by its distribution policy.',
  'distribution-policy-unknown':
    'This pane’s distribution policy has not been confirmed.',
  'unsupported-host': 'This host does not support this pane.',
  'host-capability-unknown': 'Host support for this pane is not confirmed.',
  'unsupported-deployment': 'This deployment does not support this pane.',
  'deployment-capability-unknown':
    'Deployment support for this pane is not confirmed.',
  'renderer-missing': 'The pane renderer is currently unavailable.',
  'renderer-unknown': 'The pane renderer has not been confirmed.',
  'missing-project': 'Choose a Project before opening this pane.',
  'missing-task': 'Choose a Task before opening this pane.',
  'missing-workspace': 'Choose a workspace before opening this pane.',
  'missing-git-repository': 'Choose a Git repository before opening this pane.',
  'context-unknown': 'Required workspace context has not been confirmed.',
  'configuration-missing':
    'Complete this pane’s configuration before opening it.',
  'configuration-unknown': 'This pane’s configuration has not been confirmed.',
  'permission-required':
    'Grant the required permission before opening this pane.',
  'permission-unknown': 'Permission for this pane has not been confirmed.',
  'health-unavailable':
    'The pane is temporarily unavailable. Try again shortly.',
  'health-unknown': 'The pane’s current health has not been confirmed.',
};

const ACTION_LABELS: Record<WorkspacePaneAvailabilityAction['code'], string> = {
  'enable-distribution': 'Enable pane',
  'select-project': 'Select Project',
  'select-task': 'Select Task',
  'select-workspace': 'Select workspace',
  'select-git-repository': 'Select Git repository',
  'complete-configuration': 'Complete setup',
  'request-permission': 'Request permission',
  'retry-availability-check': 'Check again',
  'view-rollout': 'Learn about rollout',
  'view-distribution-policy': 'View distribution policy',
  'view-context-requirements': 'View context requirements',
  'view-configuration-requirements': 'View setup requirements',
  'view-host-requirements': 'View host requirements',
  'view-deployment-requirements': 'View deployment requirements',
  'view-renderer-requirements': 'View renderer requirements',
  'view-permission-requirements': 'View permission requirements',
};

/**
 * Turns an authoritative, bounded availability result into shared copy. No
 * host diagnostics, paths, URLs, or renderer details enter this projection.
 */
export function presentWorkspacePaneAvailability(
  availability: WorkspacePaneAvailability,
  rendererGate?: WorkspacePaneAvailabilityCatalogEntry['rendererGate'],
): WorkspacePaneAvailabilityPresentation {
  const extensionsDisabled =
    rendererGate === 'remote-isolation' &&
    (availability.reason.code === 'renderer-missing' ||
      availability.reason.code === 'renderer-unknown');
  if (extensionsDisabled) {
    return {
      state: availability.state,
      stateLabel: 'Extensions are disabled for this Station',
      reasonCode: availability.reason.code,
      reasonLabel:
        'Remote extensions are off for this Station on this device — you can turn them on from the Registry, which explains the trade-off first.',
      reviewInRegistry: true,
    };
  }
  return {
    state: availability.state,
    stateLabel: STATE_LABELS[availability.state],
    reasonCode: availability.reason.code,
    reasonLabel: REASON_LABELS[availability.reason.code],
    action: availability.action,
    actionLabel: availability.action
      ? ACTION_LABELS[availability.action.code]
      : undefined,
  };
}
