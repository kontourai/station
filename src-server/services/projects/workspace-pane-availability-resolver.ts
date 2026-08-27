import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import {
  resolveWorkspacePaneAvailability,
  toWorkspacePaneAvailabilityTelemetry,
  type WorkspacePaneAvailability,
  type WorkspacePaneAvailabilityInput,
  type WorkspacePaneAvailabilityTelemetry,
} from '@kontourai/station-contracts/workspace-pane-availability';
import { workspacePaneAvailabilityMetricDescriptor } from './workspace-pane-known-declarations.js';

/** Minimal catalog provenance required to produce a safe default input. */
export interface WorkspacePaneAvailabilityContribution {
  id: string;
  enabled: boolean;
}

export interface WorkspacePaneCatalogAvailabilityCandidate {
  descriptor: WorkspacePaneDescriptor;
  /** Absent for a known descriptor which has not yet been placed. */
  instance?: WorkspacePaneInstance;
  contribution?: WorkspacePaneAvailabilityContribution;
  /** An explicit declaration input always wins over inferred catalog defaults. */
  availabilityInput?: WorkspacePaneAvailabilityInput;
}

export interface WorkspacePaneCatalogAvailabilityOptions {
  /**
   * Adapts authoritative host/deployment/renderer sources at the server edge.
   * It receives no UI or native-global dependency and must never return raw
   * diagnostics; those are deliberately absent from the shared input shape.
   */
  resolveInput?: (
    candidate: WorkspacePaneCatalogAvailabilityCandidate,
  ) => WorkspacePaneAvailabilityInput;
  /** Optional telemetry sink; it receives descriptor/state/reason code only. */
  recordTelemetry?: (event: WorkspacePaneAvailabilityTelemetry) => void;
}

function mergeAvailabilityInput(
  ...inputs: Array<WorkspacePaneAvailabilityInput | undefined>
): WorkspacePaneAvailabilityInput {
  let merged: WorkspacePaneAvailabilityInput = {};
  for (const input of inputs) {
    if (!input) continue;
    const context = { ...merged.context, ...input.context };
    const requirements = { ...merged.requirements, ...input.requirements };
    const hostState = input.host?.state ?? merged.host?.state;
    const hostCapabilities = {
      ...merged.host?.capabilities,
      ...input.host?.capabilities,
    };
    const deploymentState = input.deployment?.state ?? merged.deployment?.state;
    const deploymentCapabilities = {
      ...merged.deployment?.capabilities,
      ...input.deployment?.capabilities,
    };
    merged = {
      ...merged,
      ...input,
      ...(Object.keys(context).length > 0 ? { context } : {}),
      ...(Object.keys(requirements).length > 0 ? { requirements } : {}),
      ...(hostState
        ? {
            host: {
              state: hostState,
              ...(Object.keys(hostCapabilities).length > 0
                ? { capabilities: hostCapabilities }
                : {}),
            },
          }
        : {}),
      ...(deploymentState
        ? {
            deployment: {
              state: deploymentState,
              ...(Object.keys(deploymentCapabilities).length > 0
                ? { capabilities: deploymentCapabilities }
                : {}),
            },
          }
        : {}),
    };
    if (!hostState) delete merged.host;
    if (!deploymentState) delete merged.deployment;
    if (Object.keys(context).length === 0) delete merged.context;
    if (Object.keys(requirements).length === 0) delete merged.requirements;
  }
  return merged;
}

export interface WorkspacePaneCatalogAvailabilityEntry {
  descriptorId: WorkspacePaneDescriptor['id'];
  /** Absent when availability describes a known, not-yet-placed descriptor. */
  instanceId?: WorkspacePaneInstance['instanceId'];
  /**
   * Bounded server-authoritative facts. A host composes only the facts it
   * owns (for example renderer/native capability) and re-runs the shared
   * resolver; this is never a raw diagnostic payload.
   */
  input: WorkspacePaneAvailabilityInput;
  availability: WorkspacePaneAvailability;
}

/**
 * The resolver projector includes a descriptor identity for UI correlation;
 * production metrics must collapse contributor-controlled identities before
 * they cross the telemetry boundary.
 */
export function workspacePaneAvailabilityMetricAttributes(
  event: WorkspacePaneAvailabilityTelemetry,
): Readonly<Record<'descriptor' | 'state' | 'reason_code', string>> {
  return {
    descriptor: workspacePaneAvailabilityMetricDescriptor(event.descriptorId),
    state: event.state,
    reason_code: event.reasonCode,
  };
}

