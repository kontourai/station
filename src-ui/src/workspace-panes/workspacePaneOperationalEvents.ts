import type { OperationalEventEnvelope } from '@kontourai/station-contracts/operational-event';
import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import {
  type WorkspacePaneHostDocumentV1,
  workspacePaneHostScopeProjectId,
} from '@kontourai/station-contracts/workspace-pane-host';
import {
  createWorkspacePaneOperationalEvent,
  type WorkspacePaneLifecycleEventName,
  type WorkspacePaneOperationalCapability,
  type WorkspacePaneOperationalCloseReason,
  type WorkspacePaneOperationalFailureCode,
  workspacePaneOperationalRendererClass,
} from '@kontourai/station-contracts/workspace-pane-operational-event';
import type { WorkspacePaneRendererCandidate } from '@kontourai/station-contracts/workspace-pane-renderer-selection';
import {
  type WorkspacePaneHostStorage,
  workspacePaneHostStorageKey,
} from './workspacePaneHostStorage';

/** UI injection seam only. This slice deliberately has no server EventBus dependency. */
export interface WorkspacePaneOperationalEventSink {
  emit(event: OperationalEventEnvelope): void;
}

export const noopWorkspacePaneOperationalEventSink: WorkspacePaneOperationalEventSink =
  Object.freeze({ emit: () => undefined });

/** Small fixture/test sink. It is intentionally not a durable delivery mechanism. */
export class InMemoryWorkspacePaneOperationalEventSink
  implements WorkspacePaneOperationalEventSink
{
  readonly events: OperationalEventEnvelope[] = [];
  emit(event: OperationalEventEnvelope): void {
    this.events.push(event);
  }
}

export interface WorkspacePaneOperationalEventContext {
  document: WorkspacePaneHostDocumentV1;
  descriptor: WorkspacePaneDescriptor;
  instance: WorkspacePaneInstance;
  selectedRenderer: WorkspacePaneRendererCandidate;
}

export function createWorkspacePaneOperationalEventContext(
  document: WorkspacePaneHostDocumentV1,
  descriptor: WorkspacePaneDescriptor,
  instance: WorkspacePaneInstance,
  selectedRenderer: WorkspacePaneRendererCandidate,
): WorkspacePaneOperationalEventContext | null {
  const context = { document, descriptor, instance, selectedRenderer };
  return isWorkspacePaneOperationalEventContext(context) ? context : null;
}

const CHECKPOINT_LIMIT = 48;
const CHECKPOINT_SUFFIX = ':operational-events:v1';
const CHECKPOINTED = new Set<WorkspacePaneLifecycleEventName>([
  'opened',
  'ready',
]);

function checkpointKey(document: WorkspacePaneHostDocumentV1): string {
  return `${workspacePaneHostStorageKey(document.scope, document.id)}${CHECKPOINT_SUFFIX}`;
}

