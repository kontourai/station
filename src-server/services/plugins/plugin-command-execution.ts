import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import {
  OPERATIONAL_EVENT_SCHEMA_VERSION,
  type OperationalEventEnvelope,
} from '@kontourai/station-contracts/operational-event';
import {
  isCanonicalPluginId,
  PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION,
  type PluginCommandContribution,
  type PluginCommandExecutionReceipt,
  type PluginCommandExecutionRequest,
  type PluginCommandResolvedTarget,
  STATION_PLUGIN_EXTENSION_ID,
} from '@kontourai/station-contracts/plugin';
import type { OperationalEventPublisher } from '../operational-events/operational-event-outbox.js';
import { pluginCommandGeneration } from './plugin-command-contributions.js';
import { readPluginManifestFileSync } from './plugin-manifest-loader.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const GENERATION = /^[a-f0-9]{64}$/;
const SURFACE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type PluginCommandExecutionRefusal =
  | 'invalid-request'
  | 'plugin-not-installed'
  | 'plugin-identity-mismatch'
  | 'plugin-version-changed'
  | 'command-generation-changed'
  | 'command-not-declared'
  | 'command-not-executable'
  | 'target-mismatch'
  | 'permission-denied';

export type PluginCommandExecutionOutcome =
  | { kind: 'authorized'; receipt: PluginCommandExecutionReceipt }
  | { kind: 'refused'; reason: PluginCommandExecutionRefusal }
  | { kind: 'unavailable' };

export interface PluginCommandExecutionAuthority {
  authorize(
    value: unknown,
    clientOrigin: ClientOrigin,
  ): PluginCommandExecutionOutcome;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const fields = [...expected].sort();
  return (
    actual.length === fields.length &&
    actual.every((field, index) => field === fields[index])
  );
}

function parseTarget(value: unknown): PluginCommandResolvedTarget | undefined {
  if (!record(value) || typeof value.kind !== 'string') return undefined;
  if (
    value.kind === 'surface' &&
    exactKeys(value, ['kind', 'surfaceId']) &&
    typeof value.surfaceId === 'string' &&
    SURFACE_ID.test(value.surfaceId)
  ) {
    return { kind: 'surface', surfaceId: value.surfaceId };
  }
  if (
    value.kind === 'composer' &&
    exactKeys(value, ['kind', 'sessionId']) &&
    typeof value.sessionId === 'string' &&
    ID.test(value.sessionId)
  ) {
    return { kind: 'composer', sessionId: value.sessionId };
  }
  return undefined;
}

function parseRequest(
  value: unknown,
): PluginCommandExecutionRequest | undefined {
  if (!record(value)) return undefined;
  if (
    !exactKeys(value, [
      'schemaVersion',
      'requestId',
      'pluginId',
      'pluginVersion',
      'commandGeneration',
      'commandId',
      'target',
    ]) ||
    value.schemaVersion !== PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION ||
    typeof value.requestId !== 'string' ||
    !ID.test(value.requestId) ||
    !isCanonicalPluginId(value.pluginId) ||
    typeof value.pluginVersion !== 'string' ||
    !VERSION.test(value.pluginVersion) ||
    typeof value.commandGeneration !== 'string' ||
    !GENERATION.test(value.commandGeneration) ||
    typeof value.commandId !== 'string' ||
    !value.commandId.startsWith(`${value.pluginId}.`) ||
    !ID.test(value.commandId)
  ) {
    return undefined;
  }
  const target = parseTarget(value.target);
  if (!target) return undefined;
  return {
    schemaVersion: PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION,
    requestId: value.requestId,
    pluginId: value.pluginId,
    pluginVersion: value.pluginVersion,
    commandGeneration: value.commandGeneration,
    commandId: value.commandId,
    target,
  };
}

function targetMatches(
  command: PluginCommandContribution,
  target: PluginCommandResolvedTarget,
): boolean {
  return command.intent.kind === 'navigate'
    ? target.kind === 'surface' && target.surfaceId === command.intent.surfaceId
    : command.intent.kind === 'seed-composer'
      ? target.kind === 'composer'
      : false;
}

