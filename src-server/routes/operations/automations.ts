/**
 * Automation operator routes (epic kontourai/station#3439, S5 #4513), the
 * HTTP side of `AUTOMATION_OPERATOR_SURFACE`.
 *
 * Reads return bounded projections: hashed transport keys, closed outcome
 * and reason codes, ids, and sources without their webhook secret. Every
 * mutation is refused unless `operator(request)` proves a person acting in
 * person (never an agent session, Station Control or a hosted tenant); the
 * composition derives that from trusted request ingress. This surface edits
 * only `dispatch-task` rules: isolated-repair rules and the sources that
 * grant repair or publication keep their own surface
 * (`/api/isolated-repairs`), which checks that preview's setup. Disabling
 * and deleting narrow authority, so they need no expected fingerprint and
 * stay available while the observation preview is off.
 */

import {
  AUTOMATION_ACTION_KINDS,
  type AutomationDeliveryRecord,
  type AutomationEpisodeRecord,
  type AutomationPollRecord,
  type AutomationRule,
  type AutomationRuleList,
  type AutomationSourceList,
} from '@kontourai/station-contracts/automation';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { automationConfigurationFingerprint } from '../../services/automation/automation-intent.js';
import type { RetryEpisodeOutcome } from '../../services/automation/automation-ledger.js';
import {
  AutomationPolicyUnavailableError,
  type AutomationStore,
  AutomationValidationError,
  projectAutomationSource,
} from '../../services/automation/automation-store.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import type { Logger } from '../../utils/logger.js';

const AUTOMATION_DELIVERIES_DEFAULT_LIMIT = 50;
const AUTOMATION_DELIVERIES_MAX_LIMIT = 200;

/** A person acting in person; `assertCurrent` re-proves it inside the write lock. */
export type AutomationOperator = Readonly<{
  id: string;
  assertCurrent(): Promise<void>;
}>;

export interface AutomationRouteDependencies {
  preview: FeaturePreviewSelector | undefined;
  listDeliveries(limit: number): AutomationDeliveryRecord[];
  listPolls(): AutomationPollRecord[];
  /** Runtime composition derives this only from trusted request ingress. */
  readAuthorityForRequest?: (request: Request) => SessionReadAuthority;
  /** Absent: the configuration surface answers 404 (not supported). */
  store?: Pick<
    AutomationStore,
    | 'read'
    | 'createSource'
    | 'createRule'
    | 'updateRule'
    | 'deleteRule'
    | 'deleteSource'
    | 'setEnabled'
  >;
  listOpenEpisodes?(limit: number): AutomationEpisodeRecord[];
  retryEpisode?(ruleId: string, episodeId: string): RetryEpisodeOutcome;
  /** Throws unless the request is a person acting in person. */
  operator?(request: Request): Promise<AutomationOperator>;
}

/** A positive integer within the ceiling; anything else is refused, never clamped. */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return AUTOMATION_DELIVERIES_DEFAULT_LIMIT;
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) return undefined;
  const limit = Number(raw);
  return limit <= AUTOMATION_DELIVERIES_MAX_LIMIT ? limit : undefined;
}

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const matcher = z
  .object({
    type: z.literal('github.workflow_run.completed'),
    where: z.record(
      z.string().max(64),
      z.union([z.string().max(256), z.array(z.string().max(256)).max(16)]),
    ),
  })
  .strict();
