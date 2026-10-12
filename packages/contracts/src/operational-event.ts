/**
 * Versioned, bounded facts emitted by Station actors. This is deliberately a
 * contract only: it neither stores, dispatches, invokes, nor trusts events.
 * Adapters to Surface, Console, Flow, Conduit, and native hosts are separate
 * consumers of this envelope.
 */

import { canonicalizeForDigest } from './fleet-routing-receipt.js';

export const OPERATIONAL_EVENT_SCHEMA_VERSION =
  'station.operational-event/v1' as const;
export const MAX_OPERATIONAL_EVENT_ID_LENGTH = 128;
export const MAX_OPERATIONAL_EVENT_PAYLOAD_BYTES = 65_536;
export const MAX_OPERATIONAL_EVENT_JSON_DEPTH = 16;
export const MAX_OPERATIONAL_EVENT_JSON_ITEMS = 4_096;
export const MAX_OPERATIONAL_EVENT_SCOPES = 8;

export type OperationalEventPrivacyClass = 'public' | 'private' | 'sensitive';
export type OperationalEventDeliveryClass =
  | 'ephemeral'
  | 'durable'
  | 'projection'
  | 'evidence-eligible';
export type OperationalEventTypeStatus = 'active' | 'deprecated';
export type OperationalEventCompatibility = 'exact' | 'additive';
export type OperationalEventOwner = 'station' | 'plugin' | 'kit';

export type OperationalEventJson =
  | null
  | boolean
  | number
  | string
  | OperationalEventJson[]
  | { [key: string]: OperationalEventJson };

export interface OperationalEventProducer {
  id: string;
  version: string;
}

export type OperationalEventScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'task'; taskId: string; projectId?: string }
  | { kind: 'thread'; threadId: string; taskId?: string }
  | { kind: 'run'; runId: string; threadId?: string }
  | { kind: 'workspace'; workspaceId: string; projectId?: string }
  | {
      kind: 'pane';
      descriptorId: string;
      instanceId: string;
      rendererClass: 'built-in' | 'trusted-plugin' | 'sandboxed-mcp-app';
    }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'kit'; kitId: string };

export interface OperationalEventPayload {
  schema: string;
  data: OperationalEventJson;
}

export interface OperationalEventEnvelope {
  schemaVersion: typeof OPERATIONAL_EVENT_SCHEMA_VERSION;
  id: string;
  type: string;
  producer: OperationalEventProducer;
  occurredAt: string;
  sequence?: number;
  correlationId?: string;
  causationId?: string;
  scopes: OperationalEventScope[];
  payload: OperationalEventPayload;
  privacy: OperationalEventPrivacyClass;
  delivery: OperationalEventDeliveryClass;
}

/**
 * Host-owned projection delivered to an operational-event subscriber. The
 * subscriber never chooses this shape directly; authorization selects it.
 */
export type OperationalEventProjection =
  | {
      kind: 'redacted';
      event: Pick<
        OperationalEventEnvelope,
        | 'schemaVersion'
        | 'id'
        | 'type'
        | 'producer'
        | 'occurredAt'
        | 'privacy'
        | 'delivery'
      >;
    }
  | {
      kind: 'metadata';
      event: Omit<OperationalEventEnvelope, 'payload'>;
    }
  | { kind: 'envelope'; event: OperationalEventEnvelope };

export interface OperationalEventTypeDefinition {
  namespace: string;
  name: string;
  version: number;
  owner: OperationalEventOwner;
  payloadSchema: string;
  compatibility: OperationalEventCompatibility;
  status: OperationalEventTypeStatus;
}

export interface OperationalEventTypeRegistry {
  readonly definitions: readonly OperationalEventTypeDefinition[];
}

function immutableDefinition(
  definition: OperationalEventTypeDefinition,
): OperationalEventTypeDefinition {
  return Object.freeze({ ...definition });
}

