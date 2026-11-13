import { MANAGED_POLICY_REMOTE_CLIENTS_CODE } from '@kontourai/station-contracts/managed-policy';
import type { TelemetryPublisherId } from '@kontourai/station-contracts/product-telemetry';
import { isApprovalMode } from '@kontourai/station-contracts/provider';
import { isTelemetryPublisherId } from '@kontourai/station-shared/plugin-telemetry';
import { lanDiscoveryFor } from '../../services/connections/lan-discovery.js';
/**
 * Config Routes - app configuration management
 */

import { normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseEngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import {
  type AppConfig,
  appConfigSemanticError,
  describeFirstRunTransitionViolation,
  type FirstRunTransitionRequest,
  firstRunStateForTransition,
} from '@kontourai/station-contracts/config';
import {
  FLEET_CONTRIBUTION_SCOPE_KEY,
  PROJECT_CONTRIBUTION_SCOPE_KEY_PREFIX,
  parseContributionScopeKey,
} from '@kontourai/station-contracts/contribution';
import {
  PAIRING_SCOPE_INFERENCE_INVOKE,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import {
  TELEMETRY_FEEDBACK_REASONS,
  type TelemetryFeedbackReason,
  type TelemetryTier,
} from '@kontourai/station-contracts/product-telemetry';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { readProjectOverrides } from '@kontourai/station-contracts/project-settings-overrides';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { type Context, Hono } from 'hono';
import type { ConfigLoader } from '../../domain/config-loader.js';
import { mergeAppConfigUpdate } from '../../domain/config-loader-app.js';
import {
  installedManagedAppSettings,
  ManagedSettingLockedError,
  managedSettingRefusalBody,
  overlayManagedAppSettings,
  withoutLockedNoOps,
} from '../../domain/managed-settings.js';
import { FileStorageNotFoundError } from '../../domain/project-file-transactions.js';
import {
  buildAppConfigProvenance,
  sanitizeAppConfigUpdate,
} from '../../domain/settings-registry-server.js';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { telemetryChoiceDefaults } from '../../domain/telemetry-configuration.js';
import { InvalidPathSegmentError } from '../../knowledge-index/path-safety.js';
import {
  persistableCredentialProfiles,
  projectPublicCredentialProfiles,
} from '../../providers/app-home/credential-profile-registry.js';
import type { AgentConfigurationMutationRunner } from '../../runtime/types.js';
import {
  isOperatorInPersonNotAgent,
  mayGrantFullAccess,
} from '../../security/coding-authority.js';
import {
  clampToManagedCeiling,
  managedCeilingRefuses,
} from '../../security/managed-approval-ceiling.js';
import {
  managedCapabilityRefusalBody,
  telemetryAllowedByManagedPolicy,
} from '../../security/managed-capability-limits.js';
import {
  grantedPairingScope,
  type PairingScopeContextStore,
} from '../../security/pairing-route-scopes.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { mayRaiseTelemetryChoice } from '../../security/telemetry-choice-authority.js';
import {
  LOG_LEVELS,
  type LogLevel,
  LogLevelEditService,
} from '../../services/config/log-level-edit-service.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import {
  TERMINAL_RETENTION_KEYS,
  terminalRetentionProblem,
} from '../../services/terminal/terminal-retention.js';
import { defaultTerminalShell } from '../../services/terminal/terminal-shells.js';
import { configOps } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import {
  fullAccessRefusal,
  managedApprovalCeilingRefusal,
} from '../orchestration/approval-authority.js';

/** Thrown inside the serialized config mutation; mapped to the 403 below. */
const FULL_ACCESS_DEFAULT_NOT_GRANTED = 'FULL_ACCESS_DEFAULT_NOT_GRANTED';
const DEFAULT_ABOVE_MANAGED_CEILING = 'DEFAULT_ABOVE_MANAGED_CEILING';

import {
  COMMAND_NOT_GRANTED_CODE,
  requestMayBeAnAgent,
} from '../../security/coding-authority.js';
import {
  appConfigUpdateSchema,
  errorMessage,
  getBody,
  validate,
} from '../schemas/schemas.js';
import {
  changesAny,
  refuseUngrantedCommandChoice,
} from '../working-directory-authority.js';
import {
  captureConfigurationMutation,
  configurationActivationPayload,
  configurationMutationStatus,
} from './configuration-activation.js';

/** #4521: a telemetry raise refused because the managed policy turned it off. */
const MANAGED_TELEMETRY_OFF = 'MANAGED_TELEMETRY_OFF';

/**
 * Legacy-file projection only. New application authority is private SQLite.
 * Credential profiles go through the registry's own projection (#2966): an
 * invalid env overlay, possibly a pasted secret in a hand-edited app.json,
 * is returned only as its value-free `envInvalid` marker.
 */
/**
 * #4517: the one refusal for a write to a setting the managed policy locks.
 * 403, because the caller is not allowed to make this change on this
 * machine; `key` names the setting so a client can mark the right control.
 */
function managedSettingRefusal(c: Context, error: ManagedSettingLockedError) {
  return c.json(managedSettingRefusalBody(error), 403);
}

/**
 * #4518: the config as it applies, with this Station's default approval
 * mode lowered to the managed ceiling. GET and the PUT response both report
 * it; the stored value is not changed (a default saved before the policy
 * stays saved and applies again without it).
 */
function withManagedApprovalCeiling<
  T extends { defaultApprovalMode?: unknown },
>(config: T): T {
  return isApprovalMode(config.defaultApprovalMode)
    ? {
        ...config,
        defaultApprovalMode: clampToManagedCeiling(config.defaultApprovalMode),
      }
    : config;
}

function projectPublicAppConfig(config: Record<string, any>) {
  if (!config.agentConnections) return config;
  return {
    ...config,
    agentConnections: Object.fromEntries(
      Object.entries(config.agentConnections).map(
        ([id, settings]: [string, any]) => {
          const recovery = settings.credentialRecovery;
          if (!recovery) return [id, settings];
          const {
            pendingApplication: _pending,
            applicationReceipts: _receipts,
            ...safe
          } = recovery;
          if (safe.profiles !== undefined) {
            safe.profiles = projectPublicCredentialProfiles(safe.profiles);
          }
          return [id, { ...settings, credentialRecovery: safe }];
        },
      ),
    ),
  };
}

function persistPublicSafeProfiles(
  agentConnections: Record<string, any>,
): Record<string, any> {
  return Object.fromEntries(
    Object.entries(agentConnections).map(([id, settings]) => {
      const recovery = settings?.credentialRecovery;
      if (!recovery || recovery.profiles === undefined) return [id, settings];
      return [
        id,
        {
          ...settings,
          credentialRecovery: {
            ...recovery,
            profiles: persistableCredentialProfiles(recovery.profiles),
          },
        },
      ];
    }),
  );
}

/**
 * Reads one project record for `GET /config/app?project=<slug>` (#2144
 * slice 2), turning only ABSENCE into a value the route can answer 404 with.
 *
 * `FileStorageNotFoundError` is a typed error the storage layer throws for a
 * slug with no record (`domain/project-file-transactions.ts`), so "this
 * project does not exist" is told apart from "reading it failed" by the
 * error's own type — the same `instanceof` join
 * `projectMutationStatus` in `routes/projects/projects.ts` already uses.
 *
 * Everything else rethrows. A corrupt `project.json`, an unreadable home, or
 * a slug that is not a safe path segment are not "no such project": reporting
 * them as one would send the operator to check a NAME while the disk, or
 * their own request, is the problem.
 */
export function createConfigProjectReader(
  projects: Pick<IStorageAdapter, 'getProject'>,
): (slug: string) => ProjectConfig | undefined {
  return (slug) => {
    try {
      return projects.getProject(slug);
    } catch (error) {
      if (error instanceof FileStorageNotFoundError) return undefined;
      throw error;
    }
  };
}

/**
 * Every `contribution` key that would silently do nothing, as one sentence the
 * operator can act on — or `undefined` when every key is usable
 * (archive#1503 review, M6/L7).
 *
 * Two classes, and they are different mistakes with different repairs:
 *
 * - **`"fleet"`** is a real scope whose consent has a different home. It is not
 *   a typo, and the message must say where the value belongs rather than that
 *   the key is unknown.
 * - **Anything `parseContributionScopeKey` cannot name** — a `channel:…` key
 *   written by a newer Station, a bare project id, an empty suffix. Parsing one
 *   "as a project" would attach one space's consent to a different space, so it
 *   is refused rather than guessed; refusing at the write is what turns that
 *   fail-closed silence into feedback.
 */
function refuseUnusableContributionKeys(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const contribution = (body as { contribution?: unknown }).contribution;
  if (
    typeof contribution !== 'object' ||
    contribution === null ||
    Array.isArray(contribution)
  ) {
    return undefined;
  }
  const keys = Object.keys(contribution as Record<string, unknown>);
  if (keys.includes(FLEET_CONTRIBUTION_SCOPE_KEY)) {
    return `Contribution for the fleet scope is configured by the "fleetContribution" setting, which is its one writable home — an entry under "contribution.${FLEET_CONTRIBUTION_SCOPE_KEY}" is never read and would offer nothing. Move it to "fleetContribution". Nothing was saved.`;
  }
  const unusable = keys.filter(
    (key) => parseContributionScopeKey(key) === undefined,
  );
  if (unusable.length > 0) {
    return `This Station cannot name the contribution scope(s) ${unusable
      .map((key) => `"${key}"`)
      .join(
        ', ',
      )}, so an entry under them would never be read and would offer nothing. Use "${PROJECT_CONTRIBUTION_SCOPE_KEY_PREFIX}<projectId>". Nothing was saved.`;
  }
  return undefined;
}

/** Attempt evidence is private SQLite state; config input must never forge it. */
function refusesLegacyCredentialApplicationAuthority(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const connections = (body as { agentConnections?: unknown }).agentConnections;
  if (!connections || typeof connections !== 'object') return false;
  return Object.values(connections as Record<string, unknown>).some(
    (connection) => {
      const recovery =
        connection && typeof connection === 'object'
          ? (connection as { credentialRecovery?: unknown }).credentialRecovery
          : undefined;
      return Boolean(
        recovery &&
          typeof recovery === 'object' &&
          (Object.hasOwn(recovery, 'pendingApplication') ||
            Object.hasOwn(recovery, 'applicationReceipts')),
      );
    },
  );
}

export function createConfigRoutes(
  configLoader: ConfigLoader,
  logger: Logger,
  eventBus?: EventBus,
  applyConfigurationMutation?: AgentConfigurationMutationRunner,
  // Runtime-derived origin of the dedicated MCP-UI frame server, if running
  // AND reachable by this request's client (it listens on the host's
  // loopback only). Injected into GET /app only (never persisted via the
  // update schema).
  getMcpUiFrameOrigin?: (c: Context) => string | undefined,
  // archive#1194 (epic archive#1191, slice B): re-applies the built-in default
  // agent's engine binding via the existing bootstrap function whenever an
  // update touches `builtinAgentEngineConnectionId` — Voice is deliberately
  // NOT rebound (it is speech-to-speech, not a chat engine; see
  // rebindBuiltinAgents in station-runtime.ts). This is the onboarding
  // engine picker's mutation. Optional so callers/tests that
  // never touch that field see no behavior change.
  rebindBuiltinAgents?: () => Promise<void>,
  // Runtime-derived origin for the isolated plugin frame. Kept separate from
  // MCP UI so a future listener split remains an internal deployment detail.
  getPluginFrameOrigin?: () => string | undefined,
  // #2144 slice 2: reads one project record for `GET /app?project=<slug>`,
  // which reports the per-field provenance a project's overrides produce.
  // Returns `undefined` for a slug this Station does not have (the route
  // answers 404 rather than reporting Station-only provenance under a name
  // that does not exist), and THROWS for every other failure. Production
  // supplies `createConfigProjectReader` above. Optional so callers and tests
  // that never ask about a project see no behavior change.
  readProject?: (slug: string) => ProjectConfig | undefined,
  authorizeContributionMutation?: (request: Request) => boolean,
  onAppConfigPersisted?: (config: AppConfig) => void,
  onTelemetryTierLowering?: (
    publisher: TelemetryPublisherId,
    reason?: TelemetryFeedbackReason,
  ) => Promise<void>,
  canSaveAuthorFull?: () => Promise<boolean>,
  // #3994: why terminal history can't be kept private in a directory, or
  // null. Production probes the location (Windows ACLs); absent, no probe.
  terminalHistoryLocationProblem?: (
    directory: string,
  ) => Promise<string | null>,
) {
  const app = new Hono();
  const logLevelEdits = new LogLevelEditService(configLoader);

  app.get('/app/log-level', async (c) => {
    try {
      const current = await logLevelEdits.current();
      return c.json({ success: true, ...current });
    } catch (error) {
      logger.error('Failed to load log-level setting', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.put('/app/log-level', async (c) => {
    try {
      const expectedRevision = c.req.header('If-Match');
      const operationId = c.req.header('Idempotency-Key');
      if (!expectedRevision || !operationId) {
        return c.json(
          {
            success: false,
            error: 'If-Match and Idempotency-Key are required',
          },
          428,
        );
      }
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(operationId)) {
        return c.json(
          { success: false, error: 'Invalid Idempotency-Key' },
          400,
        );
      }
      const body = await c.req.json().catch(() => undefined);
      if (
        typeof body !== 'object' ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !LOG_LEVELS.includes((body as { value?: LogLevel }).value as LogLevel)
      ) {
        return c.json({ success: false, error: 'Invalid log level edit' }, 400);
      }
      const result = await logLevelEdits.apply(
        operationId,
        expectedRevision,
        (body as { value: LogLevel }).value,
      );
      if (result.kind === 'idempotency-conflict') {
        return c.json(
          { success: false, error: 'idempotency_key_conflict' },
          409,
        );
      }
      if (result.kind === 'conflict') {
        return c.json(
          {
            success: false,
            error: 'config_conflict',
            currentValue: result.receipt.currentValue,
            currentRevision: result.receipt.revision,
          },
          409,
        );
      }
      eventBus?.emit(SERVER_EVENTS.SYSTEM_STATUS_CHANGED, { source: 'config' });
      eventBus?.emit(SERVER_EVENTS.CONFIG_CHANGED, { source: 'config' });
      return c.json({
        success: true,
        value: result.receipt.currentValue,
        revision: result.receipt.revision,
        operationId: result.receipt.operationId,
      });
    } catch (error) {
      if (error instanceof ManagedSettingLockedError)
        return managedSettingRefusal(c, error);
      logger.error('Failed to update log-level setting', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Get app config
  app.get('/app', async (c) => {
    try {
      configOps.add(1, { op: 'get_app' });
      // #2144 slice 2. Asking about a project is a request for MORE
      // provenance, never for different VALUES: the response body stays this
      // Station's config, and only `provenance` gains the project's scope
      // attribution. A surface that wants the effective value composes it
      // from the overrides it already holds.
      const projectSlug = c.req.query('project')?.trim();
      let project: ProjectConfig | undefined;
      if (projectSlug) {
        try {
          project = readProject?.(projectSlug);
        } catch (error) {
          if (!(error instanceof InvalidPathSegmentError)) throw error;
          // A slug that is not a path segment is a malformed REQUEST, not a
          // missing project and not a server fault. The message is FIXED:
          // `InvalidPathSegmentError`'s own text quotes the value back, and
          // this one reaches a caller who chose it.
          configOps.add(1, { op: 'get_app_project_slug_invalid' });
          return c.json(
            {
              success: false,
              error:
                'The project query parameter must be a single project slug; no provenance was reported.',
            },
            400,
          );
        }
        if (!project) {
          return c.json(
            {
              success: false,
              error: `Project '${projectSlug}' was not found on this Station; no provenance was reported.`,
            },
            404,
          );
        }
      }
      // Provenance tells a stored decision from a managed one, so it reads
      // the stored config; the body is what every reader sees (#4517).
      const stored = await configLoader.loadStoredAppConfig();
      const managed = installedManagedAppSettings();
      const config = withManagedApprovalCeiling(
        overlayManagedAppSettings(stored, managed),
      );
      const frameOrigin = getMcpUiFrameOrigin?.(c);
      const pluginFrameOrigin = getPluginFrameOrigin?.();
      // #1582 D9: what a terminal would start here with nothing configured,
      // derived from the resolver a spawn actually walks rather than a
      // hard-coded hint the Settings input would print on every host. Same
      // injected-into-GET-/app-only, never-in-the-update-schema pattern as the
      // frame origins above.
      const terminalShellDefault = defaultTerminalShell({
        platform: process.platform,
        env: process.env,
      });
      const injected: Record<string, string> = {};
      if (frameOrigin) injected.mcpUiFrameOrigin = 'MCP_UI_FRAME_PORT';
      if (pluginFrameOrigin) injected.pluginFrameOrigin = 'MCP_UI_FRAME_PORT';
      // Only claimed as environment-sourced when the environment is what
      // supplied it; a platform fallback is nobody's setting.
      if (terminalShellDefault?.source === 'env') {
        injected.defaultTerminalShell =
          process.platform === 'win32' &&
          terminalShellDefault.shell === process.env.COMSPEC
            ? 'COMSPEC'
            : 'SHELL';
      }
      return c.json({
        success: true,
        data: {
          ...projectPublicAppConfig(config),
          lanDiscoveryStatus: lanDiscoveryFor(configLoader).snapshot(),
          ...(frameOrigin ? { mcpUiFrameOrigin: frameOrigin } : {}),
          ...(pluginFrameOrigin ? { pluginFrameOrigin } : {}),
          ...(terminalShellDefault
            ? { defaultTerminalShell: terminalShellDefault.shell }
            : {}),
        },
        provenance: buildAppConfigProvenance(stored, {
          injected,
          managed,
          ...(project
            ? { projectOverrides: readProjectOverrides(project) }
            : {}),
        }),
      });
    } catch (error: unknown) {
      logger.error('Failed to load app config', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Update app config
  app.put('/app', validate(appConfigUpdateSchema), async (c) => {
    let telemetryChanges:
      | Partial<
          Record<
            TelemetryPublisherId,
            { before: TelemetryTier; after: TelemetryTier }
          >
        >
      | undefined;
    const logRefusal = (reason: string) => {
      const principal = getRuntimeAuthenticatedRequestPrincipal(c.req.raw);
      logger.warn('App config update refused', {
        reason,
        principalKind: principal?.kind ?? 'unknown',
        deviceKind: principal?.deviceKind ?? 'none',
        ...(reason === 'telemetry_choice_not_granted' && telemetryChanges
          ? { telemetryChanges }
          : {}),
      });
    };
    try {
      configOps.add(1, { op: 'update_app' });
      // #4517: a locked setting is the managed policy's. A value equal to
      // the locked one is dropped (the effective value already is that, and
      // storing it would write a policy value into the user's file); any
      // other value is refused before every other rule, so a locked key gets
      // the same answer whichever setting it is.
      const managedCheck = withoutLockedNoOps(
        getBody(c) as Record<string, unknown>,
      );
      if (managedCheck.refused) {
        logRefusal('managed_setting_locked');
        return managedSettingRefusal(c, managedCheck.refused);
      }
      const body = managedCheck.updates;
      if (
        Object.hasOwn(body as object, 'telemetryFeedbackReason') &&
        requestMayBeAnAgent(c.req.raw)
      )
        throw new Error('TELEMETRY_CHOICE_NOT_GRANTED');
      const reason = (body as Record<string, unknown>).telemetryFeedbackReason;
      if (
        reason !== undefined &&
        (!TELEMETRY_FEEDBACK_REASONS.some((allowed) => allowed === reason) ||
          !Object.hasOwn(body as object, 'telemetryTier'))
      )
        return c.json(
          {
            success: false,
            error:
              'telemetryFeedbackReason requires a tier change and a fixed-enum reason.',
          },
          400,
        );
      if (Object.hasOwn(body as object, 'telemetryTier')) {
        const tiers = (body as Record<string, unknown>).telemetryTier;
        if (
          !tiers ||
          typeof tiers !== 'object' ||
          Array.isArray(tiers) ||
          Object.keys(tiers).length > 128 ||
          Object.entries(tiers).some(
            ([publisher, tier]) =>
              !isTelemetryPublisherId(publisher) ||
              !['off', 'lite', 'full'].includes(tier),
          )
        )
          return c.json(
            {
              success: false,
              error:
                'telemetryTier must be an object with valid publisher IDs and off/lite/full values.',
            },
            400,
          );
      }

      for (const field of [
        'publicTelemetryRegistries',
        'telemetryPublisherPolicy',
      ] as const) {
        if (!Object.hasOwn(body as object, field)) continue;
        const value = (body as Record<string, unknown>)[field];
        const valid =
          field === 'publicTelemetryRegistries'
            ? Array.isArray(value) &&
              value.length <= 32 &&
              value.every(
                (key) =>
                  typeof key === 'string' &&
                  key.length > 0 &&
                  key.length <= 2048,
              ) &&
              new Set(value).size === value.length
            : value &&
              typeof value === 'object' &&
              !Array.isArray(value) &&
              Object.keys(value).length <= 128 &&
              Object.entries(value).every(
                ([id, tier]) =>
                  isTelemetryPublisherId(id) &&
                  ['off', 'lite', 'full'].includes(tier),
              );
        if (!valid)
          return c.json(
            { success: false, error: 'Invalid publisher telemetry policy.' },
            400,
          );
      }
      // The first-run record is a TRANSITION, not a setting (review M1). Left
      // on this route it was an ordinary composite: an `orchestration:operate`
      // peer could re-arm an existing home as `pending` and re-run the guided
      // chapter on it, or forge `completed` with a timestamp of its choosing
      // for a run that never happened. Same shape as the `logLevel` refusal
      // below — the write has its own endpoint, which is where the rule lives.
      if (Object.hasOwn(body as object, 'firstRun')) {
        configOps.add(1, { op: 'update_app_first_run_refused' });
        return c.json(
          {
            success: false,
            error:
              'firstRun records a first-run decision and is written through POST /config/first-run; no settings were saved.',
          },
          400,
        );
      }

      // The terminal shell is a program Station will start; changing it is
      // choosing a command.
      if (Object.hasOwn(body as object, 'terminalShell')) {
        const current = await configLoader.loadAppConfig();
        if (changesAny(body as object, current, ['terminalShell'])) {
          // An agent's station-control call is the internal principal, which
          // the folder and command rule otherwise leaves to its own policy;
          // the terminal shell is the one setting it may not change, as it
          // may not raise the default approval mode to full access.
          if (requestMayBeAnAgent(c.req.raw)) {
            logRefusal('scope_agent_command_not_granted');
            return c.json(
              {
                success: false,
                code: COMMAND_NOT_GRANTED_CODE,
                error:
                  'An agent cannot change the terminal shell. The operator can, in Settings.',
              },
              403,
            );
          }
          const commandRefused = refuseUngrantedCommandChoice(c);
          if (commandRefused) {
            logRefusal('scope_command_not_granted');
            return commandRefused;
          }
        }
      }

      if (Object.hasOwn(body as object, 'logLevel')) {
        return c.json(
          {
            success: false,
            error:
              'logLevel requires the revisioned /api/config/app/log-level endpoint with If-Match and Idempotency-Key; no settings were saved.',
          },
          400,
        );
      }

      // archive#1398 §5.4 — the beneficiary may not flip the switch.
      //
      // §5.4's disposition (contribution stays at `orchestration:operate`)
      // rests on one thing being true: a credential that can enable
      // contribution gains nothing by doing so, because it cannot invoke
      // what it enabled. That holds for `orchestration:operate` alone, and
      // it stops holding the moment one credential carries BOTH scopes. Such
      // a peer could enable contribution, name a connection — including a
      // BILLABLE hosted one, since `connectionIds` is part of the same
      // write — and then spend the owner's money through
      // `/api/inference/**`, with no operator in the loop at any step. That
      // is not "less authority than running agents here"; it is a
      // self-authorized, self-serving budget.
      //
      // So the guard is on the beneficiary, not the tier: a presented
      // credential holding `inference:invoke` cannot write
      // `fleetContribution` at all. It deliberately covers `connectionIds`
      // as well as `enabled` — naming a new connection on an
      // already-enabled Station is the same act — and it is scoped to this
      // one field, so such a peer's other settings writes are unchanged.
      //
      // Absent scope can only be Station's exact internal-token attestation.
      // A browser, CLI, direct loopback peer, or SSH forward without a bearer
      // or device-session credential is rejected by runtime authentication
      // before this handler. The guard still narrows an authenticated peer;
      // it is not the mechanism that authenticates callers.
      //
      // An `operate`-only peer is likewise unaffected, and that is the case
      // §5.4 reasoned about and accepted.
      const presentedScope = grantedPairingScope(
        c as unknown as PairingScopeContextStore,
      );
      if (
        [
          'productTelemetryEndpoint',
          'productTelemetryKeyRef',
          'otelTelemetryEndpoint',
          'otelTelemetryKeyRef',
        ].some((key) => Object.hasOwn(body as object, key))
      ) {
        if (requestMayBeAnAgent(c.req.raw)) {
          logRefusal('scope_agent_telemetry_destination_not_granted');
          return c.json(
            {
              success: false,
              error:
                'An agent cannot change telemetry choices, destinations or key references. The operator can, in Settings.',
            },
            403,
          );
        }
        if (
          !isOperatorInPersonNotAgent(c.req.raw) &&
          (presentedScope === undefined ||
            !pairingScopeIncludes(presentedScope, 'access:manage'))
        ) {
          logRefusal('scope_telemetry_destination_not_granted');
          return c.json(
            {
              success: false,
              error:
                'An operator must configure telemetry choices, destinations and key references.',
            },
            403,
          );
        }
        for (const name of [
          'productTelemetryEndpoint',
          'otelTelemetryEndpoint',
        ]) {
          const endpoint = (body as Record<string, unknown>)[name];
          if (endpoint !== undefined && endpoint !== null && endpoint !== '') {
            try {
              if (typeof endpoint !== 'string') throw new Error();
              const address = new URL(endpoint);
              if (
                !['http:', 'https:'].includes(address.protocol) ||
                address.username ||
                address.password ||
                address.search ||
                address.hash
              )
                throw new Error();
            } catch {
              return c.json(
                {
                  success: false,
                  error:
                    'Use a full HTTP(S) telemetry destination without embedded credentials, a query or a fragment.',
                },
                400,
              );
            }
          }
        }
      }
      //
      // archive#1500 extends the SAME guard to the scoped
      // `contribution` map, before any consumer of it exists. That map's
      // `inference` axis names model connections exactly as `fleetContribution`
      // does, so a peer holding `inference:invoke` could otherwise name a
      // billable connection under a project scope and spend the owner's money
      // through the identical route the moment slice 6 wires the projection up.
      // Adding the key to the guard when the key is added is a one-line
      // decision; adding it later, against a live consumer, is a security fix.
      const writesFleetContribution = Object.hasOwn(
        body as object,
        'fleetContribution',
      );
      if (
        (writesFleetContribution ||
          Object.hasOwn(body as object, 'contribution')) &&
        presentedScope !== undefined &&
        pairingScopeIncludes(presentedScope, PAIRING_SCOPE_INFERENCE_INVOKE)
      ) {
        configOps.add(1, { op: 'update_app_fleet_contribution_denied' });
        logRefusal('scope_inference_contribution_not_granted');
        return c.json(
          {
            success: false,
            // The fleet sentence is BYTE-UNCHANGED: it is what a paired peer
            // reads today, and archive#1500 is not entitled to reword an
            // existing refusal on its way past. The scoped map gets its own.
            error: writesFleetContribution
              ? 'A credential that can invoke fleet inference cannot also turn fleet contribution on or change which connections are contributed. Enabling it is the operator’s decision, made from this Station or with a credential that does not hold inference:invoke.'
              : 'A credential that can invoke fleet inference cannot also change what this Station contributes to a space. Offering a resource is the operator’s decision, made from this Station or with a credential that does not hold inference:invoke.',
          },
          403,
        );
      }

      // archive#1503 review, M6 + L7 — the scope-key refusals are made HERE,
      // where the operator finds out.
      //
      // `resolveScopedContribution` already refuses a `contribution["fleet"]`
      // entry (its authority is `fleetContribution`) and
      // `parseContributionScopeKey` already refuses a key it cannot name. Both
      // were unreachable as FEEDBACK: nothing enumerates the map, this slice
      // ships no consumer and no UI, and the schema permits any property name —
      // so an operator writing consent under the wrong key got a 200, offered
      // nothing, and was told nothing. This module's own goal is that "an
      // operator who wrote consent in a place that is not the authority must be
      // told it is not in effect"; a diagnostic no surface reads does not meet
      // it.
      //
      // The read-side refusals STAY. They are the backstop for a hand-edited
      // `config/app.json`, which never passes through this route.
      const contributionKeyRefusal = refuseUnusableContributionKeys(body);
      if (contributionKeyRefusal) {
        configOps.add(1, { op: 'update_app_contribution_key_refused' });
        return c.json({ success: false, error: contributionKeyRefusal }, 400);
      }
      if (refusesLegacyCredentialApplicationAuthority(body)) {
        return c.json(
          {
            success: false,
            error:
              'Credential application attempts are private recovery state and cannot be configured.',
          },
          400,
        );
      }

      const settings = { ...(body as Record<string, unknown>) };
      delete settings.telemetryFeedbackReason;
      const { accepted, ignored, violations } =
        sanitizeAppConfigUpdate(settings);
      if (violations.length > 0) {
        return c.json(
          {
            success: false,
            error: violations.map((v) => v.message).join('; '),
            violations,
          },
          400,
        );
      }
      if (ignored.length > 0) {
        configOps.add(1, { op: 'update_app_ignored_keys' });
      }
      // #4769: the confined network policy is refused here, as written, when
      // its shape or any allowed host is not one the broker can read; stored,
      // it would refuse every start that requires confinement. `null` clears it.
      if (Object.hasOwn(body as object, 'confinedNetwork')) {
        // #4769: an agent may not change the policy that confines agents,
        // its own session's included; the operator can, in person.
        if (requestMayBeAnAgent(c.req.raw)) {
          logRefusal('confined_network_agent_not_granted');
          return c.json(
            {
              success: false,
              code: COMMAND_NOT_GRANTED_CODE,
              error:
                'An agent cannot change the confined network policy. The operator can, with PUT /config/app or station config set.',
            },
            403,
          );
        }
        const value = (body as Record<string, unknown>).confinedNetwork;
        if (value !== null && value !== undefined) {
          const problem = appConfigSemanticError({ confinedNetwork: value });
          if (problem)
            return c.json(
              { success: false, error: `${problem} No settings were saved.` },
              400,
            );
        }
      }
      // Terminal history retention: each value's range is the registry's;
      // the rules spanning settings are checked against the merged result.
      if (
        TERMINAL_RETENTION_KEYS.some((key) =>
          Object.hasOwn(body as object, key),
        )
      ) {
        const current = await configLoader.loadAppConfig();
        const merged: Record<string, unknown> = { ...current };
        for (const key of TERMINAL_RETENTION_KEYS) {
          if (!Object.hasOwn(body as object, key)) continue;
          const value = (body as Record<string, unknown>)[key];
          if (value === null || value === undefined || value === '')
            delete merged[key];
          else merged[key] = value;
        }
        const problem = terminalRetentionProblem(merged);
        if (problem)
          return c.json(
            { success: false, error: `${problem}; no settings were saved.` },
            400,
          );
        if (
          changesAny(body as object, current, ['terminalHistoryDirectory']) &&
          requestMayBeAnAgent(c.req.raw)
        ) {
          logRefusal('scope_agent_command_not_granted');
          return c.json(
            {
              success: false,
              code: COMMAND_NOT_GRANTED_CODE,
              error:
                'An agent cannot move terminal history. The operator can, in Settings.',
            },
            403,
          );
        }
        const directory =
          typeof merged.terminalHistoryDirectory === 'string'
            ? merged.terminalHistoryDirectory.trim()
            : '';
        if (
          directory &&
          terminalHistoryLocationProblem &&
          changesAny(body as object, current, ['terminalHistoryDirectory'])
        ) {
          const location = await terminalHistoryLocationProblem(
            normalize(directory),
          );
          if (location)
            return c.json(
              {
                success: false,
                error: `terminalHistoryDirectory: ${location} No settings were saved.`,
              },
              400,
            );
        }
      }

      // `agentConnections` is a composite that replaces the stored value
      // wholesale. Credential profiles written this way (including a settings
      // import) are normalized like any registry write, so an invalid env
      // overlay is persisted only as its value-free marker (#2966).
      if (
        accepted.agentConnections &&
        typeof accepted.agentConnections === 'object' &&
        !Array.isArray(accepted.agentConnections)
      ) {
        accepted.agentConnections = persistPublicSafeProfiles(
          accepted.agentConnections as Record<string, any>,
        );
      }
      if (
        Object.hasOwn(accepted, 'builtinAgentEngineConnectionId') &&
        accepted.builtinAgentEngineConnectionId !== null
      ) {
        const connectionId = parseEngineConnectionId(
          accepted.builtinAgentEngineConnectionId,
        );
        if (!connectionId) {
          return c.json(
            {
              success: false,
              error:
                'Built-in agent engine must be a clean engine connection identity.',
            },
            400,
          );
        }
        accepted.builtinAgentEngineConnectionId = connectionId;
      }
      // Snapshot the prior binding before the mutation: the rebind below
      // must key on the value CHANGING, not merely being present —
      // SettingsView round-trips the full config on every save, so a
      // presence check made every settings save rebind the built-in agents
      // and serialize behind the previous save's rebind (observed live as a
      // hung second PUT in tests/settings.spec.ts 'save persists changes').
      // The onboarding picker (archive#1194) sends a delta with a genuinely new
      // value, so change-gating preserves its contract exactly.
      const writesTelemetryChoice = ['telemetryTier', 'telemetryEnabled'].some(
        (key) => Object.hasOwn(body as object, key),
      );
      // Shared with the disclosure read's `capabilities.raise`, so the
      // choice a client offers and the raise this refuses cannot drift.
      const mayRaiseTelemetry = mayRaiseTelemetryChoice(
        c.req.raw,
        presentedScope,
      );
      const priorConfig = await configLoader.loadAppConfig();
      // #2436: the Station default applies to every session start, the
      // unattended ones included, so raising it to full access needs the
      // same grant as starting one session there. The authority is read
      // here; whether this write RAISES it is decided inside the serialized
      // mutation below, against the config it actually replaces.
      const mayRaiseDefaultToFullAccess = mayGrantFullAccess(
        c.req.raw,
        grantedPairingScope(c as unknown as PairingScopeContextStore),
      );
      const priorBuiltinEngineConnectionId =
        priorConfig.builtinAgentEngineConnectionId;
      const contributionRequested = Object.hasOwn(accepted, 'contribution');
      const lowerings: TelemetryPublisherId[] = [];
      const update = async (beginMutation: () => void) => {
        beginMutation();
        const updated = await configLoader.mutateAppConfig(async (current) => {
          if (
            ['publicTelemetryRegistries', 'telemetryPublisherPolicy'].some(
              (key) =>
                Object.hasOwn(accepted, key) &&
                !isDeepStrictEqual(
                  current[key as keyof AppConfig],
                  accepted[key as keyof AppConfig],
                ),
            ) &&
            !isOperatorInPersonNotAgent(c.req.raw)
          )
            throw new Error('TELEMETRY_CHOICE_NOT_GRANTED');
          if (writesTelemetryChoice) {
            const next = mergeAppConfigUpdate(current, accepted);
            const rank = { off: 0, lite: 1, full: 2 } as const;
            const publishers = new Set([
              ...Object.keys(current.telemetryTier ?? {}),
              ...Object.keys(next.telemetryTier ?? {}),
            ]);
            const defaults = telemetryChoiceDefaults(
              current,
              process.env,
              [...publishers].filter(isTelemetryPublisherId),
            );
            telemetryChanges = {};
            let raisesTelemetry = false;
            for (const publisher of publishers) {
              const key = publisher as keyof NonNullable<
                AppConfig['telemetryTier']
              >;
              const fallback = key.startsWith('publisher:') ? 'off' : 'lite';
              const before =
                current.telemetryTier?.[key] ?? defaults[key] ?? fallback;
              const after =
                next.telemetryTier?.[key] ?? defaults[key] ?? fallback;
              telemetryChanges[key] = { before, after };
              if (rank[after] < rank[before]) lowerings.push(key);
              if (rank[after] > rank[before]) raisesTelemetry = true;
            }
            // #4521: the managed policy turned telemetry off. A raise could
            // never take effect, so it is refused rather than stored.
            if (raisesTelemetry && !telemetryAllowedByManagedPolicy())
              throw new Error(MANAGED_TELEMETRY_OFF);
            if (
              requestMayBeAnAgent(c.req.raw) ||
              (raisesTelemetry && !mayRaiseTelemetry)
            )
              throw new Error('TELEMETRY_CHOICE_NOT_GRANTED');
            if (
              next.telemetryTier?.kontour === 'full' &&
              current.telemetryTier?.kontour !== 'full' &&
              !(await canSaveAuthorFull?.())
            )
              throw new Error(
                "The current confirmation for sharing detailed usage with Kontour is missing. Review what's included and save your choice.",
              );
          }
          if (
            accepted.lanDiscoveryEnabled !== undefined &&
            accepted.lanDiscoveryEnabled !==
              (current.lanDiscoveryEnabled ?? false) &&
            authorizeContributionMutation?.(c.req.raw) !== true
          )
            throw new Error('LAN_DISCOVERY_OPERATOR_REQUIRED');
          // #4519: checked after the operator gate, so only the operator
          // learns what the policy says.
          if (
            accepted.lanDiscoveryEnabled === true &&
            current.lanDiscoveryEnabled !== true &&
            lanDiscoveryFor(configLoader).managedPolicyRefusal() !== undefined
          )
            throw new Error(MANAGED_POLICY_REMOTE_CLIENTS_CODE);
          // A semantic contribution change needs the BOUND-OPERATOR verdict,
          // whatever scope the presenting credential claims — an absent
          // presented scope is NOT an operator, it is an unscoped caller, so
          // it must not widen the exemption. The equality check runs INSIDE
          // the serialized mutation against the CURRENT config, so a
          // full-settings round-trip that is still byte-equal when it lands
          // is permitted, while a queued save whose target changed under it
          // refuses here rather than racing the operator's newer offer.
          if (
            contributionRequested &&
            !isDeepStrictEqual(accepted.contribution, current.contribution) &&
            authorizeContributionMutation?.(c.req.raw) !== true
          ) {
            throw new Error('PROJECT_CONTRIBUTION_OPERATOR_REQUIRED');
          }
          // Same shape (#2436): compared with the CURRENT config inside the
          // serialized mutation, so a save that read `never` and resends it
          // cannot land after the operator lowered it. Resending a `never`
          // that still stands (Settings round-trips the whole config) is
          // not a raise.
          // #4518: a change of the Station default to a posture above the
          // machine's managed ceiling is refused. Resending the value that
          // stands is not a change: a default saved before the policy took
          // effect stays saved, and is lowered to the ceiling where it
          // applies (`ApprovalPosture`).
          if (
            managedCeilingRefuses(accepted.defaultApprovalMode) &&
            accepted.defaultApprovalMode !== current.defaultApprovalMode
          ) {
            throw new Error(DEFAULT_ABOVE_MANAGED_CEILING);
          }
          if (
            accepted.defaultApprovalMode === 'never' &&
            current.defaultApprovalMode !== 'never' &&
            !mayRaiseDefaultToFullAccess
          ) {
            throw new Error(FULL_ACCESS_DEFAULT_NOT_GRANTED);
          }
          for (const publisher of lowerings) {
            try {
              await onTelemetryTierLowering?.(
                publisher,
                reason as TelemetryFeedbackReason | undefined,
              );
            } catch (error) {
              logger.warn(
                'Telemetry feedback unavailable; applying the lower tier.',
                { error },
              );
            }
          }
          return accepted;
        });
        // Telemetry withdrawal must not wait for unrelated Agent activation.
        onAppConfigPersisted?.(updated);
        await lanDiscoveryFor(configLoader).configure(updated);
        return updated;
      };
      const mutation = await captureConfigurationMutation(
        applyConfigurationMutation,
        update,
      );
      const updated = mutation.value;
      // #4518: the response reports the values in effect, as GET does.
      const publicUpdated = projectPublicAppConfig(
        withManagedApprovalCeiling(updated),
      );
      logger.info('App config updated', { config: publicUpdated });
      // archive#1194: this key is the onboarding engine picker's own
      // mutation surface — rebind immediately rather than waiting for some
      // other, unrelated reload to pick it up. Any error here fails the
      // request rather than silently returning success while the built-ins
      // stay on the previous binding.
      const rebindsBuiltinEngine =
        Object.hasOwn(accepted, 'builtinAgentEngineConnectionId') &&
        accepted.builtinAgentEngineConnectionId !==
          priorBuiltinEngineConnectionId;
      if (rebindsBuiltinEngine) {
        await rebindBuiltinAgents?.();
      }
      eventBus?.emit(SERVER_EVENTS.SYSTEM_STATUS_CHANGED, { source: 'config' });
      if (rebindsBuiltinEngine) {
        // archive#1194 review round 2 (HIGH): without this, the browser's
        // cached agent list (engine chip, routing) stays stale until some
        // unrelated refetch — the rebind looked inert on first use.
        // `CONFIG_CHANGED` is the one existing client event that already
        // invalidates both `['config']` and `['agents']`
        // (`useServerEvents.ts`), so this reuses it rather than inventing a
        // new one.
        eventBus?.emit(SERVER_EVENTS.CONFIG_CHANGED, { source: 'config' });
      }
      return c.json(
        {
          success: true,
          data: publicUpdated,
          ...(ignored.length > 0 ? { ignoredKeys: ignored } : {}),
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.message === MANAGED_TELEMETRY_OFF) {
        logRefusal('managed_telemetry_off');
        return c.json(managedCapabilityRefusalBody('usage sharing'), 403);
      }
      if (error instanceof ManagedSettingLockedError) {
        logRefusal('managed_setting_locked');
        return managedSettingRefusal(c, error);
      }
      if (
        error instanceof Error &&
        error.message === 'TELEMETRY_CHOICE_NOT_GRANTED'
      ) {
        logRefusal('telemetry_choice_not_granted');
        return c.json(
          {
            success: false,
            error:
              'Only the operator or a device with access:manage can raise telemetry tiers. Agents cannot change telemetry choices.',
          },
          403,
        );
      }
      if (
        error instanceof Error &&
        error.message === DEFAULT_ABOVE_MANAGED_CEILING
      ) {
        configOps.add(1, { op: 'update_app_default_above_managed_ceiling' });
        logRefusal('default_above_managed_ceiling');
        return managedApprovalCeilingRefusal(c);
      }
      if (
        error instanceof Error &&
        error.message === FULL_ACCESS_DEFAULT_NOT_GRANTED
      ) {
        configOps.add(1, { op: 'update_app_full_access_default_refused' });
        logRefusal('full_access_default_not_granted');
        return fullAccessRefusal(c);
      }
      if (
        error instanceof Error &&
        error.message === 'PROJECT_CONTRIBUTION_OPERATOR_REQUIRED'
      ) {
        logRefusal('project_contribution_operator_required');
        return c.json(
          {
            success: false,
            error:
              'Only this Station’s local operator can change Project execution offers.',
          },
          403,
        );
      }
      const managedRefusal =
        lanDiscoveryFor(configLoader).managedPolicyRefusal();
      if (
        error instanceof Error &&
        error.message === MANAGED_POLICY_REMOTE_CLIENTS_CODE &&
        managedRefusal !== undefined
      ) {
        return c.json(
          {
            success: false,
            error: managedRefusal,
            code: MANAGED_POLICY_REMOTE_CLIENTS_CODE,
          },
          403,
        );
      }
      if (
        error instanceof Error &&
        error.message === 'LAN_DISCOVERY_OPERATOR_REQUIRED'
      ) {
        return c.json(
          {
            success: false,
            error:
              'Only this Station’s local operator can change nearby discovery.',
          },
          403,
        );
      }
      logger.error('Failed to update app config', { error });
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  /**
   * Record what the person did with the guided first run (UX audit RT-02,
   * review M1).
   *
   * Minimal on purpose: the only body it accepts is `{ "status": "skipped" |
   * "completed" }`, the only transitions it allows are forward ones from a
   * home that was actually offered the run, and the timestamp is Station's own
   * observation. `describeFirstRunTransitionViolation` is the single rule and
   * lives in contracts, so this route and any other writer answer the same
   * way.
   *
   * `pending` is deliberately unreachable from here. It is written once, by
   * the code path that CREATES a home (`config-loader-app.ts`), and a caller
   * that could re-arm it could re-run the guided chapter on someone's Station
   * at will.
   */
  app.post('/first-run', async (c) => {
    try {
      configOps.add(1, { op: 'update_first_run' });
      const body = await c.req.json().catch(() => undefined);
      const current = (await configLoader.loadAppConfig()).firstRun;
      const violation = describeFirstRunTransitionViolation(current, body);
      if (violation) {
        configOps.add(1, { op: 'update_first_run_refused' });
        return c.json({ success: false, error: violation }, 400);
      }
      const firstRun = firstRunStateForTransition(
        body as FirstRunTransitionRequest,
        new Date(),
      );
      await configLoader.updateAppConfig({ firstRun });
      eventBus?.emit(SERVER_EVENTS.CONFIG_CHANGED, { source: 'config' });
      return c.json({ success: true, data: firstRun });
    } catch (error: unknown) {
      if (error instanceof ManagedSettingLockedError)
        return managedSettingRefusal(c, error);
      logger.error('Failed to record the first-run decision', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
