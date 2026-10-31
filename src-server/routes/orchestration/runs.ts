import type {
  RunOutputRef,
  RunSummary,
} from '@kontourai/station-contracts/runs';
import {
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  getTenantRequestContext,
  loadHostedTenantRegistryFromEnvironment,
} from '../../runtime/bootstrap/runtime-tenant-context.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import {
  NativeInvocationStorageUnavailableError,
  type RunService,
  VoiceTurnStorageUnavailableError,
} from '../../services/orchestration/run-service.js';
import { SchedulerStorageUnavailableError } from '../../services/scheduling/scheduler-ledger.js';
import type { Logger } from '../../utils/logger.js';
import { errorMessage, param } from '../schemas/schemas.js';
import { getCachedUser } from '../system/auth.js';

export function createRunRoutes(
  runService: RunService,
  logger: Logger,
  getSessionReadAuthority?: (request: Request) => SessionReadAuthority,
  scheduleReadFilter?: (c: Context) => Promise<(run: RunSummary) => boolean>,
) {
  const app = new Hono();
  // Only verified ingress context plus deployment configuration may mint the
  // fallback. Runtime wiring can inject this same request-scoped resolver in
  // Wave 4 without storing an authority on the singleton route/service.
  const hostedTenantRegistry = loadHostedTenantRegistryFromEnvironment();
  const authorityFor =
    getSessionReadAuthority ??
    ((request: Request) =>
      sessionReadAuthorityFromRequest(
        getCachedUser().alias,
        getTenantRequestContext(request),
        hostedTenantRegistry,
      ));
  const errorStatus = (error: unknown) =>
    error instanceof SchedulerStorageUnavailableError ||
    error instanceof NativeInvocationStorageUnavailableError ||
    error instanceof VoiceTurnStorageUnavailableError
      ? 503
      : 500;

  app.get('/', async (c) => {
    try {
      const agent = requestMayBeAnAgent(c.req.raw);
      const requestedSource = c.req.query('source');
      if (agent && requestedSource && requestedSource !== 'schedule')
        return c.json({ success: true, data: [] });
      const data = await runService.listRuns(authorityFor(c.req.raw), {
        source: (agent ? 'schedule' : requestedSource) as
          | 'orchestration'
          | 'schedule'
          | 'invoke'
          | 'voice'
          | undefined,
        providerId: c.req.query('providerId'),
        sourceId: c.req.query('sourceId'),
      });
      const mayRead = data.some((run) => run.source === 'schedule')
        ? await scheduleReadFilter?.(c)
        : undefined;
      return c.json({
        success: true,
        data: data.filter(
          (run) => run.source !== 'schedule' || !!mayRead?.(run),
        ),
      });
    } catch (error: unknown) {
      logger.error('Failed to list runs', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        errorStatus(error),
      );
    }
  });

  app.post('/output', async (c) => {
    try {
      const ref = (await c.req.json()) as RunOutputRef;
      if (ref.source === 'schedule') {
        if (!scheduleReadFilter)
          return c.json({ success: false, error: 'Run output not found' }, 404);
        const run = await runService.readRun(
          ref.runId,
          authorityFor(c.req.raw),
        );
        const mayRead = await scheduleReadFilter(c);
        if (!run || run.source !== 'schedule' || !mayRead(run))
          return c.json({ success: false, error: 'Run output not found' }, 404);
      }
      const content = await runService.readOutput(ref, authorityFor(c.req.raw));
      if (content === null) {
        return c.json({ success: false, error: 'Run output not found' }, 404);
      }
      return c.json({ success: true, data: { content } });
    } catch (error: unknown) {
      logger.error('Failed to read run output', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        errorStatus(error),
      );
    }
  });

  app.get('/:runId', async (c) => {
    try {
      if (
        requestMayBeAnAgent(c.req.raw) &&
        !param(c, 'runId').startsWith('schedule:')
      )
        return c.json({ success: false, error: 'Run not found' }, 404);
      const data = await runService.readRun(
        param(c, 'runId'),
        authorityFor(c.req.raw),
      );
      const mayRead =
        data?.source === 'schedule' ? await scheduleReadFilter?.(c) : undefined;
      if (!data || (data.source === 'schedule' && !mayRead?.(data))) {
        return c.json({ success: false, error: 'Run not found' }, 404);
      }
      return c.json({ success: true, data });
    } catch (error: unknown) {
      logger.error('Failed to read run', { error });
      return c.json(
        { success: false, error: errorMessage(error) },
        errorStatus(error),
      );
    }
  });

  return app;
}