function defaultAvailabilityInput(
  candidate: WorkspacePaneCatalogAvailabilityCandidate,
): WorkspacePaneAvailabilityInput {
  const bound = candidate.instance?.boundContext;
  const context: NonNullable<WorkspacePaneAvailabilityInput['context']> = {};
  const requirements = candidate.descriptor.modes.map(
    (mode) => mode.contextRequirement,
  );
  if (requirements.some((requirement) => requirement?.project === true)) {
    context.project = bound?.projectId ? 'present' : 'missing';
  }
  if (requirements.some((requirement) => requirement?.task === true)) {
    context.task = bound?.taskId ? 'present' : 'missing';
  }
  if (requirements.some((requirement) => requirement?.workspace === true)) {
    context.workspace = bound?.workspaceId ? 'present' : 'missing';
  }
  return {
    // Catalog membership is authoritative that the product has rolled out the
    // declaration. It is not proof that a renderer can be loaded.
    rollout: 'available',
    distribution:
      candidate.contribution?.enabled === true ? 'enabled' : 'disabled',
    // #1370 must not infer renderer execution from a descriptor reference.
    // Until a host adapter proves it, fail closed but retain the pane.
    renderer: 'unknown',
    context,
  };
}

function instanceSatisfiesMode(
  instance: WorkspacePaneInstance,
  requirement: WorkspacePaneDescriptor['modes'][number]['contextRequirement'],
): boolean {
  const bound = instance.boundContext;
  if (!bound) return !requirement;
  return !(
    (requirement?.project && !bound.projectId) ||
    (requirement?.task && !bound.taskId) ||
    (requirement?.session && !bound.sessionId) ||
    (requirement?.run && !bound.runId) ||
    (requirement?.workspace && !bound.workspaceId) ||
    (requirement?.source && !bound.sourceId)
  );
}

function resolveForCandidateModes(
  candidate: WorkspacePaneCatalogAvailabilityCandidate,
  input: WorkspacePaneAvailabilityInput,
): WorkspacePaneAvailability {
  const modes = candidate.instance
    ? candidate.descriptor.modes.filter((mode) =>
        instanceSatisfiesMode(candidate.instance!, mode.contextRequirement),
      )
    : candidate.descriptor.modes;
  const outcomes = modes.map((mode) =>
    resolveWorkspacePaneAvailability(input, mode.contextRequirement),
  );
  const available = outcomes.find((outcome) => outcome.state === 'available');
  if (available) return available;
  if (outcomes[0]) return outcomes[0];
  const prerequisite = resolveWorkspacePaneAvailability(
    input,
    candidate.descriptor.modes[0]?.contextRequirement,
  );
  return prerequisite.state === 'available'
    ? {
        state: 'not-configured',
        reason: { code: 'context-unknown', source: 'context' },
        action: { type: 'learn-more', code: 'view-context-requirements' },
      }
    : prerequisite;
}

/**
 * Resolves one result for every known catalog descriptor or placed instance.
 * Default inputs make no unsupported positive claim; hosts opt in by supplying
 * their authoritative adapter result through `resolveInput`.
 */
export function resolveWorkspacePaneCatalogAvailability(
  candidates: readonly WorkspacePaneCatalogAvailabilityCandidate[],
  options: WorkspacePaneCatalogAvailabilityOptions = {},
): readonly WorkspacePaneCatalogAvailabilityEntry[] {
  return candidates.map((candidate) => {
    // A declaration supplies only the facts it owns. In particular,
    // `coming-soon` wins resolution precedence but must not discard the
    // distribution/context facts supplied by the catalog edge.
    const input = mergeAvailabilityInput(
      defaultAvailabilityInput(candidate),
      options.resolveInput?.(candidate),
      candidate.availabilityInput,
    );
    const availability = resolveForCandidateModes(candidate, input);
    options.recordTelemetry?.(
      toWorkspacePaneAvailabilityTelemetry(
        candidate.descriptor.id,
        availability,
      ),
    );
    return {
      descriptorId: candidate.descriptor.id,
      ...(candidate.instance
        ? { instanceId: candidate.instance.instanceId }
        : {}),
      input,
      availability,
    };
  });
}
