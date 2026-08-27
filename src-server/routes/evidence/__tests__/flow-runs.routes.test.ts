import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  flowRunsStarted: { add: vi.fn() },
  flowEvidenceAttached: { add: vi.fn() },
  flowEvidenceAutoSuperseded: { add: vi.fn() },
  flowGateEvaluations: { add: vi.fn() },
  flowExceptionsAccepted: { add: vi.fn() },
  flowReportsGenerated: { add: vi.fn() },
  flowRunConsoleProjections: { add: vi.fn() },
  flowLayoutInits: { add: vi.fn() },
  veritasReadinessDuration: { record: vi.fn() },
  veritasReadinessRuns: { add: vi.fn() },
}));

const { createFlowRunRoutes } = await import('../flow-runs.js');
const { FlowRunInvalidError, FlowRunNotFoundError } = await import(
  '../../../services/flow/flow-run-service.js'
);
const { VeritasCliError, VeritasNotConfiguredError } = await import(
  '../../../services/evidence/veritas-readiness-service.js'
);

function createMockFlowRunService() {
  return {
    detectWorkspace: vi.fn().mockResolvedValue({
      initialized: true,
      definitions: [
        {
          id: 'test-flow',
          version: '1',
          path: '.flow/definitions/test-flow.json',
          valid: true,
        },
      ],
    }),
    listRunsWithDiagnostics: vi.fn().mockResolvedValue({
      runs: [
        {
          run_id: 'run-1',
          definition_id: 'test-flow',
          subject: 'demo',
          status: 'active',
          current_step: 'build',
          updated_at: '2026-06-11T00:00:00.000Z',
        },
      ],
      diagnostics: [
        {
          code: 'flow.run_location.no_complete_candidate',
          severity: 'warning',
          run_id: 'broken',
          message: 'canonical run directory is incomplete',
        },
      ],
    }),
    startRun: vi.fn().mockResolvedValue({
      runId: 'run-1',
      dir: '/ws/.kontourai/flow/runs/run-1',
      state: { run_id: 'run-1', definition_id: 'test-flow' },
    }),
    getRun: vi.fn().mockResolvedValue({
      runId: 'run-1',
      dir: '/ws/.kontourai/flow/runs/run-1',
      definition: { id: 'test-flow' },
      state: { run_id: 'run-1', current_step: 'build' },
      manifest: { evidence: [] },
      openGates: [{ id: 'build-gate', step: 'build' }],
    }),
    attachEvidence: vi.fn().mockResolvedValue({
      id: 'ev.1',
      gate_id: 'build-gate',
      kind: 'trust.bundle',
    }),
    attachCommandEvidence: vi.fn().mockResolvedValue({
      entry: {
        id: 'ev.2',
        gate_id: 'build-gate',
        kind: 'trust.bundle',
        bundle: { claims: [{ claimType: 'quality.tests', status: 'assumed' }] },
      },
      exitCode: 0,
      durationMs: 1200,
      timedOut: false,
      evidencePath: '/tmp/station-command-evidence-x/command-evidence.json',
      outputTail: ['all green'],
    }),
    evaluate: vi.fn().mockResolvedValue({
      runId: 'run-1',
      outcomes: [
        {
          gate_id: 'build-gate',
          status: 'route-back',
          route_back_to: 'build',
          attempt: 1,
          max_attempts: 2,
          limit_exceeded: false,
        },
      ],
      state: { run_id: 'run-1', current_step: 'build' },
    }),
    acceptException: vi.fn().mockResolvedValue({
      id: 'ex.1',
      gate_id: 'build-gate',
      reason: 'flaky',
      authority: 'lead',
    }),
    ensureLayout: vi.fn().mockResolvedValue('/ws/.flow'),
    getReport: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'active' }),
    getRunConsole: vi.fn().mockResolvedValue({
      schema_version: '1',
      run: {
        run_id: 'run-1',
        definition_id: 'test-flow',
        definition_version: '1',
        subject: 'demo',
        status: 'active',
        current_step: 'build',
        updated_at: '2026-06-11T00:00:00.000Z',
        params: {},
      },
      steps: [],
      current_step: 'build',
      open_gates: ['build-gate'],
      gates: [
        {
          id: 'build-gate',
          step_id: 'build',
          status: 'wait',
          summary: 'missing required evidence',
          is_open: true,
          expectations: [],
          evidence: [],
          missing: ['tests-passed'],
        },
      ],
      expectations: [],
      evidence: [],
      exceptions: [],
      transitions: [],
      route_backs: [],
      next_action: 'attach evidence for build-gate',
      report: null,
    }),
    readGateEvaluation: vi.fn().mockResolvedValue({
      status: 'found',
      evaluation: {
        evaluationId: '018f4b67-7f1d-4e68-8e10-5eb8a4958c51',
        verdict: 'pass',
      },
    }),
  };
}

