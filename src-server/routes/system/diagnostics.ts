import { Hono } from 'hono';
import { isBoundRuntimeLocalOperator } from '../../security/runtime-request-security.js';
import type { DiagnosticsService } from '../../services/infra/diagnostics-service.js';
import {
  MAX_SERVER_LOG_QUERY_LIMIT,
  type ServerLogQueryOptions,
  type ServerLogReader,
} from '../../services/infra/server-log-reader.js';
import { serverLogsRead } from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import { isLogLevel, LOG_LEVEL_ORDER } from '../../utils/logger.js';
import { errorMessage } from '../schemas/schemas.js';

export function createDiagnosticsRoutes(
  diagnosticsService: DiagnosticsService,
  logger: Logger,
  logReader: ServerLogReader,
) {
  const app = new Hono();

  app.get('/bundle', async (c) => {
    try {
      return c.json(await diagnosticsService.generateBundle());
    } catch (error) {
      logger.error('Failed to generate diagnostics bundle', { error });
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  // station#1896 logging slice 2: the self-read path over the durable
  // NDJSON store slice 1 (`server-log-store.ts`) writes. `level` here is a
  // MINIMUM severity floor, not an exact match — see `ServerLogReader`'s
  // own docblock for the tail-query and redaction-on-egress contract.
  app.get('/logs', async (c) => {
    try {
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
        // One derivation, bound by the auth boundary: mint-time
        // `locality: 'home-possession'`. Absent (or a second call that
        // skipped the boundary) fails closed to redacted.
        redact: !isBoundRuntimeLocalOperator(c.req.raw),
      };

      const result = await logReader.query(options);
      serverLogsRead.add(1, { surface: 'route' });
      return c.json(result);
    } catch (error) {
      logger.error('Failed to query server logs', { error });
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  return app;
}
