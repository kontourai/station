/**
 * Config Routes - app configuration management
 */

import { parseEngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import {
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
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import type { ConfigLoader } from '../../domain/config-loader.js';
import {
  buildAppConfigProvenance,
  sanitizeAppConfigUpdate,
} from '../../domain/settings-registry-server.js';
import type { AgentConfigurationMutationRunner } from '../../runtime/types.js';
import {
  grantedPairingScope,
  type PairingScopeContextStore,
} from '../../security/pairing-route-scopes.js';
import {
  LOG_LEVELS,
  type LogLevel,
  LogLevelEditService,
} from '../../services/config/log-level-edit-service.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { configOps } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import {
  appConfigUpdateSchema,
  errorMessage,
  getBody,
  validate,
} from '../schemas/schemas.js';
import {
  captureConfigurationMutation,
  configurationActivationPayload,
  configurationMutationStatus,
} from './configuration-activation.js';

/** Legacy-file projection only. New application authority is private SQLite. */
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
          return [id, { ...settings, credentialRecovery: safe }];
        },
      ),
    ),
  };
}

/**
 * Every `contribution` key that would silently do nothing, as one sentence the
 * operator can act on — or `undefined` when every key is usable
 * (station#1503 review, M6/L7).
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
  // Runtime-derived origin of the dedicated MCP-UI frame server, if running.
  // Injected into GET /app only (never persisted via the update schema).
  getMcpUiFrameOrigin?: () => string | undefined,
  // station#980: runtime-derived (STATION_FEATURES=managed-chat-orchestration,
  // never persisted) — same injected-into-GET-/app-only, never-in-the-update-
  // schema pattern as `getMcpUiFrameOrigin` above.
  getManagedChatOrchestrationEnabled?: () => boolean,
  // station#1194 (epic #1191, slice B): re-applies the built-in default
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
      logger.error('Failed to update log-level setting', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Get app config
  app.get('/app', async (c) => {
    try {
      configOps.add(1, { op: 'get_app' });
      const config = await configLoader.loadAppConfig();
      const frameOrigin = getMcpUiFrameOrigin?.();
      const pluginFrameOrigin = getPluginFrameOrigin?.();
      const managedChatOrchestrationEnabled =
        getManagedChatOrchestrationEnabled?.() === true;
      const injected: Record<string, string> = {};
      if (frameOrigin) injected.mcpUiFrameOrigin = 'MCP_UI_FRAME_PORT';
      if (pluginFrameOrigin) injected.pluginFrameOrigin = 'MCP_UI_FRAME_PORT';
      if (managedChatOrchestrationEnabled) {
        injected.managedChatOrchestration = 'STATION_FEATURES';
      }
      return c.json({
        success: true,
        data: {
          ...projectPublicAppConfig(config),
          ...(frameOrigin ? { mcpUiFrameOrigin: frameOrigin } : {}),
          ...(pluginFrameOrigin ? { pluginFrameOrigin } : {}),
          ...(managedChatOrchestrationEnabled
            ? { managedChatOrchestration: true }
            : {}),
        },
        provenance: buildAppConfigProvenance(config, { injected }),
      });
    } catch (error: unknown) {
      logger.error('Failed to load app config', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  // Update app config
  app.put('/app', validate(appConfigUpdateSchema), async (c) => {
    try {
      configOps.add(1, { op: 'update_app' });
      const body = getBody(c);

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

      // station#1398 §5.4 — the beneficiary may not flip the switch.
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
      //
      // station#1500 slice 2.5 extends the SAME guard to the scoped
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
        return c.json(
          {
            success: false,
            // The fleet sentence is BYTE-UNCHANGED: it is what a paired peer
            // reads today, and station#1500 is not entitled to reword an
            // existing refusal on its way past. The scoped map gets its own.
            error: writesFleetContribution
              ? 'A credential that can invoke fleet inference cannot also turn fleet contribution on or change which connections are contributed. Enabling it is the operator’s decision, made from this Station or with a credential that does not hold inference:invoke.'
              : 'A credential that can invoke fleet inference cannot also change what this Station contributes to a space. Offering a resource is the operator’s decision, made from this Station or with a credential that does not hold inference:invoke.',
          },
          403,
        );
      }

      // station#1503 review, M6 + L7 — the scope-key refusals are made HERE,
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

      const { accepted, ignored, violations } = sanitizeAppConfigUpdate(body);
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
      // The onboarding picker (#1194) sends a delta with a genuinely new
      // value, so change-gating preserves its contract exactly.
      const priorConfig = await configLoader.loadAppConfig();
      const priorBuiltinEngineConnectionId =
        priorConfig.builtinAgentEngineConnectionId;
      const update = (beginMutation: () => void) => {
        beginMutation();
        return configLoader.updateAppConfig(accepted);
      };
      const mutation = await captureConfigurationMutation(
        applyConfigurationMutation,
        update,
      );
      const updated = mutation.value;
      const publicUpdated = projectPublicAppConfig(updated);
      logger.info('App config updated', { config: publicUpdated });
      // station#1194: this key is the onboarding engine picker's own
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
        // station#1194 review round 2 (HIGH): without this, the browser's
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
      logger.error('Failed to record the first-run decision', { error });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