function createMockReadinessBridge() {
  return {
    attachReadinessEvidence: vi.fn().mockResolvedValue({
      attached: true,
      gateId: 'readiness-gate',
      entry: {
        id: 'ev.1',
        gate_id: 'readiness-gate',
        kind: 'trust.bundle',
        bundle: {
          claims: [
            { claimType: 'governance.merge-readiness', status: 'assumed' },
          ],
        },
      },
      snapshot: {
        overall: 'ready',
        cli: {
          runId: 'veritas-123',
          reportArtifactPath: '.kontourai/veritas/evidence/veritas-123.json',
        },
      },
    }),
    detectWorkspace: vi.fn().mockReturnValue({ configured: true }),
  };
}

function createApp(
  service = createMockFlowRunService(),
  workspace = '/ws',
  readinessBridge?: ReturnType<typeof createMockReadinessBridge>,
  surveyReview?: {
    list: ReturnType<typeof vi.fn>;
    discover: ReturnType<typeof vi.fn>;
    continuePausedGate: ReturnType<typeof vi.fn>;
  },
) {
  const app = createFlowRunRoutes(service as any, {
    getWorkspacePath: vi.fn().mockReturnValue(workspace),
    readinessBridge: readinessBridge as any,
    surveyReview: surveyReview as any,
  });
  return { app, service };
}

