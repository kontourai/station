/**
 * Flow Run Routes - project-scoped Flow gate-engine runs
 * Mounted at /api/projects/:slug/flow
 */

import { parseGateEvaluationRef } from '@kontourai/flow/gate-evaluation-contract';
import { isRetiredFlowDefinition } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import {
  VeritasCliError,
  VeritasNotConfiguredError,
} from '../../services/evidence/veritas-readiness-service.js';
import type { FlowReadinessBridge } from '../../services/flow/flow-readiness-bridge.js';
import {
  FlowRunInvalidError,
  FlowRunNotFoundError,
  type FlowRunService,
} from '../../services/flow/flow-run-service.js';
import type { SurveyFlowReviewService } from '../../services/flow/survey-flow-review-service.js';
import { flowLayoutInits } from '../../telemetry/metrics.js';
import {
  errorMessage,
  flowCommandEvidenceSchema,
  flowEvaluateSchema,
  flowEvidenceAttachSchema,
  flowExceptionSchema,
  flowReadinessEvidenceSchema,
  flowRunStartSchema,
  getBody,
  param,
  surveyFlowReviewContinueSchema,
  surveyFlowReviewDiscoverSchema,
  validate,
} from '../schemas/schemas.js';

export interface FlowRunRouteDeps {
  /** Resolve a project slug to its workspace path (workingDirectory). */
  getWorkspacePath: (slug: string) => string | undefined;
  /** Runtime-owned request witness; absent only in standalone local composition. */
  isRequestPrincipalCurrent?: (request: Request) => boolean;
  /** Enables POST /runs/:runId/evidence/readiness (the S1c wiring). */
  readinessBridge?: FlowReadinessBridge;
  /** Canonical Survey review composition; omitted when the host has no review-session provider. */
  surveyReview?: SurveyFlowReviewService;
}

function errorStatus(error: unknown): 400 | 404 | 500 {
  if (error instanceof FlowRunNotFoundError) return 404;
  if (error instanceof FlowRunInvalidError) return 400;
  return 500;
}

