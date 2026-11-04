import { TROUBLESHOOT_SURFACES } from '@kontourai/station-contracts/troubleshoot';
import {
  MAX_TROUBLESHOOT_SEED_CONVERSATION_ID_LENGTH,
  MAX_TROUBLESHOOT_SEED_ERROR_LENGTH,
  MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH,
  MAX_TROUBLESHOOT_SEED_TURN_ID_LENGTH,
  TroubleshootSeedError,
} from '@kontourai/station-shared/triage-context';
import { Hono } from 'hono';
import {
  isOperatorInPersonNotAgent,
  requestMayBeAnAgent,
} from '../../security/coding-authority.js';
import {
  isBoundRuntimeOwner,
  resolveClientOriginForRequest,
} from '../../security/runtime-request-security.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import type { DiagnosticsService } from '../../services/infra/diagnostics-service.js';
import {
  MAX_SERVER_LOG_QUERY_LIMIT,
  type ServerLogQueryOptions,
  type ServerLogReader,
} from '../../services/infra/server-log-reader.js';
import type {
  TroubleshootPrepareInput,
  TroubleshootService,
} from '../../services/infra/troubleshoot-service.js';
import { serverLogsRead } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import { isLogLevel, LOG_LEVEL_ORDER } from '../../utils/logger.js';
import {
  errorMessage,
  getBody,
  troubleshootPrepareSchema,
  validate,
} from '../schemas/schemas.js';

export function createDiagnosticsRoutes(
  diagnosticsService: DiagnosticsService,
  logger: Logger,
  logReader: ServerLogReader,
  access?: {
    agentGrant?: (sessionId: string) => boolean;
    /** #4470: absent leaves the troubleshoot prepare route unmounted. */
    troubleshoot?: TroubleshootService;
  },
) {
  const app = new Hono();
  const hasAgentGrant = (sessionId: string) => {
    try {
      return access?.agentGrant?.(sessionId) === true;
    } catch {
      return false;
    }
  };

  app.get('/bundle', async (c) => {
    try {
      return c.json(await diagnosticsService.generateBundle());
    } catch (error) {
      logger.error('Failed to generate diagnostics bundle', { error });
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  // #4470: prepare an in-app troubleshooting conversation. People only: an
  // agent (including Station's internal principal) may not start one, since
  // the run records who asked and the playbook files issues on that basis.
  // The pairing-scope family tier (orchestration:operate) is the floor.
  const troubleshoot = access?.troubleshoot;
  if (troubleshoot) {
    app.post(
      '/troubleshoot/prepare',
      validate(troubleshootPrepareSchema, { maxBodyBytes: 16 * 1024 }),
      async (c) => {
        if (requestMayBeAnAgent(c.req.raw))
          return c.json(
            {
              success: false,
              error: 'Only a person can start troubleshooting.',
            },
            403,
          );
        const body = getBody(c) as {
          surface?: TroubleshootPrepareInput['surface'];
          seed?: TroubleshootPrepareInput['seed'];
        };
        // The operator at the host or on one of the owner's own devices
        // (owner-device standing): the single in-person owner check.
        const owner = isOperatorInPersonNotAgent(c.req.raw);
        const reported = resolveClientOriginForRequest(c.req.raw).reported
          ?.surface;
        const surface =
          body.surface ??
          ((TROUBLESHOOT_SURFACES as readonly string[]).includes(reported ?? '')
            ? (reported as TroubleshootPrepareInput['surface'])
            : 'unknown');
        try {
          return c.json(
            await troubleshoot.prepare({
              role: owner ? 'owner' : 'member',
              surface,
              ...(body.seed ? { seed: body.seed } : {}),
            }),
          );
        } catch (error) {
          if (error instanceof TroubleshootSeedError)
            return c.json(
              {
                success: false,
                error:
                  'Seed context was refused: the route must be an in-app path, ids must be printable with no spaces, and each field must fit its limit.',
                code: error.reason,
                limits: {
                  route: MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH,
                  errorSummary: MAX_TROUBLESHOOT_SEED_ERROR_LENGTH,
                  conversationId: MAX_TROUBLESHOOT_SEED_CONVERSATION_ID_LENGTH,
                  turnId: MAX_TROUBLESHOOT_SEED_TURN_ID_LENGTH,
                },
              },
              400,
            );
          logger.error('Failed to prepare troubleshooting', { error });
          return c.json(
            { success: false, error: 'Troubleshooting could not be prepared.' },
            500,
          );
        }
      },
    );
  }

  // archive#1896 logging slice 2: the self-read path over the durable
  // NDJSON store slice 1 (`server-log-store.ts`) writes. `level` here is a
  // MINIMUM severity floor, not an exact match — see `ServerLogReader`'s
  // own docblock for the tail-query and redaction-on-egress contract.
  app.get('/logs', async (c) => {
    try {
      let agentSessionId: string | undefined;
      if (requestMayBeAnAgent(c.req.raw)) {
        const authority = stationControlRequestAuthority(c.req.raw);
        if (authority?.kind !== 'server') {
          if (
            authority?.kind !== 'caller' ||
            authority.caller.assurance !== 'bound' ||
            !authority.caller.principal?.elevationEligible ||
            !hasAgentGrant(authority.caller.sessionId)
          )
            return c.json(
              { error: 'Diagnostics log access is not granted' },
              403,
            );
          agentSessionId = authority.caller.sessionId;
        }
      }
      const rawLevel = c.req.query('level');
      if (rawLevel !== undefined && !isLogLevel(rawLevel)) {
        return c.json(
          {
            error: `Invalid level "${rawLevel}"; accepted values: ${LOG_LEVEL_ORDER.join(', ')}`,
          },
          400,
        );
      }

      const since = c.req.query('since');
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        return c.json(
          {
            error: `Invalid since "${since}"; expected an ISO 8601 timestamp`,
          },
          400,
        );
      }
      const until = c.req.query('until');
      if (until !== undefined && Number.isNaN(Date.parse(until))) {
        return c.json(
          {
            error: `Invalid until "${until}"; expected an ISO 8601 timestamp`,
          },
          400,
        );
      }

      // Clamped, not rejected: an out-of-range or non-numeric `limit` still
      // returns a bounded result rather than a 400 — only `level` has a
      // fixed accepted vocabulary worth naming in an error.
      const rawLimit = c.req.query('limit');
      let limit: number | undefined;
      if (rawLimit !== undefined) {
        const parsed = Number(rawLimit);
        limit = Number.isFinite(parsed)
          ? Math.min(
              Math.max(Math.floor(parsed), 1),
              MAX_SERVER_LOG_QUERY_LIMIT,
            )
          : undefined;
      }

      const q = c.req.query('q');

      const options: ServerLogQueryOptions = {
        ...(rawLevel !== undefined ? { level: rawLevel } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(q !== undefined ? { q } : {}),
        // One derivation, bound by the auth boundary: the owner (mint-time
        // `locality: 'home-possession'` or owner-device standing). Absent (or a
        // second call that skipped the boundary) fails closed to redacted.
        redact: !isBoundRuntimeOwner(c.req.raw),
      };

      const result = await logReader.query(options);
      if (agentSessionId && !hasAgentGrant(agentSessionId))
        return c.json({ error: 'Diagnostics log access is not granted' }, 403);
      serverLogsRead.add(1, { surface: 'route' });
      return c.json(result);
    } catch (error) {
      logger.error('Failed to query server logs', { error });
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  return app;
}
