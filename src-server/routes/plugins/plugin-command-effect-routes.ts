/**
 * Plugin command effects over HTTP (kontourai/station#1418, #1419).
 *
 * - `POST /:name/command-effects` admits one local effect (LP-A).
 * - `POST /command-effects/settlements` records how a document settled its
 *   effects (LP-K).
 * - `GET /command-effects/withdrawals`, `GET …/withdrawals/:id` and
 *   `POST …/:id/resolve` are the operator's view of, and only way to close,
 *   an indeterminate withdrawal.
 * - `GET /command-effects/uncaptured` and `POST /command-effects/effects/
 *   :effectId/abandon` let the operator free an aged outstanding effect no
 *   withdrawal captured.
 *
 * Hosted deployments refuse every route: their audit and document authority
 * are not established, so no effect is admitted there.
 */
import {
  PLUGIN_COMMAND_EFFECT_MAX_SETTLEMENT_ITEMS,
  PLUGIN_COMMAND_EFFECT_OUTCOMES,
  PLUGIN_COMMAND_WITHDRAWAL_RESOLVE_DISPOSITION,
  type PluginCommandEffectOutcome,
  type PluginCommandEffectRefusalReason,
} from '@kontourai/station-contracts/plugin-command-effect';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { Context, Hono } from 'hono';
import { PrincipalUnresolvedError } from '../../services/identity/principal-resolver.js';
import type { PluginCommandEffectAdmission } from '../../services/plugins/plugin-command-effect-admission.js';
import {
  isPluginCommandClientId,
  isPluginCommandDocumentKey,
  type PluginCommandEffectService,
  PluginCommandEffectsUnavailableError,
} from '../../services/plugins/plugin-command-effects.js';
import { errorMessage } from '../schemas/schemas.js';
import {
  operatorOnly,
  type PluginPrincipalResolution,
} from './plugin-identity-enumeration.js';

export interface PluginCommandEffectRouteDeps {
  admission: PluginCommandEffectAdmission;
  effects: PluginCommandEffectService;
  resolution: PluginPrincipalResolution | undefined;
  isHostedDeployment(): boolean;
}

const REFUSAL_STATUS: Record<
  PluginCommandEffectRefusalReason,
  400 | 404 | 409 | 503
> = {
  'invalid-request': 400,
  'request-expired': 409,
  'not-found': 404,
  'generation-changed': 409,
  'command-not-declared': 409,
  'command-not-executable': 409,
  'target-mismatch': 409,
  'requirement-not-satisfied': 409,
  'permission-unavailable': 409,
  capacity: 409,
  cancelled: 409,
  'request-conflict': 409,
  unavailable: 503,
};

const OUTCOMES = new Set<string>(PLUGIN_COMMAND_EFFECT_OUTCOMES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

function parseSettlement(value: unknown) {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !['documentId', 'documentKey', 'items'].includes(key),
    ) ||
    !isPluginCommandClientId(value.documentId) ||
    !isPluginCommandDocumentKey(value.documentKey) ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > PLUGIN_COMMAND_EFFECT_MAX_SETTLEMENT_ITEMS
  )
    return null;
  const items: Array<{
    requestId: string;
    effectId?: string;
    outcome: PluginCommandEffectOutcome;
  }> = [];
  const seen = new Set<string>();
  for (const item of value.items) {
    if (
      !isRecord(item) ||
      Object.keys(item).some(
        (key) => !['requestId', 'effectId', 'outcome'].includes(key),
      ) ||
      !isPluginCommandClientId(item.requestId) ||
      seen.has(item.requestId) ||
      (item.effectId !== undefined &&
        (typeof item.effectId !== 'string' || item.effectId.length > 128)) ||
      typeof item.outcome !== 'string' ||
      !OUTCOMES.has(item.outcome)
    )
      return null;
    seen.add(item.requestId);
    items.push({
      requestId: item.requestId,
      ...(item.effectId !== undefined ? { effectId: item.effectId } : {}),
      outcome: item.outcome as PluginCommandEffectOutcome,
    });
  }
  return {
    documentId: value.documentId,
    documentKey: value.documentKey,
    items,
  };
}