function safeHash(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function workspacePaneOperationalOccurrenceId(
  document: WorkspacePaneHostDocumentV1,
  instance: WorkspacePaneInstance,
): string {
  // An ambient host has no project/layout pair to hash. Its marker keeps the
  // two-segment shape with an empty second segment, which no project or task
  // scope can produce (a layoutId is never empty), so the existing hashes stay
  // byte-identical and cannot collide with the new one.
  const scope = document.scope;
  const identity =
    scope.kind === 'ambient'
      ? 'ambient:'
      : `${scope.projectId}:${scope.layoutId}`;
  return `pane-${safeHash(`${identity}:${document.id}:${instance.instanceId}`)}`;
}

export function workspacePaneOperationalCapability(
  availability: WorkspacePaneAvailability | undefined,
): WorkspacePaneOperationalCapability {
  if (!availability || availability.state === 'temporarily-unavailable')
    return 'degraded';
  return availability.state === 'available' ? 'supported' : 'unavailable';
}

/**
 * Validates the selected renderer rather than reconstructing it from a label
 * or descriptor string. That prevents a plugin/MCP contributor from claiming a
 * different renderer boundary in the emitted fact.
 */
export function isWorkspacePaneOperationalEventContext(
  context: WorkspacePaneOperationalEventContext,
): boolean {
  const candidate = context.selectedRenderer;
  const rendererClass = workspacePaneOperationalRendererClass(
    candidate.renderer,
  );
  if (!rendererClass || context.instance.descriptorId !== context.descriptor.id)
    return false;
  if (
    context.instance.boundContext?.projectId &&
    context.instance.boundContext.projectId !==
      workspacePaneHostScopeProjectId(context.document.scope)
  )
    return false;
  if (
    context.document.scope.kind === 'task' &&
    context.instance.boundContext?.taskId &&
    context.instance.boundContext.taskId !== context.document.scope.taskId
  )
    return false;
  const provenance =
    candidate.rendererProvenance ?? candidate.contributorProvenance;
  if (rendererClass === 'built-in') return provenance.origin === 'builtin';
  if (rendererClass === 'trusted-plugin') return provenance.origin === 'plugin';
  return provenance.origin === 'mcp';
}

/**
 * Bounded local checkpoint. It stores only deterministic occurrence/name keys,
 * never payloads. The controller creates it only after acquiring the host's
 * persistence lease, so a contending tab cannot suppress an owner's events.
 */
export class WorkspacePaneOperationalEventTracker {
  private readonly seen = new Set<string>();
  private loaded = false;
  private sequence = 0;

  constructor(
    private readonly storage: WorkspacePaneHostStorage,
    private readonly sink: WorkspacePaneOperationalEventSink = noopWorkspacePaneOperationalEventSink,
  ) {}

  private load(document: WorkspacePaneHostDocumentV1): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stored = JSON.parse(
        this.storage.getItem(checkpointKey(document)) ?? '[]',
      );
      if (!Array.isArray(stored)) return;
      for (const item of stored.slice(-CHECKPOINT_LIMIT))
        if (typeof item === 'string' && item.length <= 96) this.seen.add(item);
    } catch {
      // Corrupt optional dedup state is never authority; emit safely.
    }
  }

  private persist(document: WorkspacePaneHostDocumentV1): void {
    try {
      this.storage.setItem(
        checkpointKey(document),
        JSON.stringify([...this.seen].slice(-CHECKPOINT_LIMIT)),
      );
    } catch {
      // Sink delivery must remain fail-soft when browser storage is unavailable.
    }
  }

  emit(
    context: WorkspacePaneOperationalEventContext,
    name: WorkspacePaneLifecycleEventName,
    availability?: WorkspacePaneAvailability,
    failureCode?: WorkspacePaneOperationalFailureCode,
    closeReason?: WorkspacePaneOperationalCloseReason,
  ): OperationalEventEnvelope | null {
    if (!isWorkspacePaneOperationalEventContext(context)) return null;
    this.load(context.document);
    const occurrenceId = workspacePaneOperationalOccurrenceId(
      context.document,
      context.instance,
    );
    const key = `${occurrenceId}:${name}`;
    if (CHECKPOINTED.has(name) && this.seen.has(key)) return null;
    const provenance =
      context.selectedRenderer.rendererProvenance ??
      context.selectedRenderer.contributorProvenance;
    const event = createWorkspacePaneOperationalEvent({
      id: `workspace-pane-${safeHash(key)}-${++this.sequence}`,
      occurredAt: new Date().toISOString(),
      producer: { id: 'station-ui', version: '1' },
      occurrenceId,
      hostScope: context.document.scope,
      instance: context.instance,
      renderer: context.selectedRenderer.renderer,
      provenance,
      source: context.selectedRenderer.source,
      name,
      capability: workspacePaneOperationalCapability(availability),
      ...(failureCode === undefined ? {} : { failureCode }),
      ...(closeReason === undefined ? {} : { closeReason }),
      ...(availability === undefined
        ? {}
        : {
            availabilityReason: {
              code: availability.reason.code,
              source: availability.reason.source,
            },
          }),
      sequence: this.sequence,
    });
    if (!event) return null;
    if (CHECKPOINTED.has(name)) {
      this.seen.add(key);
      this.persist(context.document);
    }
    try {
      this.sink.emit(event);
    } catch {
      // Observability cannot disrupt the visible pane lifecycle.
    }
    return event;
  }

  observeAvailability(
    context: WorkspacePaneOperationalEventContext,
    previous: WorkspacePaneAvailability | undefined,
    next: WorkspacePaneAvailability,
  ): OperationalEventEnvelope | null {
    if (
      previous &&
      previous.state === next.state &&
      previous.reason.code === next.reason.code &&
      previous.reason.source === next.reason.source
    )
      return null;
    const changed =
      previous !== undefined &&
      (previous.state !== next.state ||
        previous.reason.code !== next.reason.code ||
        previous.reason.source !== next.reason.source);
    return this.emit(
      context,
      changed ? 'availability-changed' : 'availability-observed',
      next,
    );
  }
}