function eventFor(input: {
  request: PluginCommandExecutionRequest;
  origin: ClientOrigin;
  decision: 'authorized' | 'refused';
  outcome: 'admitted' | 'refused';
  reason?: PluginCommandExecutionRefusal;
  id?: string;
  occurredAt?: string;
}): OperationalEventEnvelope {
  return {
    schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
    id: input.id ?? `plugin-command-${randomUUID()}`,
    type: 'station.plugin-command.execution/v1',
    producer: { id: 'station-server', version: '1.0' },
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    correlationId: input.request.requestId,
    scopes: [{ kind: 'plugin', pluginId: input.request.pluginId }],
    payload: {
      schema: 'station.plugin-command.execution/v1',
      data: {
        pluginId: input.request.pluginId,
        pluginVersion: input.request.pluginVersion,
        commandGeneration: input.request.commandGeneration,
        commandId: input.request.commandId,
        actor: structuredClone(input.origin.actor),
        reportedSurface: input.origin.reported.surface,
        target: structuredClone(input.request.target),
        decision: input.decision,
        outcome: input.outcome,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    },
    privacy: 'private',
    delivery: 'durable',
  };
}

/**
 * Revalidates one installed declaration and durably records admission before
 * the browser performs its local navigation or composer effect.
 */
export function createPluginCommandExecutionAuthority(options: {
  pluginsDir: string;
  publisher: OperationalEventPublisher;
  grantedPermissions(
    pluginId: string,
  ):
    | { kind: 'available'; permissions: readonly string[] }
    | { kind: 'unavailable' };
}): PluginCommandExecutionAuthority {
  const append = (
    request: PluginCommandExecutionRequest,
    origin: ClientOrigin,
    decision: 'authorized' | 'refused',
    outcome: 'admitted' | 'refused',
    reason?: PluginCommandExecutionRefusal,
  ) => {
    const event = eventFor({ request, origin, decision, outcome, reason });
    const persisted = options.publisher.append(event);
    return persisted.kind === 'appended' || persisted.kind === 'duplicate'
      ? event
      : undefined;
  };

  const refuse = (
    request: PluginCommandExecutionRequest,
    origin: ClientOrigin,
    reason: PluginCommandExecutionRefusal,
  ): PluginCommandExecutionOutcome =>
    append(request, origin, 'refused', 'refused', reason)
      ? { kind: 'refused', reason }
      : { kind: 'unavailable' };

  const authority: PluginCommandExecutionAuthority = {
    authorize(
      value: unknown,
      origin: ClientOrigin,
    ): PluginCommandExecutionOutcome {
      const request = parseRequest(value);
      if (!request) return { kind: 'refused', reason: 'invalid-request' };
      const manifestPath = join(
        options.pluginsDir,
        request.pluginId,
        'plugin.json',
      );
      if (!existsSync(manifestPath)) {
        return refuse(request, origin, 'plugin-not-installed');
      }
      let manifest: ReturnType<typeof readPluginManifestFileSync>;
      try {
        manifest = readPluginManifestFileSync(manifestPath);
      } catch {
        return { kind: 'unavailable' };
      }
      if (manifest.name !== request.pluginId) {
        return refuse(request, origin, 'plugin-identity-mismatch');
      }
      if (manifest.version !== request.pluginVersion) {
        return refuse(request, origin, 'plugin-version-changed');
      }
      if (pluginCommandGeneration(manifest) !== request.commandGeneration) {
        return refuse(request, origin, 'command-generation-changed');
      }
      const command = manifest.extensions?.[
        STATION_PLUGIN_EXTENSION_ID
      ]?.commands?.find((candidate) => candidate.id === request.commandId);
      if (!command) return refuse(request, origin, 'command-not-declared');
      if (
        command.argument ||
        command.intent.kind === 'invoke-declared-plugin-operation'
      ) {
        return refuse(request, origin, 'command-not-executable');
      }
      if (!targetMatches(command, request.target)) {
        return refuse(request, origin, 'target-mismatch');
      }
      if (command.requires?.includes('plugin-server')) {
        let permissions: ReturnType<typeof options.grantedPermissions>;
        try {
          permissions = options.grantedPermissions(request.pluginId);
        } catch {
          permissions = { kind: 'unavailable' };
        }
        if (permissions.kind === 'unavailable') return { kind: 'unavailable' };
        if (!permissions.permissions.includes('plugin.server')) {
          return refuse(request, origin, 'permission-denied');
        }
      }
      const event = append(request, origin, 'authorized', 'admitted');
      if (!event) return { kind: 'unavailable' };
      return {
        kind: 'authorized',
        receipt: {
          schemaVersion: PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION,
          receiptId: event.id,
          requestId: request.requestId,
          pluginId: request.pluginId,
          pluginVersion: request.pluginVersion,
          commandGeneration: request.commandGeneration,
          commandId: request.commandId,
          target: structuredClone(request.target),
          actor: structuredClone(origin.actor),
          reportedSurface: origin.reported.surface,
          decision: 'authorized',
          outcome: 'admitted',
          recordedAt: event.occurredAt,
        },
      };
    },
  };
  return Object.freeze(authority);
}