export function registerPluginCommandEffectRoutes(
  app: Hono,
  deps: PluginCommandEffectRouteDeps,
) {
  const hostedRefusal = (c: Context) =>
    c.json(
      {
        success: false,
        error: 'Plugin commands are unavailable on hosted deployments',
      },
      403,
    );
  const withCaller =
    (handle: (c: Context, caller: PrincipalRef) => Promise<Response>) =>
    async (c: Context) => {
      if (deps.isHostedDeployment()) return hostedRefusal(c);
      let caller: PrincipalRef;
      try {
        if (!deps.resolution)
          throw new PrincipalUnresolvedError(
            'plugin visibility was not composed for this route',
          );
        caller = deps.resolution.resolvePrincipal(c);
      } catch (error) {
        if (error instanceof PrincipalUnresolvedError)
          return c.json(
            { success: false, error: errorMessage(error), code: error.code },
            400,
          );
        throw error;
      }
      return handle(c, caller);
    };
  const asOperator = (
    what: string,
    handle: (c: Context) => Promise<Response>,
  ) => {
    const guarded = operatorOnly(deps.resolution, what)(handle);
    return (c: Context) =>
      deps.isHostedDeployment() ? hostedRefusal(c) : guarded(c);
  };

  // Literal segments register before the `/:name/command-effects` route.
  app.post(
    '/command-effects/settlements',
    withCaller(async (c, caller) => {
      const request = parseSettlement(await readJson(c));
      if (!request)
        return c.json(
          { success: false, reason: 'invalid-request' as const },
          400,
        );
      try {
        const results = await deps.effects.settle({
          principalId: caller.id,
          ...request,
        });
        return c.json(
          { success: true, results },
          results.some((result) => result.status === 'conflict') ? 409 : 200,
        );
      } catch (error) {
        if (error instanceof PluginCommandEffectsUnavailableError)
          return c.json(
            { success: false, reason: 'unavailable' as const },
            503,
          );
        throw error;
      }
    }),
  );

  const unavailable = (c: Context, error: unknown) => {
    if (error instanceof PluginCommandEffectsUnavailableError)
      return c.json({ success: false, reason: 'unavailable' as const }, 503);
    throw error;
  };

  app.get(
    '/command-effects/withdrawals',
    asOperator('read plugin command withdrawals', async (c) => {
      try {
        return c.json({
          success: true,
          withdrawals: await deps.effects.listWithdrawals(),
        });
      } catch (error) {
        return unavailable(c, error);
      }
    }),
  );

  app.get(
    '/command-effects/uncaptured',
    asOperator('read outstanding plugin command effects', async (c) => {
      try {
        return c.json({
          success: true,
          effects: await deps.effects.listUncapturedEffects(),
        });
      } catch (error) {
        return unavailable(c, error);
      }
    }),
  );

  app.post(
    '/command-effects/effects/:effectId/abandon',
    asOperator('abandon plugin command effects', async (c) => {
      try {
        const outcome = await deps.effects.abandonEffect(
          c.req.param('effectId') ?? '',
        );
        if (outcome.kind === 'abandoned') return c.json({ success: true });
        if (outcome.kind === 'not-found')
          return c.json(
            { success: false, error: 'Outstanding effect not found' },
            404,
          );
        return c.json(
          {
            success: false,
            reason: outcome.kind,
            ...(outcome.kind === 'captured'
              ? { withdrawalId: outcome.withdrawalId }
              : {}),
          },
          409,
        );
      } catch (error) {
        return unavailable(c, error);
      }
    }),
  );

  app.get(
    '/command-effects/withdrawals/:id',
    asOperator('read plugin command withdrawals', async (c) => {
      try {
        const withdrawal = await deps.effects.withdrawal(
          c.req.param('id') ?? '',
        );
        return withdrawal
          ? c.json({ success: true, withdrawal })
          : c.json({ success: false, error: 'Withdrawal not found' }, 404);
      } catch (error) {
        if (error instanceof PluginCommandEffectsUnavailableError)
          return c.json(
            { success: false, reason: 'unavailable' as const },
            503,
          );
        throw error;
      }
    }),
  );

  app.post(
    '/command-effects/withdrawals/:id/resolve',
    asOperator('resolve plugin command withdrawals', async (c) => {
      const body = await readJson(c);
      if (
        !isRecord(body) ||
        Object.keys(body).length !== 1 ||
        body.disposition !== PLUGIN_COMMAND_WITHDRAWAL_RESOLVE_DISPOSITION
      )
        return c.json(
          { success: false, reason: 'invalid-request' as const },
          400,
        );
      try {
        const outcome = await deps.effects.resolveWithdrawal(
          c.req.param('id') ?? '',
        );
        if (outcome.kind === 'not-found')
          return c.json({ success: false, error: 'Withdrawal not found' }, 404);
        if (outcome.kind === 'not-indeterminate')
          return c.json(
            {
              success: false,
              reason: 'not-indeterminate' as const,
              withdrawal: outcome.withdrawal,
            },
            409,
          );
        return c.json({ success: true, withdrawal: outcome.withdrawal });
      } catch (error) {
        if (error instanceof PluginCommandEffectsUnavailableError)
          return c.json(
            { success: false, reason: 'unavailable' as const },
            503,
          );
        throw error;
      }
    }),
  );

  app.post(
    '/:name/command-effects',
    withCaller(async (c, caller) => {
      const outcome = await deps.admission.admit({
        principal: caller,
        pluginId: c.req.param('name') ?? '',
        body: await readJson(c),
        authority: c.req.raw,
      });
      if (outcome.kind === 'admitted')
        return c.json({ success: true, receipt: outcome.receipt });
      return c.json(
        { success: false, reason: outcome.reason },
        REFUSAL_STATUS[outcome.reason],
      );
    }),
  );
}