export function createFlowRunRoutes(
  flowRunService: FlowRunService,
  deps: FlowRunRouteDeps,
) {
  const app = new Hono<{ Variables: { cwd: string } }>();

  // Resolve the project workspace once per request.
  app.use('*', async (c, next) => {
    const slug = c.req.param('slug') ?? '';
    const cwd = deps.getWorkspacePath(slug);
    if (!cwd) {
      return c.json(
        { success: false, error: `Project workspace not found: ${slug}` },
        404,
      );
    }
    c.set('cwd', cwd);
    await next();
  });

  // Detect Flow definitions in the workspace (GET /definitions)
  app.get('/definitions', async (c) => {
    try {
      const data = await flowRunService.detectWorkspace(c.get('cwd'));
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json(
        { success: false, error: errorMessage(error) },
        errorStatus(error),
      );
    }
  });

  // Scaffold the canonical `.flow/` layout in the workspace (POST /init). The
  // coding side-panel "Add a delivery flow" CTA calls this behind a confirm.
  // `ensureFlowLayout` is idempotent, so re-running over an initialized
  // workspace is safe; we report whether definitions already existed so the
  // panel can message "already set up" instead of implying it created them.
  app.post('/init', async (c) => {
    const cwd = c.get('cwd');
    try {
      const before = await flowRunService.detectWorkspace(cwd);
      await flowRunService.ensureLayout(cwd);
      const after = await flowRunService.detectWorkspace(cwd);
      const outcome = before.initialized ? 'already-initialized' : 'created';
      flowLayoutInits.add(1, { outcome });
      return c.json({
        success: true,
        data: { outcome, ...after },
      });
    } catch (error: unknown) {
      flowLayoutInits.add(1, { outcome: 'error' });
      return c.json(
        { success: false, error: errorMessage(error) },
        errorStatus(error),
      );
    }
  });

  // List runs (GET /runs)
  app.get('/runs', async (c) => {
    try {
      // `diagnostics` is additive alongside the unchanged `data` array: Flow
      // omits a run directory it cannot inspect, so without this a corrupted
      // run is simply absent from a list that looks complete.
      const { runs, diagnostics } =
        await flowRunService.listRunsWithDiagnostics(c.get('cwd'));
      return c.json({
        success: true,
        data: runs,
        ...(diagnostics.length ? { diagnostics } : {}),
      });
    } catch (error: unknown) {
      return c.json(
        { success: false, error: errorMessage(error) },
        errorStatus(error),
      );
    }
  });

  // Start a run (POST /runs)
  app.post('/runs', validate(flowRunStartSchema), async (c) => {
    try {
      const input = getBody(c);
      if (isRetiredFlowDefinition(input.definition)) {
        return c.json(
          {
            success: false,
            error: 'Flow definition is retired and cannot start new runs',
            code: 'flow.definition.retired',
            definition: input.definition,
          },
          409,
        );
      }
      const data = await flowRunService.startRun(c.get('cwd'), input);
      return c.json({ success: true, data }, 201);
    } catch (error: unknown) {
      return c.json(
        { success: false, error: errorMessage(error) },
        errorStatus(error),
      );
    }
  });

  // Run status: definition + state + manifest + open gates (GET /runs/:runId)
  app.get('/runs/:runId', async (c) => {
    try {
      const data = await flowRunService.getRun(c.get('cwd'), param(c, 'runId'));
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json(
        { success: false, error: errorMessage(error) },
        errorStatus(error),
      );
    }
  });

  // Console projection: gates/outcomes, expectations, evidence, exceptions,
  // route-backs, report path — Flow's own read-side shape for the run
  // console layout (GET /runs/:runId/console).
  app.get('/runs/:runId/console', async (c) => {
    try {
      const data = await flowRunService.getRunConsole(
        c.get('cwd'),
        param(c, 'runId'),
      );
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json(
        { success: false, error: errorMessage(error) },
        errorStatus(error),
      );
    }
  });

  // Exact immutable gate receipt inspection. This is intentionally a Flow
  // console capability, not a Task capability: a Task may later retain the
  // same ref, but cannot manufacture or broaden Flow's authority.
  app.get('/runs/:runId/gates/:gateId/evaluations/:evaluationId', async (c) => {
    const ref = parseGateEvaluationRef({
      runId: param(c, 'runId'),
      gateId: param(c, 'gateId'),
      evaluationId: param(c, 'evaluationId'),
    });
    if (!ref) {
      return c.json(
        { success: false, error: 'Gate evaluation not found' },
        404,
      );
    }
    try {
      const request = c.req.raw;
      const slug = c.req.param('slug') ?? '';
      const cwd = c.get('cwd');
      // Flow rechecks this witness around its awaited owner read. Re-resolve
      // the Project workspace rather than trusting the middleware snapshot:
      // a Project repoint during I/O must withhold the old workspace receipt.
      const authorize = () =>
        (!deps.isRequestPrincipalCurrent ||
          deps.isRequestPrincipalCurrent(request) === true) &&
        deps.getWorkspacePath(slug) === cwd;
      const result = await flowRunService.readGateEvaluation(
        cwd,
        ref,
        authorize,
      );
      if (result.status === 'found')
        return c.json({ success: true, data: result.evaluation });
      if (result.status === 'unsupported') {
        return c.json(
          {
            success: false,
            error: 'Gate evaluation is unsupported',
            code: 'flow.gate_evaluation.unsupported',
          },
          409,
        );
      }
      if (result.status === 'unavailable') {
        return c.json(
          {
            success: false,
            error: 'Gate evaluation is temporarily unavailable',
          },
          503,
        );
      }
      return c.json(
        { success: false, error: 'Gate evaluation not found' },
        404,
      );
    } catch {
      return c.json(
        { success: false, error: 'Gate evaluation is temporarily unavailable' },
        503,
      );
    }
  });

  app.get('/reviews', async (c) => {
    if (!deps.surveyReview) {
      return c.json(
        { success: false, error: 'Survey review provider is not configured' },
        503,
      );
    }
    try {
      const slug = c.req.param('slug') ?? '';
      return c.json({
        success: true,
        data: await deps.surveyReview.list(slug),
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post(
    '/runs/:runId/reviews/discover',
    validate(surveyFlowReviewDiscoverSchema),
    async (c) => {
      if (!deps.surveyReview) {
        return c.json(
          { success: false, error: 'Survey review provider is not configured' },
          503,
        );
      }
      try {
        const body = getBody(c);
        const data = await deps.surveyReview.discover({
          ...body,
          runId: param(c, 'runId'),
          cwd: c.get('cwd'),
        });
        return c.json({ success: true, data });
      } catch (error: unknown) {
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
    },
  );

  app.post(
    '/runs/:runId/reviews/continue',
    validate(surveyFlowReviewContinueSchema),
    async (c) => {
      if (!deps.surveyReview) {
        return c.json(
          { success: false, error: 'Survey review provider is not configured' },
          503,
        );
      }
      try {
        const body = getBody(c);
        const data = await deps.surveyReview.continuePausedGate({
          ...body,
          runId: param(c, 'runId'),
          cwd: c.get('cwd'),
        });
        return c.json({ success: true, data });
      } catch (error: unknown) {
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
    },
  );

  // Attach evidence (POST /runs/:runId/evidence)
  app.post(
    '/runs/:runId/evidence',
    validate(flowEvidenceAttachSchema),
    async (c) => {
      try {
        const data = await flowRunService.attachEvidence(
          c.get('cwd'),
          param(c, 'runId'),
          getBody(c),
        );
        return c.json({ success: true, data }, 201);
      } catch (error: unknown) {
        return c.json(
          { success: false, error: errorMessage(error) },
          errorStatus(error),
        );
      }
    },
  );

  // Run a command in the project workspace and attach its output tail as
  // claim evidence (POST /runs/:runId/evidence/command). NOTE: this executes
  // an arbitrary command line server-side in the project workspace — the same
  // trust level as the scheduler and tool servers, which already run
  // user-configured commands. Exit 0 attaches the claim as `trusted`; non-zero
  // attaches failed evidence with route_reason `implementation_defect` so the
  // next evaluate routes back instead of staying silent.
  app.post(
    '/runs/:runId/evidence/command',
    validate(flowCommandEvidenceSchema),
    async (c) => {
      try {
        const data = await flowRunService.attachCommandEvidence(
          c.get('cwd'),
          param(c, 'runId'),
          getBody(c),
        );
        return c.json({ success: true, data }, 201);
      } catch (error: unknown) {
        return c.json(
          { success: false, error: errorMessage(error) },
          errorStatus(error),
        );
      }
    },
  );

  // Run Veritas readiness and attach the evidence record to the run's
  // readiness gate as a Station-asserted trust-bundle claim (S1c explicit trigger).
  // POST /runs/:runId/evidence/readiness
  app.post(
    '/runs/:runId/evidence/readiness',
    validate(flowReadinessEvidenceSchema),
    async (c) => {
      const bridge = deps.readinessBridge;
      if (!bridge) {
        return c.json(
          { success: false, error: 'Readiness evidence is not available' },
          501,
        );
      }
      try {
        const { gate, refresh } = getBody(c);
        const result = await bridge.attachReadinessEvidence(
          c.get('cwd'),
          param(c, 'runId'),
          { gate, refresh },
        );
        if (!result.attached) {
          // Unreachable without onlyWhenReady, but keep the contract total.
          return c.json({ success: true, data: result }, 200);
        }
        return c.json(
          {
            success: true,
            data: {
              attached: true,
              gateId: result.gateId,
              entry: result.entry,
              readiness: {
                overall: result.snapshot.overall,
                runId: result.snapshot.cli.runId,
                reportArtifactPath: result.snapshot.cli.reportArtifactPath,
              },
            },
          },
          201,
        );
      } catch (error: unknown) {
        if (error instanceof VeritasNotConfiguredError) {
          return c.json(
            {
              success: false,
              error: errorMessage(error),
              reason: error.reason,
            },
            409,
          );
        }
        if (error instanceof VeritasCliError) {
          return c.json(
            {
              success: false,
              error: errorMessage(error),
              exitCode: error.exitCode,
              stderrTail: error.stderrTail,
            },
            502,
          );
        }
        return c.json(
          { success: false, error: errorMessage(error) },
          errorStatus(error),
        );
      }
    },
  );

  // Evaluate all open gates or a single gate (POST /runs/:runId/evaluate)
  app.post('/runs/:runId/evaluate', validate(flowEvaluateSchema), async (c) => {
    try {
      const { gate } = getBody(c);
      const data = await flowRunService.evaluate(
        c.get('cwd'),
        param(c, 'runId'),
        gate,
      );
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json(
        { success: false, error: errorMessage(error) },
        errorStatus(error),
      );
    }
  });

  // Accept an exception for a gate (POST /runs/:runId/exception)
  app.post(
    '/runs/:runId/exception',
    validate(flowExceptionSchema),
    async (c) => {
      try {
        const data = await flowRunService.acceptException(
          c.get('cwd'),
          param(c, 'runId'),
          getBody(c),
        );
        return c.json({ success: true, data }, 201);
      } catch (error: unknown) {
        return c.json(
          { success: false, error: errorMessage(error) },
          errorStatus(error),
        );
      }
    },
  );

  // Run report (GET /runs/:runId/report?format=json|markdown)
  app.get('/runs/:runId/report', async (c) => {
    const format = c.req.query('format') ?? 'json';
    if (format !== 'json' && format !== 'markdown') {
      return c.json(
        { success: false, error: 'format must be json or markdown' },
        400,
      );
    }
    try {
      const data = await flowRunService.getReport(
        c.get('cwd'),
        param(c, 'runId'),
        format,
      );
      if (format === 'markdown') {
        return c.text(data as string);
      }
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json(
        { success: false, error: errorMessage(error) },
        errorStatus(error),
      );
    }
  });

  return app;
}