export const BUILTIN_OPERATIONAL_EVENT_TYPES: readonly OperationalEventTypeDefinition[] =
  Object.freeze([
    immutableDefinition({
      namespace: 'station',
      name: 'runtime.lifecycle',
      version: 1,
      owner: 'station',
      payloadSchema: 'station.runtime.lifecycle/v1',
      compatibility: 'exact',
      status: 'active',
    }),
    immutableDefinition({
      namespace: 'station',
      name: 'workspace-pane.lifecycle',
      version: 1,
      owner: 'station',
      payloadSchema: 'station.workspace-pane.lifecycle/v1',
      compatibility: 'exact',
      status: 'active',
    }),
    immutableDefinition({
      namespace: 'station',
      name: 'plugin-command.execution',
      version: 1,
      owner: 'station',
      payloadSchema: 'station.plugin-command.execution/v1',
      compatibility: 'exact',
      status: 'active',
    }),
  ]);

export const DEFAULT_OPERATIONAL_EVENT_TYPE_REGISTRY: OperationalEventTypeRegistry =
  Object.freeze({ definitions: BUILTIN_OPERATIONAL_EVENT_TYPES });

export type OperationalEventDiagnosticCode =
  | 'invalid-envelope'
  | 'unknown-field'
  | 'unknown-schema-version'
  | 'invalid-id'
  | 'invalid-type'
  | 'unknown-event-type'
  | 'unknown-type-version'
  | 'invalid-producer'
  | 'invalid-timestamp'
  | 'invalid-sequence'
  | 'invalid-correlation'
  | 'invalid-causation'
  | 'invalid-scopes'
  | 'invalid-scope'
  | 'duplicate-scope'
  | 'scope-conflict'
  | 'namespace-not-authorized'
  | 'invalid-payload-schema'
  | 'invalid-payload'
  | 'payload-too-large'
  | 'invalid-privacy'
  | 'invalid-delivery'
  | 'type-deprecated'
  | 'evidence-ineligible';

export interface OperationalEventDiagnostic {
  code: OperationalEventDiagnosticCode;
  path: string;
  message: string;
}

export type OperationalEventValidationResult =
  | {
      ok: true;
      event: OperationalEventEnvelope;
      diagnostics: OperationalEventDiagnostic[];
    }
  | { ok: false; diagnostics: OperationalEventDiagnostic[] };

export type OperationalEventEvidenceInputResult =
  | { ok: true; eventId: string; digestInput: string }
  | { ok: false; diagnostics: OperationalEventDiagnostic[] };

const EVENT_KEYS = [
  'schemaVersion',
  'id',
  'type',
  'producer',
  'occurredAt',
  'sequence',
  'correlationId',
  'causationId',
  'scopes',
  'payload',
  'privacy',
  'delivery',
] as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TYPE_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const NAMESPACE = /^(?:station|(?:plugin|kit)\.[a-z][a-z0-9-]*)$/;
const PAYLOAD_SCHEMA = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\/v[1-9][0-9]*$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.values(Object.getOwnPropertyDescriptors(value)).every(
        (descriptor) =>
          descriptor.get === undefined && descriptor.set === undefined,
      )
    );
  } catch {
    return false;
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OPERATIONAL_EVENT_ID_LENGTH &&
    value === value.trim() &&
    IDENTIFIER.test(value)
  );
}

/**
 * Accepts only Station's canonical RFC3339 UTC spelling: a calendar-valid
 * whole-second instant or one with exactly three fractional digits. Parsing
 * alone is insufficient because Date accepts rollover dates such as February
 * 30 and normalizes them into a different instant.
 */
function isCanonicalRfc3339Utc(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{3})?Z$/.exec(
    value,
  );
  if (!match) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const canonical = parsed.toISOString();
  return (
    value === canonical ||
    (match[2] === undefined && value === canonical.replace('.000Z', 'Z'))
  );
}

function push(
  diagnostics: OperationalEventDiagnostic[],
  code: OperationalEventDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: OperationalEventDiagnostic[],
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      push(
        diagnostics,
        'unknown-field',
        `${path}${path ? '.' : ''}${key}`,
        'field is not recognized by this contract version',
      );
}

