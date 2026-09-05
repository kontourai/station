import type { WorkspacePaneContextRequirement } from './workspace-pane.js';

/**
 * The user-visible availability state for one known Workspace Pane. A result
 * is deliberately distinct from descriptor lifecycle and distribution data:
 * it is a current, host-neutral decision made from explicit authoritative
 * inputs, never proof that a renderer was installed or executed.
 */
export type WorkspacePaneAvailabilityState =
  | 'available'
  | 'coming-soon'
  | 'not-configured'
  | 'unsupported'
  | 'permission-required'
  | 'temporarily-unavailable';

/** The bounded evidence domain responsible for a resolution reason. */
export type WorkspacePaneAvailabilitySource =
  | 'resolver'
  | 'product-rollout'
  | 'distribution-policy'
  | 'native-host'
  | 'deployment'
  | 'renderer'
  | 'context'
  | 'configuration'
  | 'permission'
  | 'health';

/**
 * Stable, presentation-safe diagnostic codes. These codes intentionally do
 * not carry filesystem paths, credentials, URLs, or a host's raw error.
 */
export type WorkspacePaneAvailabilityReasonCode =
  | 'ready'
  | 'coming-soon'
  | 'rollout-unknown'
  | 'installation-pending'
  | 'installation-unavailable'
  | 'distribution-disabled'
  | 'distribution-policy-unknown'
  | 'unsupported-host'
  | 'host-capability-unknown'
  | 'unsupported-deployment'
  | 'deployment-capability-unknown'
  | 'renderer-missing'
  | 'renderer-unknown'
  | 'missing-project'
  | 'missing-task'
  | 'missing-workspace'
  | 'missing-git-repository'
  | 'context-unknown'
  | 'configuration-missing'
  | 'configuration-unknown'
  | 'permission-required'
  | 'permission-unknown'
  | 'health-unavailable'
  | 'health-unknown';

export interface WorkspacePaneAvailabilityReason {
  code: WorkspacePaneAvailabilityReasonCode;
  source: WorkspacePaneAvailabilitySource;
}

/** A bounded action a host may present without exposing sensitive details. */
export type WorkspacePaneAvailabilityAction =
  | {
      type: 'setup';
      code:
        | 'enable-distribution'
        | 'select-project'
        | 'select-task'
        | 'select-workspace'
        | 'select-git-repository'
        | 'complete-configuration'
        | 'request-permission';
    }
  | { type: 'retry'; code: 'retry-availability-check' }
  | {
      type: 'learn-more';
      code:
        | 'view-rollout'
        | 'view-distribution-policy'
        | 'view-context-requirements'
        | 'view-configuration-requirements'
        | 'view-host-requirements'
        | 'view-deployment-requirements'
        | 'view-renderer-requirements'
        | 'view-permission-requirements';
    };

export interface WorkspacePaneAvailability {
  state: WorkspacePaneAvailabilityState;
  reason: WorkspacePaneAvailabilityReason;
  action?: WorkspacePaneAvailabilityAction;
}

/** A capability fact that has to be reported explicitly to enable a pane. */
export type WorkspacePaneAvailabilityCapability =
  | 'supported'
  | 'unsupported'
  | 'unknown';

export type WorkspacePaneAvailabilityPresence =
  | 'present'
  | 'missing'
  | 'unknown';

export type WorkspacePaneAvailabilityPermission =
  | 'granted'
  | 'required'
  | 'unknown';

export type WorkspacePaneAvailabilityHealth =
  | 'healthy'
  | 'unavailable'
  | 'unknown';

export interface WorkspacePaneAvailabilityRequirements {
  /** An additional context requirement not represented by Pane binding IDs. */
  gitRepository?: true;
  /** A known configuration fact must be supplied before this Pane is available. */
  configuration?: true;
  /** A known permission fact must be supplied before this Pane is available. */
  permission?: true;
  /** A current health fact must be supplied before this Pane is available. */
  health?: true;
  /** Native-shell features required by this Pane, in addition to a supported host. */
  hostCapabilities?: readonly string[];
  /** Server/deployment features required by this Pane. */
  deploymentCapabilities?: readonly string[];
}

/**
 * Host-neutral inputs. Sources such as Tauri's adapter and a deployment
 * handshake adapt into this shape; no platform global, API handle, or raw
 * diagnostic enters the public result.
 */
