import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import {
  type PluginCommandContribution,
  type PluginCommandRequirement,
  STATION_AGENT_PLUGIN_EXTENSION_ID,
} from '@kontourai/station-contracts/agent-plugin';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import {
  OPERATIONAL_EVENT_SCHEMA_VERSION,
  type OperationalEventEnvelope,
} from '@kontourai/station-contracts/operational-event';
import {
  isCanonicalPluginId,
  PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION,
  type PluginCommandExecutionReceipt,
  type PluginCommandExecutionRequest,
  type PluginCommandResolvedContext,
  type PluginCommandResolvedTarget,
} from '@kontourai/station-contracts/plugin';
import type { OperationalEventPublisher } from '../operational-events/operational-event-outbox.js';
import { pluginCommandGeneration } from './plugin-command-contributions.js';
import { withPluginContentLock } from './plugin-content-integrity.js';
import { readPluginManifestFileSync } from './plugin-manifest-loader.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GENERATION = /^[a-f0-9]{64}$/;
const SURFACE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_PLUGIN_VERSION_LENGTH = 256;

export type PluginCommandExecutionRefusal =
  | 'invalid-request'
  | 'plugin-not-installed'
  | 'plugin-identity-mismatch'
  | 'plugin-version-changed'
  | 'command-generation-changed'
  | 'command-not-declared'
  | 'command-not-executable'
  | 'target-mismatch'
  | 'requirement-not-satisfied'
  | 'permission-denied';

export type PluginCommandExecutionOutcome =
  | { kind: 'authorized'; receipt: PluginCommandExecutionReceipt }
  | { kind: 'refused'; reason: PluginCommandExecutionRefusal }
  | { kind: 'unavailable' };

export interface PluginCommandExecutionAuthority {
  authorize(
    value: unknown,
    clientOrigin: ClientOrigin,
  ): Promise<PluginCommandExecutionOutcome>;
}

export type PluginCommandRequirementResolution =
  | { kind: 'available' }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

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

function parseContext(
  value: unknown,
): PluginCommandResolvedContext | undefined {
  if (
    !record(value) ||
    !Object.keys(value).every((field) =>
      ['activeChatSessionId', 'projectSlug', 'sessionId', 'taskId'].includes(
        field,
      ),
    )
  ) {
    return undefined;
  }
  for (const field of [
    'activeChatSessionId',
    'projectSlug',
    'sessionId',
    'taskId',
  ] as const) {
    const candidate = value[field];
    if (
      candidate !== undefined &&
      (typeof candidate !== 'string' || !ID.test(candidate))
    ) {
      return undefined;
    }
  }
  return {
    ...(value.activeChatSessionId
      ? { activeChatSessionId: value.activeChatSessionId as string }
      : {}),
    ...(value.projectSlug ? { projectSlug: value.projectSlug as string } : {}),
    ...(value.sessionId ? { sessionId: value.sessionId as string } : {}),
    ...(value.taskId ? { taskId: value.taskId as string } : {}),
  };
}

function validPluginVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PLUGIN_VERSION_LENGTH &&
    value.trim().length > 0 &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  );
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
      'context',
    ]) ||
    value.schemaVersion !== PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION ||
    typeof value.requestId !== 'string' ||
    !ID.test(value.requestId) ||
    !isCanonicalPluginId(value.pluginId) ||
    !validPluginVersion(value.pluginVersion) ||
    typeof value.commandGeneration !== 'string' ||
    !GENERATION.test(value.commandGeneration) ||
    typeof value.commandId !== 'string' ||
    !value.commandId.startsWith(`${value.pluginId}.`) ||
    !ID.test(value.commandId)
  ) {
    return undefined;
  }
  const target = parseTarget(value.target);
  const context = parseContext(value.context);
  if (!target || !context) return undefined;
  return {
    schemaVersion: PLUGIN_COMMAND_EXECUTION_SCHEMA_VERSION,
    requestId: value.requestId,
    pluginId: value.pluginId,
    pluginVersion: value.pluginVersion,
    commandGeneration: value.commandGeneration,
    commandId: value.commandId,
    target,
    context,
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

function resolveInstalledManifestPath(
  pluginsDir: string,
  pluginId: string,
): string | undefined {
  if (!existsSync(pluginsDir)) return undefined;
  const pluginsStat = lstatSync(pluginsDir);
  if (pluginsStat.isSymbolicLink() || !pluginsStat.isDirectory()) {
    throw new Error('Plugin root is not a physical directory');
  }
  const pluginDir = join(pluginsDir, pluginId);
  if (!existsSync(pluginDir)) return undefined;
  const pluginStat = lstatSync(pluginDir);
  if (pluginStat.isSymbolicLink() || !pluginStat.isDirectory()) {
    throw new Error('Installed plugin is not a physical directory');
  }
  const manifestPath = join(pluginDir, 'plugin.json');
  if (!existsSync(manifestPath)) return undefined;
  const manifestStat = lstatSync(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error('Installed plugin manifest is not a physical file');
  }
  const pluginsRoot = realpathSync(pluginsDir);
  const pluginRoot = realpathSync(pluginDir);
  const manifestRealPath = realpathSync(manifestPath);
  for (const candidate of [pluginRoot, manifestRealPath]) {
    const candidateRelative = relative(pluginsRoot, candidate);
    if (
      candidateRelative === '' ||
      candidateRelative.startsWith('..') ||
      isAbsolute(candidateRelative)
    ) {
      throw new Error('Installed plugin manifest escapes plugin root');
    }
  }
  const manifestRelative = relative(pluginRoot, manifestRealPath);
  if (
    manifestRelative === '' ||
    manifestRelative.startsWith('..') ||
    isAbsolute(manifestRelative)
  ) {
    throw new Error('Installed plugin manifest escapes installed plugin');
  }
  return manifestPath;
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
  resolveRequirement(input: {
    requirement: Exclude<PluginCommandRequirement, 'plugin-server'>;
    request: PluginCommandExecutionRequest;
    origin: ClientOrigin;
  }):
    | PluginCommandRequirementResolution
    | Promise<PluginCommandRequirementResolution>;
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
    async authorize(
      value: unknown,
      origin: ClientOrigin,
    ): Promise<PluginCommandExecutionOutcome> {
      const request = parseRequest(value);
      if (!request) return { kind: 'refused', reason: 'invalid-request' };
      try {
        return await withPluginContentLock(
          options.pluginsDir,
          request.pluginId,
          async () => {
            const manifestPath = resolveInstalledManifestPath(
              options.pluginsDir,
              request.pluginId,
            );
            if (!manifestPath) {
              return refuse(request, origin, 'plugin-not-installed');
            }
            const manifest = readPluginManifestFileSync(manifestPath);
            if (manifest.name !== request.pluginId) {
              return refuse(request, origin, 'plugin-identity-mismatch');
            }
            if (manifest.version !== request.pluginVersion) {
              return refuse(request, origin, 'plugin-version-changed');
            }
            if (
              pluginCommandGeneration(manifest) !== request.commandGeneration
            ) {
              return refuse(request, origin, 'command-generation-changed');
            }
            const command = manifest.extensions?.[
              STATION_AGENT_PLUGIN_EXTENSION_ID
            ]?.commands?.find(
              (candidate) => candidate.id === request.commandId,
            );
            if (!command)
              return refuse(request, origin, 'command-not-declared');
            if (
              command.argument ||
              command.intent.kind === 'invoke-declared-plugin-operation'
            ) {
              return refuse(request, origin, 'command-not-executable');
            }
            if (!targetMatches(command, request.target)) {
              return refuse(request, origin, 'target-mismatch');
            }
            for (const requirement of command.requires ?? []) {
              if (requirement === 'plugin-server') {
                if (typeof manifest.serverModule !== 'string') {
                  return refuse(request, origin, 'requirement-not-satisfied');
                }
                let permissions: ReturnType<typeof options.grantedPermissions>;
                try {
                  permissions = options.grantedPermissions(request.pluginId);
                } catch {
                  permissions = { kind: 'unavailable' };
                }
                if (permissions.kind === 'unavailable') {
                  return { kind: 'unavailable' };
                }
                if (!permissions.permissions.includes('plugin.server')) {
                  return refuse(request, origin, 'permission-denied');
                }
                continue;
              }
              let resolution: PluginCommandRequirementResolution;
              try {
                resolution = await options.resolveRequirement({
                  requirement,
                  request,
                  origin,
                });
              } catch {
                resolution = { kind: 'unavailable' };
              }
              if (resolution.kind === 'unavailable') {
                return { kind: 'unavailable' };
              }
              if (resolution.kind === 'missing') {
                return refuse(request, origin, 'requirement-not-satisfied');
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
        );
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
  return Object.freeze(authority);
}