function post(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Flow Run Routes', () => {
  test('Survey review routes preserve the run, gate, head, and opaque session binding', async () => {
    const surveyReview = {
      list: vi.fn().mockResolvedValue([{ reviewSessionRef: 'review:1' }]),
      discover: vi.fn().mockResolvedValue([{ id: 'work:1' }]),
      continuePausedGate: vi
        .fn()
        .mockResolvedValue({ flow: { status: 'active' } }),
    };
    const { app } = createApp(
      createMockFlowRunService(),
      '/ws',
      undefined,
      surveyReview,
    );
    expect((await json(await app.request('/reviews'))).data).toHaveLength(1);

    const head = 'a'.repeat(64);
    const discovered = await app.request(
      post('/runs/run-1/reviews/discover', {
        gate: 'human-review',
        expectedRunHead: head,
        reviewExpectationIds: ['reviewed'],
      }),
    );
    expect(discovered.status).toBe(200);
    expect(surveyReview.discover).toHaveBeenCalledWith({
      runId: 'run-1',
      cwd: '/ws',
      gate: 'human-review',
      expectedRunHead: head,
      reviewExpectationIds: ['reviewed'],
    });

    const continued = await app.request(
      post('/runs/run-1/reviews/continue', {
        gate: 'human-review',
        expectedRunHead: head,
        reviewSessionRef: 'review:1',
        resume: {
          reason: 'review complete',
          authority: {
            kind: 'operator_request',
            actor: 'reviewer',
            request_ref: 'station-request:1',
            requested_at: '2026-07-22T12:00:00.000Z',
          },
        },
      }),
    );
    expect(continued.status).toBe(200);
    expect(surveyReview.continuePausedGate).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        cwd: '/ws',
        gate: 'human-review',
        expectedRunHead: head,
        reviewSessionRef: 'review:1',
      }),
    );
  });

  test('Survey review routes are unavailable without a host session provider', async () => {
    const { app } = createApp();
    expect((await app.request('/reviews')).status).toBe(503);
  });

  test('Survey review failures use the shared sanitized route error response', async () => {
    const surveyReview = {
      list: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'review engine stderr https://provider.example.test/private?token=secret /Users/operator/private-key',
          ),
        ),
      discover: vi.fn(),
      continuePausedGate: vi.fn(),
    };
    const { app } = createApp(
      createMockFlowRunService(),
      '/ws',
      undefined,
      surveyReview,
    );

    const response = await app.request('/reviews');
    const body = await json(response);
    expect(response.status).toBe(400);
    expect(JSON.stringify(body)).not.toContain('provider.example');
    expect(JSON.stringify(body)).not.toContain('token=secret');
    expect(JSON.stringify(body)).not.toContain('/Users/operator');
  });

  test('returns 404 when the project workspace is unknown', async () => {
    const app = createFlowRunRoutes(createMockFlowRunService() as any, {
      getWorkspacePath: vi.fn().mockReturnValue(undefined),
    });
    const res = await app.request('/runs');
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.success).toBe(false);
  });

  test.each(['principal', 'workspace'] as const)(
    'withholds an exact receipt when the %s witness changes during its owner read',
    async (changed) => {
      const service = createMockFlowRunService();
      let currentPrincipal = true;
      let workspace = '/workspace-old';
      let release!: () => void;
      service.readGateEvaluation.mockImplementation(
        async (_cwd: string, _ref: unknown, authorize: () => boolean) => {
          expect(authorize()).toBe(true);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return authorize()
            ? { status: 'found', evaluation: { verdict: 'pass' } }
            : { status: 'missing' };
        },
      );
      const app = createFlowRunRoutes(service as any, {
        getWorkspacePath: () => workspace,
        isRequestPrincipalCurrent: () => currentPrincipal,
      });
      const response = app.request(
        '/runs/run-1/gates/gate-1/evaluations/018f4b67-7f1d-4e68-8e10-5eb8a4958c51',
      );
      await vi.waitFor(() =>
        expect(service.readGateEvaluation).toHaveBeenCalledOnce(),
      );
      if (changed === 'principal') currentPrincipal = false;
      else workspace = '/workspace-new';
      release();
      expect((await response).status).toBe(404);
    },
  );

  test('returns an exact receipt while its principal and workspace witnesses remain current', async () => {
    const service = createMockFlowRunService();
    const app = createFlowRunRoutes(service as any, {
      getWorkspacePath: () => '/workspace-stable',
      isRequestPrincipalCurrent: () => true,
    });
    const response = await app.request(
      '/runs/run-1/gates/gate-1/evaluations/018f4b67-7f1d-4e68-8e10-5eb8a4958c51',
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      success: true,
      data: { verdict: 'pass' },
    });
  });

  test('GET /definitions detects workspace Flow definitions', async () => {
    const { app, service } = createApp();
    const res = await app.request('/definitions');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.initialized).toBe(true);
    expect(body.data.definitions[0].id).toBe('test-flow');
    expect(service.detectWorkspace).toHaveBeenCalledWith('/ws');
  });

  test('POST /init scaffolds a flow layout when none exists', async () => {
    const service = createMockFlowRunService();
    service.detectWorkspace
      .mockResolvedValueOnce({ initialized: false, definitions: [] })
      .mockResolvedValueOnce({
        initialized: true,
        definitions: [
          {
            id: 'station-delivery',
            path: '.flow/definitions/x.json',
            valid: true,
          },
        ],
      });
    const { app } = createApp(service);
    const res = await app.request(post('/init', {}));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.data.outcome).toBe('created');
    expect(body.data.initialized).toBe(true);
    expect(service.ensureLayout).toHaveBeenCalledWith('/ws');
  });

  test('POST /init is idempotent — reports already-initialized', async () => {
    const service = createMockFlowRunService();
    // detectWorkspace defaults to initialized:true for both calls.
    const { app } = createApp(service);
    const res = await app.request(post('/init', {}));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.outcome).toBe('already-initialized');
    expect(service.ensureLayout).toHaveBeenCalledWith('/ws');
  });

  test('GET /runs lists runs for the project workspace', async () => {
    const { app, service } = createApp();
    const body = await json(await app.request('/runs'));
    expect(body.success).toBe(true);
    expect(body.data[0].run_id).toBe('run-1');
    expect(service.listRunsWithDiagnostics).toHaveBeenCalledWith('/ws');
  });

  /**
   * Flow drops a run directory it cannot inspect, so without this the response
   * is a shorter list that looks complete. The diagnostics ride alongside the
   * unchanged `data` array rather than replacing it (#290 review, M4).
   */
  test('GET /runs names the run directories it could not read', async () => {
    const { app } = createApp();
    const body = await json(await app.request('/runs'));
    expect(body.diagnostics).toEqual([
      {
        code: 'flow.run_location.no_complete_candidate',
        severity: 'warning',
        run_id: 'broken',
        message: 'canonical run directory is incomplete',
      },
    ]);
  });

  test('POST /runs starts a run', async () => {
    const { app, service } = createApp();
    const res = await app.request(
      post('/runs', {
        definition: 'test-flow',
        runId: 'run-1',
        params: { subject: 'demo' },
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.data.runId).toBe('run-1');
    expect(service.startRun).toHaveBeenCalledWith('/ws', {
      definition: 'test-flow',
      runId: 'run-1',
      params: { subject: 'demo' },
    });
  });

  test('POST /runs refuses the retired station-delivery definition', async () => {
    const { app, service } = createApp();
    const res = await app.request(
      post('/runs', { definition: 'station-delivery', runId: 'run-1' }),
    );
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({
      success: false,
      code: 'flow.definition.retired',
      definition: 'station-delivery',
    });
    expect(service.startRun).not.toHaveBeenCalled();
  });

  test('POST /runs rejects an invalid body', async () => {
    const { app, service } = createApp();
    const res = await app.request(post('/runs', { runId: 'run-1' }));
    expect(res.status).toBe(400);
    expect(service.startRun).not.toHaveBeenCalled();
  });

  test('POST /runs rejects an unsafe runId', async () => {
    const { app, service } = createApp();
    const res = await app.request(
      post('/runs', { definition: 'test-flow', runId: '../escape' }),
    );
    expect(res.status).toBe(400);
    expect(service.startRun).not.toHaveBeenCalled();
  });

  test('GET /runs/:runId returns run status with open gates', async () => {
    const { app } = createApp();
    const body = await json(await app.request('/runs/run-1'));
    expect(body.success).toBe(true);
    expect(body.data.openGates[0].id).toBe('build-gate');
  });

  test('GET /runs/:runId maps not-found errors to 404', async () => {
    const service = createMockFlowRunService();
    service.getRun.mockRejectedValue(
      new FlowRunNotFoundError('Flow run not found: missing'),
    );
    const { app } = createApp(service);
    const res = await app.request('/runs/missing');
    expect(res.status).toBe(404);
  });

  test('GET /runs/:runId/console returns the console projection', async () => {
    const { app, service } = createApp();
    const body = await json(await app.request('/runs/run-1/console'));
    expect(body.success).toBe(true);
    expect(body.data.run.run_id).toBe('run-1');
    expect(body.data.open_gates).toEqual(['build-gate']);
    expect(body.data.gates[0].missing).toEqual(['tests-passed']);
    expect(service.getRunConsole).toHaveBeenCalledWith('/ws', 'run-1');
  });

  test('GET /runs/:runId/console maps not-found errors to 404', async () => {
    const service = createMockFlowRunService();
    service.getRunConsole.mockRejectedValue(
      new FlowRunNotFoundError('Flow run not found: missing'),
    );
    const { app } = createApp(service);
    const res = await app.request('/runs/missing/console');
    expect(res.status).toBe(404);
  });

  test('POST /runs/:runId/evidence attaches evidence', async () => {
    const { app, service } = createApp();
    const res = await app.request(
      post('/runs/run-1/evidence', {
        gate: 'build-gate',
        file: 'evidence/readiness.json',
        kind: 'veritas-readiness',
        supersede: 'ev.0',
      }),
    );
    expect(res.status).toBe(201);
    expect(service.attachEvidence).toHaveBeenCalledWith('/ws', 'run-1', {
      gate: 'build-gate',
      file: 'evidence/readiness.json',
      kind: 'veritas-readiness',
      supersede: 'ev.0',
    });
  });

  test('POST /runs/:runId/evidence maps invalid errors to 400', async () => {
    const service = createMockFlowRunService();
    service.attachEvidence.mockRejectedValue(
      new FlowRunInvalidError('unknown gate: nope-gate'),
    );
    const { app } = createApp(service);
    const res = await app.request(
      post('/runs/run-1/evidence', { gate: 'nope-gate', file: 'f.json' }),
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('unknown gate');
  });

  test('POST /runs/:runId/evidence/command runs the helper and returns the result', async () => {
    const { app, service } = createApp();
    const res = await app.request(
      post('/runs/run-1/evidence/command', {
        gate: 'build-gate',
        command: 'npm run verify:static',
        claimType: 'quality.static-checks',
        producer: 'station/verify-static',
        label: 'verify:static',
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.data).toMatchObject({
      entry: { id: 'ev.2', kind: 'trust.bundle' },
      exitCode: 0,
      timedOut: false,
      outputTail: ['all green'],
    });
    expect(service.attachCommandEvidence).toHaveBeenCalledWith('/ws', 'run-1', {
      gate: 'build-gate',
      command: 'npm run verify:static',
      claimType: 'quality.static-checks',
      producer: 'station/verify-static',
      label: 'verify:static',
    });
  });

  test('POST /runs/:runId/evidence/command rejects a body without a command', async () => {
    const { app, service } = createApp();
    const res = await app.request(
      post('/runs/run-1/evidence/command', {
        gate: 'build-gate',
        claimType: 'quality.static-checks',
      }),
    );
    expect(res.status).toBe(400);
    expect(service.attachCommandEvidence).not.toHaveBeenCalled();
  });

  test('POST /runs/:runId/evidence/command maps unknown-gate errors to 400', async () => {
    const service = createMockFlowRunService();
    service.attachCommandEvidence.mockRejectedValue(
      new FlowRunInvalidError('unknown gate: nope-gate'),
    );
    const { app } = createApp(service);
    const res = await app.request(
      post('/runs/run-1/evidence/command', {
        gate: 'nope-gate',
        command: 'npm test',
        claimType: 'quality.tests',
      }),
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('unknown gate');
  });

  test('POST /runs/:runId/evidence/command maps unknown-run errors to 404', async () => {
    const service = createMockFlowRunService();
    service.attachCommandEvidence.mockRejectedValue(
      new FlowRunNotFoundError('Flow run not found: missing'),
    );
    const { app } = createApp(service);
    const res = await app.request(
      post('/runs/missing/evidence/command', {
        gate: 'build-gate',
        command: 'npm test',
        claimType: 'quality.tests',
      }),
    );
    expect(res.status).toBe(404);
  });

  test('POST /runs/:runId/evidence/readiness runs the bridge and returns the entry', async () => {
    const bridge = createMockReadinessBridge();
    const { app } = createApp(createMockFlowRunService(), '/ws', bridge);
    const res = await app.request(
      post('/runs/run-1/evidence/readiness', { gate: 'readiness-gate' }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.data).toMatchObject({
      attached: true,
      gateId: 'readiness-gate',
      entry: { id: 'ev.1', kind: 'trust.bundle' },
      readiness: {
        overall: 'ready',
        runId: 'veritas-123',
        reportArtifactPath: '.kontourai/veritas/evidence/veritas-123.json',
      },
    });
    expect(bridge.attachReadinessEvidence).toHaveBeenCalledWith(
      '/ws',
      'run-1',
      { gate: 'readiness-gate', refresh: undefined },
    );
  });

  test('POST /runs/:runId/evidence/readiness returns 501 without a bridge', async () => {
    const { app } = createApp();
    const res = await app.request(post('/runs/run-1/evidence/readiness', {}));
    expect(res.status).toBe(501);
  });

  test('POST /runs/:runId/evidence/readiness maps not-configured to 409', async () => {
    const bridge = createMockReadinessBridge();
    bridge.attachReadinessEvidence.mockRejectedValue(
      new VeritasNotConfiguredError(
        'Workspace has no .veritas directory',
        'no-veritas-dir',
      ),
    );
    const { app } = createApp(createMockFlowRunService(), '/ws', bridge);
    const res = await app.request(post('/runs/run-1/evidence/readiness', {}));
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.reason).toBe('no-veritas-dir');
  });

  test('POST /runs/:runId/evidence/readiness maps CLI failures to 502', async () => {
    const bridge = createMockReadinessBridge();
    bridge.attachReadinessEvidence.mockRejectedValue(
      new VeritasCliError('veritas readiness exited with code 2', 2, 'boom'),
    );
    const { app } = createApp(createMockFlowRunService(), '/ws', bridge);
    const res = await app.request(post('/runs/run-1/evidence/readiness', {}));
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.exitCode).toBe(2);
  });

  test('POST /runs/:runId/evidence/readiness maps unknown-gate errors to 400', async () => {
    const bridge = createMockReadinessBridge();
    bridge.attachReadinessEvidence.mockRejectedValue(
      new FlowRunInvalidError('unknown gate: nope-gate'),
    );
    const { app } = createApp(createMockFlowRunService(), '/ws', bridge);
    const res = await app.request(
      post('/runs/run-1/evidence/readiness', { gate: 'nope-gate' }),
    );
    expect(res.status).toBe(400);
  });

  test('POST /runs/:runId/evaluate returns outcomes with route-back info', async () => {
    const { app, service } = createApp();
    const res = await app.request(
      post('/runs/run-1/evaluate', { gate: 'build-gate' }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.outcomes[0]).toMatchObject({
      status: 'route-back',
      route_back_to: 'build',
      attempt: 1,
    });
    expect(service.evaluate).toHaveBeenCalledWith('/ws', 'run-1', 'build-gate');
  });

  test('POST /runs/:runId/evaluate evaluates all gates when no gate given', async () => {
    const { app, service } = createApp();
    await app.request(post('/runs/run-1/evaluate', {}));
    expect(service.evaluate).toHaveBeenCalledWith('/ws', 'run-1', undefined);
  });

  test('POST /runs/:runId/exception accepts an exception', async () => {
    const { app, service } = createApp();
    const res = await app.request(
      post('/runs/run-1/exception', {
        gate: 'build-gate',
        reason: 'flaky',
        authority: 'lead',
      }),
    );
    expect(res.status).toBe(201);
    expect(service.acceptException).toHaveBeenCalledWith('/ws', 'run-1', {
      gate: 'build-gate',
      reason: 'flaky',
      authority: 'lead',
    });
  });

  test('POST /runs/:runId/exception rejects missing authority', async () => {
    const { app, service } = createApp();
    const res = await app.request(
      post('/runs/run-1/exception', { gate: 'build-gate', reason: 'flaky' }),
    );
    expect(res.status).toBe(400);
    expect(service.acceptException).not.toHaveBeenCalled();
  });

  test('GET /runs/:runId/report returns the json report by default', async () => {
    const { app, service } = createApp();
    const body = await json(await app.request('/runs/run-1/report'));
    expect(body.success).toBe(true);
    expect(body.data.run_id).toBe('run-1');
    expect(service.getReport).toHaveBeenCalledWith('/ws', 'run-1', 'json');
  });

  test('GET /runs/:runId/report returns markdown as text', async () => {
    const service = createMockFlowRunService();
    service.getReport.mockResolvedValue('# Flow Run run-1');
    const { app } = createApp(service);
    const res = await app.request('/runs/run-1/report?format=markdown');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('# Flow Run run-1');
    expect(service.getReport).toHaveBeenCalledWith('/ws', 'run-1', 'markdown');
  });

  test('GET /runs/:runId/report rejects unknown formats', async () => {
    const { app, service } = createApp();
    const res = await app.request('/runs/run-1/report?format=pdf');
    expect(res.status).toBe(400);
    expect(service.getReport).not.toHaveBeenCalled();
  });
});