export interface WorkspacePaneAvailabilityInput {
  installation?: 'ready' | 'pending' | 'unavailable';
  rollout?: 'available' | 'coming-soon' | 'unknown';
  distribution?: 'enabled' | 'disabled' | 'unknown';
  host?: {
    state: WorkspacePaneAvailabilityCapability;
    capabilities?: Readonly<
      Record<string, WorkspacePaneAvailabilityCapability>
    >;
  };
  deployment?: {
    state: WorkspacePaneAvailabilityCapability;
    capabilities?: Readonly<
      Record<string, WorkspacePaneAvailabilityCapability>
    >;
  };
  renderer?: WorkspacePaneAvailabilityPresence;
  context?: {
    project?: WorkspacePaneAvailabilityPresence;
    task?: WorkspacePaneAvailabilityPresence;
    workspace?: WorkspacePaneAvailabilityPresence;
    gitRepository?: WorkspacePaneAvailabilityPresence;
  };
  configuration?: WorkspacePaneAvailabilityPresence;
  permission?: WorkspacePaneAvailabilityPermission;
  health?: WorkspacePaneAvailabilityHealth;
  requirements?: WorkspacePaneAvailabilityRequirements;
}

function result(
  state: WorkspacePaneAvailabilityState,
  code: WorkspacePaneAvailabilityReasonCode,
  source: WorkspacePaneAvailabilitySource,
  action?: WorkspacePaneAvailabilityAction,
): WorkspacePaneAvailability {
  return action === undefined
    ? { state, reason: { code, source } }
    : { state, reason: { code, source }, action };
}

function resolveCapabilityRequirement(
  source: 'native-host' | 'deployment',
  requirementNames: readonly string[] | undefined,
  capability: WorkspacePaneAvailabilityCapability | undefined,
  capabilities:
    | Readonly<Record<string, WorkspacePaneAvailabilityCapability>>
    | undefined,
): WorkspacePaneAvailability | undefined {
  const unsupportedCode =
    source === 'native-host' ? 'unsupported-host' : 'unsupported-deployment';
  const unknownCode =
    source === 'native-host'
      ? 'host-capability-unknown'
      : 'deployment-capability-unknown';
  const action: WorkspacePaneAvailabilityAction = {
    type: 'learn-more',
    code:
      source === 'native-host'
        ? 'view-host-requirements'
        : 'view-deployment-requirements',
  };
  // A host/deployment fact is relevant only when the pane requires that
  // capability family. Absence must not disable a portable pane that makes no
  // native or deployment claim; a declared requirement still fails closed.
  if (capability === undefined && (requirementNames?.length ?? 0) === 0) {
    return undefined;
  }
  if (capability !== 'supported') {
    return result(
      'unsupported',
      capability === 'unsupported' ? unsupportedCode : unknownCode,
      source,
      action,
    );
  }
  for (const name of requirementNames ?? []) {
    const requiredCapability = capabilities?.[name];
    if (requiredCapability === 'supported') continue;
    return result(
      'unsupported',
      requiredCapability === 'unsupported' ? unsupportedCode : unknownCode,
      source,
      action,
    );
  }
  return undefined;
}

function resolveContextRequirement(
  requirement: WorkspacePaneContextRequirement | undefined,
  input: WorkspacePaneAvailabilityInput,
): WorkspacePaneAvailability | undefined {
  const context = input.context;
  const required = [
    ['project', requirement?.project, 'missing-project', 'select-project'],
    ['task', requirement?.task, 'missing-task', 'select-task'],
    [
      'workspace',
      requirement?.workspace,
      'missing-workspace',
      'select-workspace',
    ],
    [
      'gitRepository',
      input.requirements?.gitRepository,
      'missing-git-repository',
      'select-git-repository',
    ],
  ] as const;
  for (const [name, isRequired, missingCode, actionCode] of required) {
    if (isRequired !== true) continue;
    const presence = context?.[name];
    if (presence === 'present') continue;
    if (presence === 'missing') {
      return result('not-configured', missingCode, 'context', {
        type: 'setup',
        code: actionCode,
      });
    }
    return result('not-configured', 'context-unknown', 'context', {
      type: 'learn-more',
      code: 'view-context-requirements',
    });
  }
  return undefined;
}

/**
 * Resolves one current availability result. The precedence is intentional:
 * rollout and explicit distribution policy conceal lower-level details; then
 * hard host/deployment/renderer limits, required context, configuration,
 * consent, and transient health are considered in that exact order. Every
 * absent or unknown prerequisite fails closed instead of enabling execution.
 */
