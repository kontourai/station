import type { PluginCommandRequirement } from '@kontourai/station-contracts/agent-plugin';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import type {
  PluginCommandEffectAdmissionRequest,
  PluginCommandEffectReceipt,
  PluginCommandEffectRefusalReason,
  PluginCommandEffectRequirementContext,
} from '@kontourai/station-contracts/plugin-command-effect';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { PackageMcpAdmissionJournal } from './package-mcp-admission.js';
import { isExecutablePluginCommand } from './plugin-command-declarations.js';
import {
  isPluginCommandClientId,
  isPluginCommandDocumentKey,
  type PluginCommandEffectService,
  parsePluginCommandEffectTarget,
} from './plugin-command-effects.js';
import { withPluginContentLock } from './plugin-content-integrity.js';
import {
  PluginGrantsUnavailableError,
  withPluginPermissionInvocation,
} from './plugin-permissions.js';
import {
  capturePluginRuntimeArtifactAsync,
  type PluginRuntimeArtifact,
  pluginInstallationGeneration,
} from './plugin-runtime-artifact.js';

export type PluginCommandRequirementResolution =
  | 'available'
  | 'missing'
  | 'unavailable';

export type PluginCommandEffectAdmissionResult =
  | { kind: 'admitted'; receipt: PluginCommandEffectReceipt }
  | { kind: 'refused'; reason: PluginCommandEffectRefusalReason };

export interface PluginCommandEffectAdmissionDeps {
  pluginsDir: string;
  projectHomeDir: string;
  journal?: PackageMcpAdmissionJournal;
  effects: PluginCommandEffectService;
  /** Invisible must be indistinguishable from absent; checked before any read. */
  canSeePlugin(principal: PrincipalRef, pluginId: string): boolean;
  resolveRequirement: PluginCommandRequirementResolver;
  /** Test seam; production reads the installed artifact. */
  captureArtifact?(pluginId: string): Promise<PluginRuntimeArtifact | null>;
  /**
   * Test seam run immediately before the ledger append, inside every lock
   * and lease the append runs under. Production omits it.
   */
  beforeRecord?(input: {
    pluginId: string;
    requiresPluginServer: boolean;
  }): Promise<void>;
}

export type PluginCommandRequirementResolver = (input: {
  requirement: Exclude<PluginCommandRequirement, 'plugin-server'>;
  principal: PrincipalRef;
  request: PluginCommandEffectAdmissionRequest;
  /** The caller's HTTP request, for authorization that reads its credential. */
  authority: Request;
}) => Promise<PluginCommandRequirementResolution>;

/**
 * Requirement checks that answer for the CALLER, never for an id alone.
 *
 * - `active-chat` and `session` use the session read predicate every other
 *   session read goes through; a session the caller cannot read is `missing`,
 *   exactly like one that does not exist. A composer target must be that
 *   same session.
 * - `project` and `task` have no per-principal read predicate on main (see
 *   `routes/board.ts`'s authorization note): Station answers project and task
 *   existence to any caller of its project and task routes. These checks use
 *   that same existence authority, so they reveal nothing those routes do not.
 */
export function createPluginCommandRequirementResolver(deps: {
  canReadSession(sessionId: string, authority: Request): boolean;
  projectExists(projectSlug: string): boolean;
  taskInProject(taskId: string, projectSlug: string | undefined): boolean;
}): PluginCommandRequirementResolver {
  return async ({ requirement, request, authority }) => {
    const context = request.context ?? {};
    if (requirement === 'active-chat' || requirement === 'session') {
      const sessionId =
        requirement === 'active-chat'
          ? context.activeChatSessionId
          : context.sessionId;
      if (!sessionId) return 'missing';
      if (
        request.target.kind === 'composer' &&
        request.target.sessionId !== sessionId
      )
        return 'missing';
      return deps.canReadSession(sessionId, authority)
        ? 'available'
        : 'missing';
    }
    if (requirement === 'project')
      return context.projectSlug && deps.projectExists(context.projectSlug)
        ? 'available'
        : 'missing';
    return context.taskId &&
      deps.taskInProject(context.taskId, context.projectSlug)
      ? 'available'
      : 'missing';
  };
}