/** Exactly the editable `dispatch-task` rule; the store validates the rest. */
const dispatchRule = z
  .object({
    name: z.string().min(1).max(128),
    match: matcher,
    episode: z
      .object({
        keyFields: z.array(z.string().max(64)).max(8),
        closeOn: matcher.optional(),
        maxAttempts: z.number().int().positive(),
      })
      .strict()
      .optional(),
    action: z
      .object({
        kind: z.literal('dispatch-task'),
        projectId: id,
        agentId: id,
        instructions: z.string().min(1).max(8192),
        approvalMode: z.enum(['ask', 'auto']).optional(),
        budget: z
          .object({
            maxTurns: z.number().int().positive(),
            maxTokens: z.number().int().positive(),
            maxWallRuntimeMs: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    rateLimit: z
      .object({ maxStartsPerHour: z.number().int().positive() })
      .strict(),
  })
  .strict();
/** A disabled `github-poll` source; shared with the isolated repair surface. */
export const automationPollSourceSchema = z
  .object({
    kind: z.literal('github-poll'),
    name: z.string().min(1).max(128),
    repository: z.string().min(1).max(200),
    credentialSecretBinding: z.string().min(1).max(128).optional(),
    pollIntervalMs: z.number().int().positive().optional(),
    grants: z
      .array(
        z
          .object({
            projectId: id,
            agentId: id,
            actions: z.array(z.enum(AUTOMATION_ACTION_KINDS)).max(8),
          })
          .strict(),
      )
      .max(32)
      .optional(),
  })
  .strict();
const expected = z.object({ expectedFingerprint: digest }).strict();
const optionalExpected = z
  .object({ expectedFingerprint: digest.optional() })
  .strict();

/** Actions only the isolated-repair surface may enable. */
const REPAIR_ONLY_GRANTS = new Set(['isolated-repair', 'publish-branch']);

/** A refusal this module authors; `text` is always one of its own literals. */
class RouteRefusal extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly text: string,
    readonly code?: string,
  ) {
    super(text);
  }
}

/**
 * Validation problems are authored in `automation-config-validation.ts` and
 * the store, and name only configuration paths, ids and the caller's own
 * (schema-bounded) keys. They are still bounded and stripped of control
 * characters before they leave the route.
 */
function boundedProblems(problems: readonly string[]): string[] {
  return problems.slice(0, 8).map((problem) =>
    Array.from(problem.slice(0, 200), (char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? ' ' : char;
    }).join(''),
  );
}

/** `<ruleId>:<episodeId>`: a rule id never contains a colon; an episode id may. */
function parseEpisodeTarget(
  target: string,
): { ruleId: string; episodeId: string } | undefined {
  const separator = target.indexOf(':');
  if (separator <= 0) return undefined;
  const ruleId = target.slice(0, separator);
  const episodeId = target.slice(separator + 1);
  if (
    !id.safeParse(ruleId).success ||
    episodeId.length === 0 ||
    episodeId.length > 256
  )
    return undefined;
  return { ruleId, episodeId };
}

const RETRY_REFUSALS: Record<
  Exclude<RetryEpisodeOutcome['kind'], 'retried'>,
  { status: 404 | 409; message: string }
> = {
  'not-found': { status: 404, message: 'No open episode with that id.' },
  'not-exhausted': {
    status: 409,
    message: 'The episode still has an attempt; nothing to retry.',
  },
  indeterminate: {
    status: 409,
    message:
      'The episode has an action whose result is unknown; it is never replayed.',
  },
  active: {
    status: 409,
    message: 'The episode still has work pending or running.',
  },
  'no-intent': {
    status: 409,
    message: 'The episode retained no action to retry.',
  },
  stale: {
    status: 409,
    message:
      'The episode’s event is older than 72 hours; wait for the next matching event.',
  },
  'policy-unavailable': {
    status: 409,
    message:
      'The rule may not act now (it is not live, or its source no longer grants the action).',
  },
};

export function createAutomationRoutes(
  deps: AutomationRouteDependencies,
  logger: Logger,
) {
  const app = new Hono();

  // Automation storage has no tenant binding, like the scheduler's: hosted
  // mode sees no Automation surface.
  const hidden = (request: Request) => {
    const authority = deps.readAuthorityForRequest?.(request);
    return authority !== undefined && isHostedSessionReadAuthority(authority);
  };
  const previewOn = () =>
    deps.preview?.select({ enabled: () => true, disabled: () => false }) ===
    true;
  const previewDisabled = (c: Context) =>
    c.json(
      {
        success: false,
        error:
          'Enable GitHub automation observations in Settings → Advanced → Feature previews.',
        code: 'feature_preview_disabled',
        previewId: 'github-automation-observations',
        settingsPath:
          '/settings?view=feature-previews&highlight=feature-previews',
      },
      404,
    );
  const body = async (request: Request): Promise<unknown> => {
    // Disable and delete need no body; an absent one is an empty object.
    if (request.body === null) return {};
    const bounded = await readBoundedRequestBody(request, 32_768);
    if (bounded.status !== 'ok')
      throw new RouteRefusal(400, 'Invalid automation request');
    if (bounded.body.trim() === '') return {};
    try {
      return JSON.parse(bounded.body);
    } catch {
      throw new RouteRefusal(400, 'Invalid automation request');
    }
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new RouteRefusal(400, 'Invalid automation request');
    return parsed.data;
  };

  /**
   * Shared guard. `maintenance` (disable, delete) stays available while the
   * preview is off; everything else needs it. A mutation needs `operator`.
   */
  const guard = async (
    c: Context,
    kind: 'read' | 'mutation' | 'maintenance',
    work: (operator: AutomationOperator | undefined) => Promise<Response>,
  ): Promise<Response> => {
    c.header('Cache-Control', 'no-store');
    if (hidden(c.req.raw))
      return c.json({ success: false, error: 'Automations not found' }, 404);
    if (kind !== 'maintenance' && !previewOn()) return previewDisabled(c);
    try {
      let operator: AutomationOperator | undefined;
      if (kind !== 'read') {
        if (!deps.operator)
          throw new RouteRefusal(404, 'Automations not found');
        try {
          operator = await deps.operator(c.req.raw);
        } catch {
          throw new RouteRefusal(
            403,
            'Changing Automations needs the operator, in person.',
            'operator_required',
          );
        }
      }
      return await work(operator);
    } catch (error) {
      if (error instanceof RouteRefusal)
        return c.json(
          {
            success: false,
            error: error.text,
            ...(error.code ? { code: error.code } : {}),
          },
          error.status,
        );
      if (error instanceof AutomationValidationError) {
        const problems = boundedProblems(error.problems);
        return c.json(
          {
            success: false,
            error: `Automation change refused: ${problems.join('; ')}`,
            code: error.code,
            problems,
          },
          409,
        );
      }
      if (error instanceof AutomationPolicyUnavailableError) {
        logger.warn('Automation policy unavailable', { detail: error.detail });
        return c.json(
          {
            success: false,
            error: 'Automation policy is unavailable.',
            code: error.code,
          },
          503,
        );
      }
      throw error;
    }
  };
  const store = () => {
    if (!deps.store) throw new RouteRefusal(404, 'Automations not found');
    return deps.store;
  };
  /** The operator's write lock re-proves the operator and the preview. */
  const current =
    (operator: AutomationOperator | undefined, needsPreview: boolean) =>
    async () => {
      await operator?.assertCurrent();
      if (needsPreview && !previewOn())
        throw new RouteRefusal(404, 'Automation observations are off.');
    };
  const ruleOf = (rules: readonly AutomationRule[], ruleId: string) =>
    rules.find((rule) => rule.id === ruleId);

  app.get('/deliveries', (c) =>
    guard(c, 'read', async () => {
      const limit = parseLimit(c.req.query('limit'));
      if (limit === undefined)
        throw new RouteRefusal(
          400,
          `limit must be an integer from 1 to ${AUTOMATION_DELIVERIES_MAX_LIMIT}`,
        );
      return c.json({
        success: true,
        data: {
          deliveries: deps.listDeliveries(limit),
          polls: deps.listPolls(),
        },
      });
    }),
  );

  app.get('/sources', (c) =>
    guard(c, 'read', async () => {
      const configuration = store().read();
      const data: AutomationSourceList = {
        configurationFingerprint:
          automationConfigurationFingerprint(configuration),
        sources: configuration.sources.map(projectAutomationSource),
      };
      return c.json({ success: true, data });
    }),
  );

  app.post('/sources', (c) =>
    guard(c, 'mutation', async (operator) => {
      const input = parse(automationPollSourceSchema, await body(c.req.raw));
      const created = await store().createSource(
        input,
        current(operator, true),
      );
      return c.json({ success: true, data: created }, 201);
    }),
  );

  app.put('/sources/:target/enable', (c) =>
    guard(c, 'mutation', async (operator) => {
      const input = parse(expected, await body(c.req.raw));
      const source = store()
        .read()
        .sources.find(({ id }) => id === c.req.param('target'));
      if (!source)
        throw new RouteRefusal(
          404,
          'Automation source not found',
          'automation_not_found',
        );
      if (
        (source.grants ?? []).some((grant) =>
          grant.actions.some((action) => REPAIR_ONLY_GRANTS.has(action)),
        )
      )
        throw new RouteRefusal(
          409,
          'This source grants isolated repair or publication; enable it from the isolated repair surface.',
          'repair_surface_required',
        );
      await store().setEnabled(
        {
          kind: 'source',
          id: source.id,
          expectedFingerprint: input.expectedFingerprint,
          enabled: true,
        },
        current(operator, true),
      );
      return c.json({ success: true });
    }),
  );

  app.put('/sources/:target/disable', (c) =>
    guard(c, 'maintenance', async (operator) => {
      const input = parse(optionalExpected, await body(c.req.raw));
      const configuration = store().read();
      await store().setEnabled(
        {
          kind: 'source',
          id: c.req.param('target'),
          expectedFingerprint:
            input.expectedFingerprint ??
            automationConfigurationFingerprint(configuration),
          enabled: false,
        },
        current(operator, false),
      );
      return c.json({ success: true });
    }),
  );

  app.delete('/sources/:target', (c) =>
    guard(c, 'maintenance', async (operator) => {
      await store().deleteSource(
        { id: c.req.param('target') },
        current(operator, false),
      );
      return c.json({ success: true });
    }),
  );

  app.get('/rules', (c) =>
    guard(c, 'read', async () => {
      const configuration = store().read();
      const data: AutomationRuleList = {
        configurationFingerprint:
          automationConfigurationFingerprint(configuration),
        rules: configuration.rules,
      };
      return c.json({ success: true, data });
    }),
  );

  app.post('/rules', (c) =>
    guard(c, 'mutation', async (operator) => {
      const raw = await body(c.req.raw);
      const sourceId = parse(
        z.object({ sourceId: id }).passthrough(),
        raw,
      ).sourceId;
      const { sourceId: _sourceId, ...rest } = raw as Record<string, unknown>;
      const rule = parse(dispatchRule, rest);
      const created = await store().createRule(
        { ...rule, sourceId },
        current(operator, true),
      );
      return c.json({ success: true, data: created }, 201);
    }),
  );

  app.put('/rules/:target', (c) =>
    guard(c, 'mutation', async (operator) => {
      const raw = await body(c.req.raw);
      const { expectedFingerprint } = parse(
        z.object({ expectedFingerprint: digest }).passthrough(),
        raw,
      );
      const { expectedFingerprint: _fingerprint, ...rest } = raw as Record<
        string,
        unknown
      >;
      const rule = parse(dispatchRule, rest);
      const updated = await store().updateRule(
        {
          id: c.req.param('target'),
          expectedFingerprint,
          kinds: ['dispatch-task'],
          rule,
        },
        current(operator, true),
      );
      return c.json({ success: true, data: updated });
    }),
  );

  app.put('/rules/:target/enable', (c) =>
    guard(c, 'mutation', async (operator) => {
      const input = parse(expected, await body(c.req.raw));
      const rule = ruleOf(store().read().rules, c.req.param('target'));
      if (!rule)
        throw new RouteRefusal(
          404,
          'Automation rule not found',
          'automation_not_found',
        );
      if (rule.action.kind !== 'dispatch-task')
        throw new RouteRefusal(
          409,
          'Enable an isolated repair rule from the isolated repair surface.',
          'repair_surface_required',
        );
      await store().setEnabled(
        {
          kind: 'rule',
          id: rule.id,
          expectedFingerprint: input.expectedFingerprint,
          mode: 'live',
        },
        current(operator, true),
      );
      return c.json({ success: true });
    }),
  );

  app.put('/rules/:target/disable', (c) =>
    guard(c, 'maintenance', async (operator) => {
      const input = parse(optionalExpected, await body(c.req.raw));
      const configuration = store().read();
      await store().setEnabled(
        {
          kind: 'rule',
          id: c.req.param('target'),
          expectedFingerprint:
            input.expectedFingerprint ??
            automationConfigurationFingerprint(configuration),
          mode: 'off',
        },
        current(operator, false),
      );
      return c.json({ success: true });
    }),
  );

  app.delete('/rules/:target', (c) =>
    guard(c, 'maintenance', async (operator) => {
      await store().deleteRule(
        { id: c.req.param('target'), kinds: ['dispatch-task'] },
        current(operator, false),
      );
      return c.json({ success: true });
    }),
  );

  app.get('/episodes', (c) =>
    guard(c, 'read', async () => {
      const limit = parseLimit(c.req.query('limit'));
      if (limit === undefined)
        throw new RouteRefusal(
          400,
          `limit must be an integer from 1 to ${AUTOMATION_DELIVERIES_MAX_LIMIT}`,
        );
      if (!deps.listOpenEpisodes)
        throw new RouteRefusal(404, 'Automations not found');
      return c.json({
        success: true,
        data: { episodes: deps.listOpenEpisodes(limit) },
      });
    }),
  );

  app.post('/episodes/:target/retry', (c) =>
    guard(c, 'mutation', async (operator) => {
      const target = parseEpisodeTarget(c.req.param('target'));
      if (!target) throw new RouteRefusal(400, 'Invalid episode target');
      if (!deps.retryEpisode)
        throw new RouteRefusal(404, 'Automations not found');
      await operator?.assertCurrent();
      const outcome = deps.retryEpisode(target.ruleId, target.episodeId);
      if (outcome.kind !== 'retried') {
        const refusal = RETRY_REFUSALS[outcome.kind];
        throw new RouteRefusal(
          refusal.status,
          refusal.message,
          outcome.kind === 'not-found' ? 'automation_not_found' : outcome.kind,
        );
      }
      return c.json({
        success: true,
        data: {
          ruleId: outcome.intent.ruleId,
          episodeId: outcome.intent.episodeId,
          retry: outcome.intent.retry ?? 0,
        },
      });
    }),
  );

  return app;
}