function parseType(
  value: unknown,
): { namespace: string; name: string; version: number } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(.*)\/v([1-9][0-9]*)$/.exec(value);
  if (!match) return undefined;
  const parts = match[1].split('.');
  const namespace =
    parts[0] === 'station'
      ? 'station'
      : (parts[0] === 'plugin' || parts[0] === 'kit') && parts.length >= 3
        ? `${parts[0]}.${parts[1]}`
        : undefined;
  if (!namespace) return undefined;
  const name = match[1].slice(namespace.length + 1);
  const version = Number(match[2]);
  return NAMESPACE.test(namespace) &&
    TYPE_NAME.test(name) &&
    Number.isSafeInteger(version)
    ? { namespace, name, version }
    : undefined;
}

function cloneJson(
  value: unknown,
  depth: number,
  budget: { strings: number; items: number; overLimit: boolean },
  seen: Set<object>,
): OperationalEventJson | undefined {
  budget.items += 1;
  if (budget.items > MAX_OPERATIONAL_EVENT_JSON_ITEMS) {
    budget.overLimit = true;
    return undefined;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    budget.strings += new TextEncoder().encode(value).byteLength;
    if (budget.strings > MAX_OPERATIONAL_EVENT_PAYLOAD_BYTES)
      budget.overLimit = true;
    return budget.overLimit ? undefined : value;
  }
  if (
    typeof value !== 'object' ||
    depth > MAX_OPERATIONAL_EVENT_JSON_DEPTH ||
    seen.has(value)
  )
    return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output: OperationalEventJson[] = [];
      for (const member of value) {
        const cloned = cloneJson(member, depth + 1, budget, seen);
        if (cloned === undefined) return undefined;
        output.push(cloned);
      }
      return output;
    }
    if (!isPlainRecord(value)) return undefined;
    const output: { [key: string]: OperationalEventJson } = Object.create(null);
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor')
        return undefined;
      const cloned = cloneJson(value[key], depth + 1, budget, seen);
      if (cloned === undefined) return undefined;
      Object.defineProperty(output, key, {
        value: cloned,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function validateScope(
  value: unknown,
  index: number,
  diagnostics: OperationalEventDiagnostic[],
): OperationalEventScope | undefined {
  const path = `scopes[${index}]`;
  if (!isPlainRecord(value) || typeof value.kind !== 'string') {
    push(
      diagnostics,
      'invalid-scope',
      path,
      'scope must be a typed plain object',
    );
    return undefined;
  }
  const allowedKeys: Record<string, readonly string[]> = {
    project: ['kind', 'projectId'],
    task: ['kind', 'taskId', 'projectId'],
    thread: ['kind', 'threadId', 'taskId'],
    run: ['kind', 'runId', 'threadId'],
    workspace: ['kind', 'workspaceId', 'projectId'],
    pane: ['kind', 'descriptorId', 'instanceId', 'rendererClass'],
    plugin: ['kind', 'pluginId'],
    kit: ['kind', 'kitId'],
  };
  if (allowedKeys[value.kind])
    rejectUnknownKeys(value, allowedKeys[value.kind], path, diagnostics);
  const requireIdentifiers = (...keys: string[]): boolean =>
    keys.every((key) => {
      if (isIdentifier(value[key])) return true;
      push(
        diagnostics,
        'invalid-scope',
        `${path}.${key}`,
        'must be a bounded identifier',
      );
      return false;
    });
  const optional = (key: string): string | undefined => {
    if (value[key] === undefined) return undefined;
    if (isIdentifier(value[key])) return value[key] as string;
    push(
      diagnostics,
      'invalid-scope',
      `${path}.${key}`,
      'must be a bounded identifier when present',
    );
    return undefined;
  };
  switch (value.kind) {
    case 'project':
      return requireIdentifiers('projectId')
        ? { kind: 'project', projectId: value.projectId as string }
        : undefined;
    case 'task': {
      if (!requireIdentifiers('taskId')) return undefined;
      const taskProjectId = optional('projectId');
      if (value.projectId !== undefined && taskProjectId === undefined)
        return undefined;
      return {
        kind: 'task',
        taskId: value.taskId as string,
        ...(taskProjectId === undefined ? {} : { projectId: taskProjectId }),
      };
    }
    case 'thread': {
      if (!requireIdentifiers('threadId')) return undefined;
      const threadTaskId = optional('taskId');
      if (value.taskId !== undefined && threadTaskId === undefined)
        return undefined;
      return {
        kind: 'thread',
        threadId: value.threadId as string,
        ...(threadTaskId === undefined ? {} : { taskId: threadTaskId }),
      };
    }
    case 'run': {
      if (!requireIdentifiers('runId')) return undefined;
      const runThreadId = optional('threadId');
      if (value.threadId !== undefined && runThreadId === undefined)
        return undefined;
      return {
        kind: 'run',
        runId: value.runId as string,
        ...(runThreadId === undefined ? {} : { threadId: runThreadId }),
      };
    }
    case 'workspace': {
      if (!requireIdentifiers('workspaceId')) return undefined;
      const workspaceProjectId = optional('projectId');
      if (value.projectId !== undefined && workspaceProjectId === undefined)
        return undefined;
      return {
        kind: 'workspace',
        workspaceId: value.workspaceId as string,
        ...(workspaceProjectId === undefined
          ? {}
          : { projectId: workspaceProjectId }),
      };
    }
    case 'pane':
      if (
        !requireIdentifiers('descriptorId', 'instanceId') ||
        !['built-in', 'trusted-plugin', 'sandboxed-mcp-app'].includes(
          value.rendererClass as string,
        )
      ) {
        push(
          diagnostics,
          'invalid-scope',
          `${path}.rendererClass`,
          'must name a supported renderer security class',
        );
        return undefined;
      }
      return {
        kind: 'pane',
        descriptorId: value.descriptorId as string,
        instanceId: value.instanceId as string,
        rendererClass: value.rendererClass as
          | 'built-in'
          | 'trusted-plugin'
          | 'sandboxed-mcp-app',
      };
    case 'plugin':
      return requireIdentifiers('pluginId')
        ? { kind: 'plugin', pluginId: value.pluginId as string }
        : undefined;
    case 'kit':
      return requireIdentifiers('kitId')
        ? { kind: 'kit', kitId: value.kitId as string }
        : undefined;
    default:
      push(
        diagnostics,
        'invalid-scope',
        `${path}.kind`,
        'scope kind is not supported by this contract version',
      );
      return undefined;
  }
}

function validateScopeRelations(
  scopes: OperationalEventScope[],
  diagnostics: OperationalEventDiagnostic[],
): void {
  const byKind = new Map(scopes.map((scope) => [scope.kind, scope]));
  if (byKind.size !== scopes.length)
    push(
      diagnostics,
      'duplicate-scope',
      'scopes',
      'a fact may name each scope kind at most once',
    );
  const project = byKind.get('project') as
    | Extract<OperationalEventScope, { kind: 'project' }>
    | undefined;
  const task = byKind.get('task') as
    | Extract<OperationalEventScope, { kind: 'task' }>
    | undefined;
  const thread = byKind.get('thread') as
    | Extract<OperationalEventScope, { kind: 'thread' }>
    | undefined;
  const run = byKind.get('run') as
    | Extract<OperationalEventScope, { kind: 'run' }>
    | undefined;
  const workspace = byKind.get('workspace') as
    | Extract<OperationalEventScope, { kind: 'workspace' }>
    | undefined;
  if (project && task?.projectId && project.projectId !== task.projectId)
    push(
      diagnostics,
      'scope-conflict',
      'scopes',
      'task.projectId conflicts with project scope',
    );
  if (
    project &&
    workspace?.projectId &&
    project.projectId !== workspace.projectId
  )
    push(
      diagnostics,
      'scope-conflict',
      'scopes',
      'workspace.projectId conflicts with project scope',
    );
  if (task && thread?.taskId && task.taskId !== thread.taskId)
    push(
      diagnostics,
      'scope-conflict',
      'scopes',
      'thread.taskId conflicts with task scope',
    );
  if (thread && run?.threadId && thread.threadId !== run.threadId)
    push(
      diagnostics,
      'scope-conflict',
      'scopes',
      'run.threadId conflicts with thread scope',
    );
}

export type OperationalEventScopeValidationResult =
  | {
      ok: true;
      scopes: OperationalEventScope[];
      diagnostics: OperationalEventDiagnostic[];
    }
  | { ok: false; diagnostics: OperationalEventDiagnostic[] };

/** Shared strict parser for manifest declarations and event envelopes. */
export function validateOperationalEventScopes(
  value: unknown,
): OperationalEventScopeValidationResult {
  const diagnostics: OperationalEventDiagnostic[] = [];
  if (!Array.isArray(value) || value.length > MAX_OPERATIONAL_EVENT_SCOPES) {
    push(
      diagnostics,
      'invalid-scopes',
      'scopes',
      `must contain at most ${MAX_OPERATIONAL_EVENT_SCOPES} typed scopes`,
    );
    return { ok: false, diagnostics };
  }
  const scopes: OperationalEventScope[] = [];
  value.forEach((scope, index) => {
    const parsed = validateScope(scope, index, diagnostics);
    if (parsed) scopes.push(parsed);
  });
  validateScopeRelations(scopes, diagnostics);
  if (diagnostics.length > 0 || scopes.length !== value.length)
    return { ok: false, diagnostics };
  return { ok: true, scopes, diagnostics };
}

/** Creates an inert registry from static definitions; it accepts no callbacks. */
export function createOperationalEventTypeRegistry(
  definitions: readonly OperationalEventTypeDefinition[],
): OperationalEventTypeRegistry {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (
      !NAMESPACE.test(definition.namespace) ||
      !TYPE_NAME.test(definition.name) ||
      !Number.isSafeInteger(definition.version) ||
      definition.version < 1 ||
      !PAYLOAD_SCHEMA.test(definition.payloadSchema)
    )
      throw new TypeError(
        'Operational event type definitions must use bounded namespace, name, version, and payload schema values',
      );
    if (
      (definition.owner === 'station') !==
      (definition.namespace === 'station')
    )
      throw new TypeError(
        'Only Station owns the station namespace; plugin and Kit definitions require their own namespace',
      );
    if (
      definition.owner === 'plugin' &&
      !definition.namespace.startsWith('plugin.')
    )
      throw new TypeError('Plugin definitions require a plugin.<id> namespace');
    if (definition.owner === 'kit' && !definition.namespace.startsWith('kit.'))
      throw new TypeError('Kit definitions require a kit.<id> namespace');
    if (!['exact', 'additive'].includes(definition.compatibility))
      throw new TypeError(
        'Operational event type definitions require a known compatibility policy',
      );
    if (!['active', 'deprecated'].includes(definition.status))
      throw new TypeError(
        'Operational event type definitions require an active or deprecated status',
      );
    const key = `${definition.namespace}.${definition.name}/v${definition.version}`;
    if (seen.has(key))
      throw new TypeError(
        `Operational event type ${key} is registered more than once`,
      );
    seen.add(key);
  }
  return Object.freeze({
    definitions: Object.freeze(definitions.map(immutableDefinition)),
  });
}

export function validateOperationalEventEnvelope(
  value: unknown,
  registry: OperationalEventTypeRegistry = DEFAULT_OPERATIONAL_EVENT_TYPE_REGISTRY,
): OperationalEventValidationResult {
  const diagnostics: OperationalEventDiagnostic[] = [];
  if (!isPlainRecord(value)) {
    push(diagnostics, 'invalid-envelope', '', 'event must be a plain object');
    return { ok: false, diagnostics };
  }
  if (value.schemaVersion !== OPERATIONAL_EVENT_SCHEMA_VERSION) {
    push(
      diagnostics,
      'unknown-schema-version',
      'schemaVersion',
      `expected ${OPERATIONAL_EVENT_SCHEMA_VERSION}`,
    );
    return { ok: false, diagnostics };
  }
  rejectUnknownKeys(value, EVENT_KEYS, '', diagnostics);
  if (!isIdentifier(value.id))
    push(diagnostics, 'invalid-id', 'id', 'must be a bounded identifier');
  const parsedType = parseType(value.type);
  if (!parsedType)
    push(
      diagnostics,
      'invalid-type',
      'type',
      'must be a namespaced type ending in /v<positive integer>',
    );
  const definition = parsedType
    ? registry.definitions.find(
        (candidate) =>
          candidate.namespace === parsedType.namespace &&
          candidate.name === parsedType.name &&
          candidate.version === parsedType.version,
      )
    : undefined;
  if (parsedType && !definition) {
    const known = registry.definitions.some(
      (candidate) =>
        candidate.namespace === parsedType.namespace &&
        candidate.name === parsedType.name,
    );
    push(
      diagnostics,
      known ? 'unknown-type-version' : 'unknown-event-type',
      'type',
      known
        ? 'type version is not supported by this registry'
        : 'type is not registered',
    );
  }
  if (
    !isPlainRecord(value.producer) ||
    !isIdentifier(value.producer.id) ||
    typeof value.producer.version !== 'string' ||
    value.producer.version.length === 0 ||
    value.producer.version.length > 128 ||
    value.producer.version !== value.producer.version.trim()
  )
    push(
      diagnostics,
      'invalid-producer',
      'producer',
      'must carry bounded id and version strings',
    );
  else
    rejectUnknownKeys(
      value.producer,
      ['id', 'version'],
      'producer',
      diagnostics,
    );
  if (!isCanonicalRfc3339Utc(value.occurredAt))
    push(
      diagnostics,
      'invalid-timestamp',
      'occurredAt',
      'must be an ISO-8601 UTC instant',
    );
  if (
    value.sequence !== undefined &&
    (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0)
  )
    push(
      diagnostics,
      'invalid-sequence',
      'sequence',
      'must be a non-negative safe integer when present',
    );
  if (value.correlationId !== undefined && !isIdentifier(value.correlationId))
    push(
      diagnostics,
      'invalid-correlation',
      'correlationId',
      'must be a bounded identifier when present',
    );
  if (value.causationId !== undefined && !isIdentifier(value.causationId))
    push(
      diagnostics,
      'invalid-causation',
      'causationId',
      'must be a bounded identifier when present',
    );
  let scopes: OperationalEventScope[] = [];
  const validatedScopes = validateOperationalEventScopes(value.scopes);
  diagnostics.push(...validatedScopes.diagnostics);
  if (validatedScopes.ok) scopes = validatedScopes.scopes;
  let payload: OperationalEventPayload | undefined;
  if (
    !isPlainRecord(value.payload) ||
    typeof value.payload.schema !== 'string' ||
    !PAYLOAD_SCHEMA.test(value.payload.schema)
  )
    push(
      diagnostics,
      'invalid-payload-schema',
      'payload.schema',
      'must be a versioned payload schema identity',
    );
  else {
    rejectUnknownKeys(
      value.payload,
      ['schema', 'data'],
      'payload',
      diagnostics,
    );
    const budget = { strings: 0, items: 0, overLimit: false };
    const data = cloneJson(value.payload.data, 0, budget, new Set());
    if (data === undefined)
      push(
        diagnostics,
        budget.overLimit ? 'payload-too-large' : 'invalid-payload',
        'payload.data',
        budget.overLimit
          ? `must be at most ${MAX_OPERATIONAL_EVENT_PAYLOAD_BYTES} bytes`
          : `must be bounded JSON data at depth ${MAX_OPERATIONAL_EVENT_JSON_DEPTH} or less`,
      );
    else {
      const bytes = new TextEncoder().encode(
        JSON.stringify(canonicalizeForDigest(data)),
      ).byteLength;
      if (bytes > MAX_OPERATIONAL_EVENT_PAYLOAD_BYTES)
        push(
          diagnostics,
          'payload-too-large',
          'payload.data',
          `must be at most ${MAX_OPERATIONAL_EVENT_PAYLOAD_BYTES} bytes`,
        );
      else payload = { schema: value.payload.schema, data };
    }
  }
  if (
    definition &&
    value.payload &&
    isPlainRecord(value.payload) &&
    value.payload.schema !== definition.payloadSchema
  )
    push(
      diagnostics,
      'invalid-payload-schema',
      'payload.schema',
      'does not match the registered event type schema',
    );
  if (!['public', 'private', 'sensitive'].includes(value.privacy as string))
    push(
      diagnostics,
      'invalid-privacy',
      'privacy',
      'must be public, private, or sensitive',
    );
  if (
    !['ephemeral', 'durable', 'projection', 'evidence-eligible'].includes(
      value.delivery as string,
    )
  )
    push(
      diagnostics,
      'invalid-delivery',
      'delivery',
      'must name a supported delivery class',
    );
  if (parsedType?.namespace.startsWith('plugin.')) {
    const pluginId = parsedType.namespace.slice('plugin.'.length);
    const scope = scopes.find(
      (
        candidate,
      ): candidate is Extract<OperationalEventScope, { kind: 'plugin' }> =>
        candidate.kind === 'plugin',
    );
    if (!scope || scope.pluginId !== pluginId)
      push(
        diagnostics,
        'namespace-not-authorized',
        'scopes',
        'plugin event types require a matching plugin scope',
      );
  }
  if (parsedType?.namespace.startsWith('kit.')) {
    const kitId = parsedType.namespace.slice('kit.'.length);
    const scope = scopes.find(
      (
        candidate,
      ): candidate is Extract<OperationalEventScope, { kind: 'kit' }> =>
        candidate.kind === 'kit',
    );
    if (!scope || scope.kitId !== kitId)
      push(
        diagnostics,
        'namespace-not-authorized',
        'scopes',
        'Kit event types require a matching Kit scope',
      );
  }
  if (definition?.status === 'deprecated')
    push(
      diagnostics,
      'type-deprecated',
      'type',
      'registered type is deprecated; producers should emit its active replacement',
    );
  const failures = diagnostics.filter(
    (diagnostic) => diagnostic.code !== 'type-deprecated',
  );
  if (
    failures.length > 0 ||
    !definition ||
    !payload ||
    !parsedType ||
    !isIdentifier(value.id) ||
    !isPlainRecord(value.producer) ||
    !isIdentifier(value.producer.id) ||
    typeof value.producer.version !== 'string' ||
    !isCanonicalRfc3339Utc(value.occurredAt) ||
    !Array.isArray(value.scopes) ||
    scopes.length !== value.scopes.length
  )
    return { ok: false, diagnostics };
  return {
    ok: true,
    diagnostics,
    event: {
      schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
      id: value.id,
      type: value.type as string,
      producer: { id: value.producer.id, version: value.producer.version },
      occurredAt: value.occurredAt,
      ...(value.sequence === undefined
        ? {}
        : { sequence: value.sequence as number }),
      ...(value.correlationId === undefined
        ? {}
        : { correlationId: value.correlationId as string }),
      ...(value.causationId === undefined
        ? {}
        : { causationId: value.causationId as string }),
      scopes,
      payload,
      privacy: value.privacy as OperationalEventPrivacyClass,
      delivery: value.delivery as OperationalEventDeliveryClass,
    },
  };
}

/** Returns deterministic bytes an external evidence adapter may hash; it constructs no trust bundle. */
export function operationalEventEvidenceInput(
  value: unknown,
  registry: OperationalEventTypeRegistry = DEFAULT_OPERATIONAL_EVENT_TYPE_REGISTRY,
): OperationalEventEvidenceInputResult {
  const validated = validateOperationalEventEnvelope(value, registry);
  if (!validated.ok) return validated;
  if (validated.diagnostics.length > 0) {
    return { ok: false, diagnostics: validated.diagnostics };
  }
  if (validated.event.delivery !== 'evidence-eligible')
    return {
      ok: false,
      diagnostics: [
        {
          code: 'evidence-ineligible',
          path: 'delivery',
          message: 'only evidence-eligible events expose digest input',
        },
      ],
    };
  return {
    ok: true,
    eventId: validated.event.id,
    digestInput: JSON.stringify(canonicalizeForDigest(validated.event)),
  };
}
