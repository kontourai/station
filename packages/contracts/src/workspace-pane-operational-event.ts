import {
  OPERATIONAL_EVENT_SCHEMA_VERSION,
  type OperationalEventEnvelope,
  type OperationalEventProducer,
  type OperationalEventScope,
  validateOperationalEventEnvelope,
} from './operational-event.js';
import type {
  WorkspacePaneInstance,
  WorkspacePaneProvenance,
  WorkspacePaneRendererRef,
} from './workspace-pane.js';
import type {
  WorkspacePaneAvailabilityReasonCode,
  WorkspacePaneAvailabilitySource,
} from './workspace-pane-availability.js';
import {
  type WorkspacePaneHostScope,
  workspacePaneHostScopeProjectId,
} from './workspace-pane-host.js';

/** The three executable renderer boundaries; standard-data is inert and emits no renderer lifecycle. */
export type WorkspacePaneOperationalRendererClass =
  | 'built-in'
  | 'trusted-plugin'
  | 'sandboxed-mcp-app';

export type WorkspacePaneLifecycleEventName =
  | 'opened'
  | 'restored'
  | 'ready'
  | 'resumed'
  | 'suspended'
  | 'closed'
  | 'availability-observed'
  | 'availability-changed'
  | 'preview-failed'
  | 'render-failed';

export type WorkspacePaneOperationalCapability =
  | 'supported'
  | 'degraded'
  | 'unavailable';

/** Never put a thrown error, URL, native handle, or renderer input in an event. */
export type WorkspacePaneOperationalFailureCode =
  | 'preview-unavailable'
  | 'preview-discovery-failed'
  | 'render-failed'
  | 'render-revoked'
  | 'render-missing';
export type WorkspacePaneOperationalCloseReason = 'user' | 'catalog-revoked';
export interface WorkspacePaneOperationalAvailabilityReason {
  code: WorkspacePaneAvailabilityReasonCode;
  source: WorkspacePaneAvailabilitySource;
}

export interface WorkspacePaneOperationalEventInput {
  id: string;
  occurredAt: string;
  producer: OperationalEventProducer;
  occurrenceId: string;
  hostScope: WorkspacePaneHostScope;
  instance: WorkspacePaneInstance;
  renderer: WorkspacePaneRendererRef;
  provenance: WorkspacePaneProvenance;
  source: 'primary' | 'alternative';
  name: WorkspacePaneLifecycleEventName;
  capability: WorkspacePaneOperationalCapability;
  failureCode?: WorkspacePaneOperationalFailureCode;
  closeReason?: WorkspacePaneOperationalCloseReason;
  availabilityReason?: WorkspacePaneOperationalAvailabilityReason;
  sequence?: number;
}

function rendererProvenanceMatches(
  renderer: WorkspacePaneRendererRef,
  provenance: WorkspacePaneProvenance,
): boolean {
  return (
    (renderer.kind === 'builtin-component' &&
      provenance.origin === 'builtin') ||
    (renderer.kind === 'plugin-component' && provenance.origin === 'plugin') ||
    (renderer.kind === 'mcp-tool-ui' && provenance.origin === 'mcp')
  );
}

export function workspacePaneOperationalRendererClass(
  renderer: WorkspacePaneRendererRef,
): WorkspacePaneOperationalRendererClass | null {
  switch (renderer.kind) {
    case 'builtin-component':
      return 'built-in';
    case 'plugin-component':
      return 'trusted-plugin';
    case 'mcp-tool-ui':
      return 'sandboxed-mcp-app';
    case 'standard-data':
      return null;
  }
}

function scopesFor(
  input: WorkspacePaneOperationalEventInput,
): OperationalEventScope[] {
  const rendererClass = workspacePaneOperationalRendererClass(input.renderer);
  if (!rendererClass) return [];
  const context = input.instance.boundContext;
  // An ambient host owns no Project, so the envelope names none. A project
  // scope here would be a projectId nothing derived.
  const hostProjectId = workspacePaneHostScopeProjectId(input.hostScope);
  const scopes: OperationalEventScope[] = [];
  if (hostProjectId !== undefined)
    scopes.push({ kind: 'project', projectId: hostProjectId });
  if (input.hostScope.kind === 'task')
    scopes.push({
      kind: 'task',
      taskId: input.hostScope.taskId,
      projectId: input.hostScope.projectId,
    });
  scopes.push({
    kind: 'pane',
    descriptorId: input.instance.descriptorId,
    instanceId: input.instance.instanceId,
    rendererClass,
  });
  if (context?.workspaceId)
    scopes.push({
      kind: 'workspace',
      workspaceId: context.workspaceId,
      ...(hostProjectId === undefined ? {} : { projectId: hostProjectId }),
    });
  if (context?.sessionId)
    scopes.push({ kind: 'thread', threadId: context.sessionId });
  if (context?.runId)
    scopes.push({
      kind: 'run',
      runId: context.runId,
      ...(context.sessionId ? { threadId: context.sessionId } : {}),
    });
  return scopes;
}

/**
 * Creates one exact, Station-owned workspace-pane lifecycle envelope. It does
 * not persist, dispatch, subscribe, or execute anything. Invalid/mismatched
 * scope input fails closed by returning null.
 */
export function createWorkspacePaneOperationalEvent(
  input: WorkspacePaneOperationalEventInput,
): OperationalEventEnvelope | null {
  const rendererClass = workspacePaneOperationalRendererClass(input.renderer);
  if (
    !rendererClass ||
    !rendererProvenanceMatches(input.renderer, input.provenance) ||
    (input.instance.boundContext?.projectId &&
      input.instance.boundContext.projectId !==
        workspacePaneHostScopeProjectId(input.hostScope))
  )
    return null;
  if (
    input.hostScope.kind === 'task' &&
    input.instance.boundContext?.taskId &&
    input.instance.boundContext.taskId !== input.hostScope.taskId
  )
    return null;
  if (
    (input.name === 'preview-failed' || input.name === 'render-failed') !==
    (input.failureCode !== undefined)
  )
    return null;
  if (
    input.name !== 'preview-failed' &&
    input.name !== 'render-failed' &&
    input.failureCode !== undefined
  )
    return null;
  if ((input.name === 'closed') !== (input.closeReason !== undefined))
    return null;
  const isAvailability =
    input.name === 'availability-observed' ||
    input.name === 'availability-changed';
  if (isAvailability !== (input.availabilityReason !== undefined)) return null;
  const event: OperationalEventEnvelope = {
    schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
    id: input.id,
    type: 'station.workspace-pane.lifecycle/v1',
    producer: input.producer,
    occurredAt: input.occurredAt,
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    scopes: scopesFor(input),
    payload: {
      schema: 'station.workspace-pane.lifecycle/v1',
      data: {
        event: input.name,
        occurrenceId: input.occurrenceId,
        rendererClass,
        rendererProvenance: input.provenance.origin,
        rendererSource: input.source,
        capability: input.capability,
        ...(input.failureCode === undefined
          ? {}
          : { failureCode: input.failureCode }),
        ...(input.closeReason === undefined
          ? {}
          : { closeReason: input.closeReason }),
        ...(input.availabilityReason === undefined
          ? {}
          : {
              availabilityReasonCode: input.availabilityReason.code,
              availabilityReasonSource: input.availabilityReason.source,
            }),
      },
    },
    privacy: 'private',
    delivery: 'ephemeral',
  };
  return validateOperationalEventEnvelope(event).ok ? event : null;
}