const CONTEXT_FIELDS = [
  'activeChatSessionId',
  'sessionId',
  'projectSlug',
  'taskId',
] as const;
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strict route-seam parse; unknown fields are refused, never ignored. */
function parsePluginCommandEffectAdmissionRequest(
  value: unknown,
): PluginCommandEffectAdmissionRequest | null {
  if (!isRecord(value)) return null;
  const allowed = [
    'documentId',
    'documentKey',
    'requestId',
    'installationGeneration',
    'commandId',
    'target',
    'context',
    'issuedAt',
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  const target = parsePluginCommandEffectTarget(value.target);
  if (
    !isPluginCommandClientId(value.documentId) ||
    !isPluginCommandDocumentKey(value.documentKey) ||
    !isPluginCommandClientId(value.requestId) ||
    typeof value.installationGeneration !== 'string' ||
    value.installationGeneration.length === 0 ||
    value.installationGeneration.length > 256 ||
    !Number.isSafeInteger(value.issuedAt) ||
    typeof value.commandId !== 'string' ||
    value.commandId.length > 127 ||
    !target
  )
    return null;
  let context: PluginCommandEffectRequirementContext | undefined;
  if (value.context !== undefined) {
    if (!isRecord(value.context)) return null;
    const candidate = value.context;
    if (
      Object.keys(candidate).some(
        (key) => !(CONTEXT_FIELDS as readonly string[]).includes(key),
      ) ||
      CONTEXT_FIELDS.some(
        (field) =>
          candidate[field] !== undefined &&
          (typeof candidate[field] !== 'string' ||
            !CONTEXT_ID.test(candidate[field] as string)),
      )
    )
      return null;
    context = Object.fromEntries(
      CONTEXT_FIELDS.filter((field) => candidate[field] !== undefined).map(
        (field) => [field, candidate[field] as string],
      ),
    );
  }
  return {
    documentId: value.documentId,
    documentKey: value.documentKey,
    requestId: value.requestId,
    issuedAt: value.issuedAt as number,
    installationGeneration: value.installationGeneration,
    commandId: value.commandId,
    target,
    ...(context ? { context } : {}),
  };
}

class PluginServerPermissionRefused extends Error {}

/**
 * LP-A orchestration. Everything that can change the admitted authority for a
 * plugin is serialized with this: removal and update hold the same content
 * lock, and a `plugin.server` withdrawal waits on the grants read lease the
 * append runs inside.
 */
export function createPluginCommandEffectAdmission(
  deps: PluginCommandEffectAdmissionDeps,
) {
  const capture =
    deps.captureArtifact ??
    ((pluginId: string) =>
      capturePluginRuntimeArtifactAsync(
        deps.pluginsDir,
        pluginId,
        deps.journal,
      ));
  const refuse = (
    reason: PluginCommandEffectRefusalReason,
  ): PluginCommandEffectAdmissionResult => ({ kind: 'refused', reason });

  return Object.freeze({
    async admit(input: {
      principal: PrincipalRef;
      pluginId: string;
      body: unknown;
      authority: Request;
    }): Promise<PluginCommandEffectAdmissionResult> {
      const { principal, pluginId } = input;
      if (!isCanonicalPluginId(pluginId)) return refuse('not-found');
      let visible: boolean;
      try {
        visible = deps.canSeePlugin(principal, pluginId);
      } catch {
        return refuse('unavailable');
      }
      // Before parsing: an invisible plugin answers exactly as an absent one.
      if (!visible) return refuse('not-found');
      const request = parsePluginCommandEffectAdmissionRequest(input.body);
      if (!request) return refuse('invalid-request');
      try {
        return await withPluginContentLock(
          deps.pluginsDir,
          pluginId,
          async () => {
            const artifact = await capture(pluginId);
            if (!artifact || artifact.manifest.name !== pluginId)
              return refuse('not-found');
            if (
              pluginInstallationGeneration(artifact) !==
              request.installationGeneration
            )
              return refuse('generation-changed');
            const command = artifact.manifest.commands?.find(
              (candidate) => candidate.id === request.commandId,
            );
            if (!command) return refuse('command-not-declared');
            if (!isExecutablePluginCommand(command))
              return refuse('command-not-executable');
            const content =
              command.intent.kind === 'navigate'
                ? request.target.kind === 'destination' &&
                  request.target.destinationId === command.intent.surfaceId
                  ? {
                      kind: 'navigate' as const,
                      destinationId: command.intent.surfaceId,
                    }
                  : null
                : request.target.kind === 'composer'
                  ? {
                      kind: 'seed-composer' as const,
                      sessionId: request.target.sessionId,
                      text: command.intent.text,
                    }
                  : null;
            if (!content) return refuse('target-mismatch');
            const requiresPluginServer =
              command.requires?.includes('plugin-server') ?? false;
            if (requiresPluginServer && !artifact.manifest.serverModule)
              return refuse('requirement-not-satisfied');
            for (const requirement of command.requires ?? []) {
              if (requirement === 'plugin-server') continue;
              let resolution: PluginCommandRequirementResolution;
              try {
                resolution = await deps.resolveRequirement({
                  requirement,
                  principal,
                  request,
                  authority: input.authority,
                });
              } catch {
                resolution = 'unavailable';
              }
              if (resolution === 'unavailable') return refuse('unavailable');
              if (resolution === 'missing')
                return refuse('requirement-not-satisfied');
            }
            // The awaited checks above yielded; the bytes must still be the
            // ones they judged.
            if (!(await artifact.isCurrentAsync()))
              return refuse('generation-changed');
            const record = async () => {
              await deps.beforeRecord?.({ pluginId, requiresPluginServer });
              return deps.effects.recordAdmission({
                principalId: principal.id,
                pluginId,
                installationGeneration: request.installationGeneration,
                requiresPluginServer,
                commandId: command.id,
                target: request.target,
                content,
                documentId: request.documentId,
                documentKey: request.documentKey,
                requestId: request.requestId,
                issuedAt: request.issuedAt,
              });
            };
            if (!requiresPluginServer) return await record();
            let reached = false;
            try {
              return await withPluginPermissionInvocation(
                deps.projectHomeDir,
                pluginId,
                'plugin.server',
                async () => {
                  reached = true;
                  return await record();
                },
                artifact,
              );
            } catch (error) {
              if (error instanceof PluginGrantsUnavailableError)
                return refuse('unavailable');
              if (!reached) throw new PluginServerPermissionRefused();
              throw error;
            }
          },
        );
      } catch (error) {
        if (error instanceof PluginServerPermissionRefused)
          return refuse('permission-unavailable');
        return refuse('unavailable');
      }
    },
  });
}

export type PluginCommandEffectAdmission = ReturnType<
  typeof createPluginCommandEffectAdmission
>;