export function resolveWorkspacePaneAvailability(
  input: WorkspacePaneAvailabilityInput,
  contextRequirement?: WorkspacePaneContextRequirement,
): WorkspacePaneAvailability {
  if (input.rollout === 'coming-soon') {
    return result('coming-soon', 'coming-soon', 'product-rollout', {
      type: 'learn-more',
      code: 'view-rollout',
    });
  }
  if (input.rollout !== 'available') {
    return result('unsupported', 'rollout-unknown', 'product-rollout', {
      type: 'learn-more',
      code: 'view-rollout',
    });
  }
  if (
    input.installation === 'pending' ||
    input.installation === 'unavailable'
  ) {
    return result(
      'temporarily-unavailable',
      input.installation === 'pending'
        ? 'installation-pending'
        : 'installation-unavailable',
      'configuration',
      { type: 'retry', code: 'retry-availability-check' },
    );
  }
  if (input.distribution === 'disabled') {
    return result(
      'not-configured',
      'distribution-disabled',
      'distribution-policy',
      {
        type: 'setup',
        code: 'enable-distribution',
      },
    );
  }
  if (input.distribution !== 'enabled') {
    return result(
      'not-configured',
      'distribution-policy-unknown',
      'distribution-policy',
      { type: 'learn-more', code: 'view-distribution-policy' },
    );
  }

  const host = resolveCapabilityRequirement(
    'native-host',
    input.requirements?.hostCapabilities,
    input.host?.state,
    input.host?.capabilities,
  );
  if (host) return host;
  const deployment = resolveCapabilityRequirement(
    'deployment',
    input.requirements?.deploymentCapabilities,
    input.deployment?.state,
    input.deployment?.capabilities,
  );
  if (deployment) return deployment;

  if (input.renderer !== 'present') {
    return result(
      input.renderer === 'missing' ? 'temporarily-unavailable' : 'unsupported',
      input.renderer === 'missing' ? 'renderer-missing' : 'renderer-unknown',
      'renderer',
      {
        type: 'learn-more',
        code: 'view-renderer-requirements',
      },
    );
  }
  const context = resolveContextRequirement(contextRequirement, input);
  if (context) return context;
  if (
    input.configuration !== undefined ||
    input.requirements?.configuration === true
  ) {
    if (input.configuration === 'present') return resolvePermission(input);
    return result(
      'not-configured',
      input.configuration === 'missing'
        ? 'configuration-missing'
        : 'configuration-unknown',
      'configuration',
      input.configuration === 'missing'
        ? { type: 'setup', code: 'complete-configuration' }
        : { type: 'learn-more', code: 'view-configuration-requirements' },
    );
  }
  return resolvePermission(input);
}

function resolvePermission(
  input: WorkspacePaneAvailabilityInput,
): WorkspacePaneAvailability {
  if (
    input.permission !== undefined ||
    input.requirements?.permission === true
  ) {
    if (input.permission === 'granted') return resolveHealth(input);
    return result(
      'permission-required',
      input.permission === 'required'
        ? 'permission-required'
        : 'permission-unknown',
      'permission',
      input.permission === 'required'
        ? { type: 'setup', code: 'request-permission' }
        : { type: 'learn-more', code: 'view-permission-requirements' },
    );
  }
  return resolveHealth(input);
}

function resolveHealth(
  input: WorkspacePaneAvailabilityInput,
): WorkspacePaneAvailability {
  if (input.health !== undefined || input.requirements?.health === true) {
    if (input.health === 'healthy') {
      return result('available', 'ready', 'resolver');
    }
    return result(
      'temporarily-unavailable',
      input.health === 'unavailable' ? 'health-unavailable' : 'health-unknown',
      'health',
      { type: 'retry', code: 'retry-availability-check' },
    );
  }
  return result('available', 'ready', 'resolver');
}

/** The only fields an availability telemetry sink may record. */
export interface WorkspacePaneAvailabilityTelemetry {
  descriptorId: string;
  state: WorkspacePaneAvailabilityState;
  reasonCode: WorkspacePaneAvailabilityReasonCode;
}

export function toWorkspacePaneAvailabilityTelemetry(
  descriptorId: string,
  availability: WorkspacePaneAvailability,
): WorkspacePaneAvailabilityTelemetry {
  return {
    descriptorId,
    state: availability.state,
    reasonCode: availability.reason.code,
  };
}
