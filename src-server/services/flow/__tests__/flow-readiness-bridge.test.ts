import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildSyntheticTrustBundle } from '../../evidence/trust-bundle.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  flowEvidenceAttached: { add: vi.fn() },
  flowEvidenceAutoSuperseded: { add: vi.fn() },
  flowExceptionsAccepted: { add: vi.fn() },
  flowGateEvaluations: { add: vi.fn() },
  flowReportsGenerated: { add: vi.fn() },
  flowRunsStarted: { add: vi.fn() },
  veritasReadinessDuration: { record: vi.fn() },
  veritasReadinessRuns: { add: vi.fn() },
}));

const { FlowReadinessBridge, READINESS_CLAIM_TYPE } = await import(
  '../flow-readiness-bridge.js'
);
const { FlowRunService, FlowRunInvalidError } = await import(
  '../flow-run-service.js'
);
const { VeritasReadinessService, VeritasNotConfiguredError } = await import(
  '../../evidence/veritas-readiness-service.js'
);

// ── Flow fixtures (delivery-shaped: gated implement step, then readiness) ──

const DELIVERY_DEFINITION = {
  id: 'delivery',
  version: '1',
  steps: [
    { id: 'implement', next: 'readiness' },
    { id: 'readiness', next: null },
  ],
  gates: {
    'implement-gate': {
      step: 'implement',
      expects: [
        {
          id: 'static-gates-green',
          kind: 'trust.bundle',
          required: true,
          description: 'Static checks pass.',
          bundle_claim: {
            claimType: 'quality.static-checks',
            accepted_statuses: ['assumed'],
          },
        },
      ],
    },
    'readiness-gate': {
      step: 'readiness',
      expects: [
        {
          id: 'merge-readiness',
          kind: 'trust.bundle',
          required: true,
          description: 'Veritas merge readiness for the working tree.',
          bundle_claim: {
            claimType: 'governance.merge-readiness',
            accepted_statuses: ['assumed'],
          },
        },
      ],
      on_route_back: {
        missing_evidence: 'readiness',
        default: 'readiness',
      },
      route_back_policy: { max_attempts: 2, on_exceeded: 'block' },
    },
  },
};

/** Definition without any readiness-type expectation (gate resolution miss). */
const NO_READINESS_DEFINITION = {
  id: 'no-readiness',
  version: '1',
  steps: [{ id: 'implement', next: null }],
  gates: {
    'implement-gate': DELIVERY_DEFINITION.gates['implement-gate'],
  },
};

// ── Veritas fixtures (trimmed from real @kontourai/veritas@1.5.0 output) ──

function cliStdout(overrides: Record<string, unknown> = {}): string {
  const json = {
    mode: 'report-and-draft',
    evidenceCheckLabels: ['npm test'],
    evidenceCheckRan: true,
    evidenceCheckFailure: null,
    reportArtifactPath: '.kontourai/veritas/evidence/veritas-123.json',
    reportRunId: 'veritas-123',
    reportSourceKind: 'working-tree',
    message: 'Evidence Check, report, and standards feedback draft completed.',
    ...overrides,
  };
  return `\n> fixture@1.0.0 test\n> exit 0\n\n${JSON.stringify(json, null, 2)}\n`;
}

/** Real-shaped evidence record: nested trust.bundle whose claims carry
 * `claimType` (not `type`) — the exact shape Flow's trustArtifact path
 * rejects and the bridge's claimType assertion must carry instead. */
function evidenceRecord() {
  return {
    record_schema_version: 1,
    run_id: 'veritas-123',
    governance_state: { state: 'current' },
    selected_evidence_checks: [
      {
        id: 'required-evidence-check',
        label: 'npm test',
        summary: 'Evidence checks passed',
        evidence_check_result: { passed: true, exitCode: 0 },
      },
    ],
    policy_results: [],
    recommendations: [],
    override_or_bypass: false,
    trust: {
      bundle: {
        schemaVersion: 5,
        source: 'veritas:veritas-123',
        claims: [
          {
            id: 'fx.evidence-check.npm-test',
            subjectType: 'software-change',
            subjectId: 'fx:working-tree',
            facet: 'veritas.evidence-check',
            claimType: 'software-evidence-check',
            fieldOrBehavior: 'npm test',
            value: 'passed',
            createdAt: '2026-06-12T00:00:00.000Z',
            updatedAt: '2026-06-12T00:00:00.000Z',
          },
        ],
        evidence: [],
        policies: [],
        events: [],
      },
    },
  };
}

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createWorkspace(
  options: { definition?: Record<string, unknown>; veritas?: boolean } = {},
): string {
  const cwd = mkdtempSync(join(tmpdir(), 'flow-readiness-bridge-'));
  cleanupDirs.push(cwd);
  const definition = options.definition ?? DELIVERY_DEFINITION;
  const definitionsDir = join(cwd, '.flow', 'definitions');
  mkdirSync(definitionsDir, { recursive: true });
  writeFileSync(
    join(definitionsDir, `${definition.id}.json`),
    JSON.stringify(definition, null, 2),
  );
  if (options.veritas !== false) {
    mkdirSync(join(cwd, '.veritas'), { recursive: true });
    mkdirSync(join(cwd, '.kontourai', 'veritas', 'evidence'), {
      recursive: true,
    });
    writeFileSync(
      join(cwd, '.kontourai', 'veritas', 'evidence', 'veritas-123.json'),
      JSON.stringify(evidenceRecord(), null, 2),
    );
    const binDir = join(cwd, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const binName = process.platform === 'win32' ? 'veritas.cmd' : 'veritas';
    writeFileSync(join(binDir, binName), '#!/bin/sh\nexit 0\n');
  }
  return cwd;
}

function createBridge(cli: { stdout: string; exitCode?: number }) {
  const flowRunService = new FlowRunService();
  const runCli = vi.fn(async () => ({
    stdout: cli.stdout,
    stderr: '',
    exitCode: cli.exitCode ?? 0,
  }));
  const readinessService = new VeritasReadinessService({ runCli });
  const bridge = new FlowReadinessBridge({ flowRunService, readinessService });
  return { bridge, flowRunService, runCli };
}

function writeStaticEvidence(cwd: string): string {
  // Mirror production: static-check evidence is a synthetic trust.bundle
  // carrying the quality.static-checks claim at `assumed` (the implement
  // gate's accepted status), not a bare legacy claim file.
  writeFileSync(
    join(cwd, 'static-bundle.json'),
    JSON.stringify(
      buildSyntheticTrustBundle({
        claimType: 'quality.static-checks',
        subjectId: 'r1',
        value: 'pass',
      }),
    ),
  );
  return 'static-bundle.json';
}

describe('FlowReadinessBridge.attachReadinessEvidence', () => {
  test('attaches the record as a trusted governance.merge-readiness claim and the gate passes', async () => {
    const cwd = createWorkspace();
    const { bridge, flowRunService, runCli } = createBridge({
      stdout: cliStdout(),
    });
    await flowRunService.startRun(cwd, { definition: 'delivery', runId: 'r1' });

    const result = await bridge.attachReadinessEvidence(cwd, 'r1');

    expect(runCli).toHaveBeenCalledTimes(1);
    expect(result.attached).toBe(true);
    if (!result.attached) throw new Error('expected attached outcome');
    expect(result.gateId).toBe('readiness-gate');
    expect(result.entry).toMatchObject({
      gate_id: 'readiness-gate',
      kind: 'trust.bundle',
      producer: 'veritas',
      expectation_ids: ['merge-readiness'],
    });
    // The synthetic readiness bundle carries the merge-readiness claim at
    // `assumed` (trust model downgrades unbacked `verified`); the Veritas
    // record path is preserved on the claim for audit traceability.
    expect(result.entry.bundle?.claims?.[0]).toMatchObject({
      claimType: READINESS_CLAIM_TYPE,
      status: 'assumed',
      value: 'ready',
      fieldOrBehavior: '.kontourai/veritas/evidence/veritas-123.json',
    });
    expect(result.snapshot.overall).toBe('ready');

    // Drive the run to completion: implement-gate first, then readiness-gate.
    await flowRunService.attachEvidence(cwd, 'r1', {
      gate: 'implement-gate',
      file: writeStaticEvidence(cwd),
      kind: 'trust.bundle',
    });
    const first = await flowRunService.evaluate(cwd, 'r1');
    expect(first.outcomes[0].status).toBe('pass');
    const second = await flowRunService.evaluate(cwd, 'r1');
    expect(second.outcomes[0]).toMatchObject({
      gate_id: 'readiness-gate',
      status: 'pass',
    });
    expect(second.state.status).toBe('completed');
  });

  test('honors an explicit gate option', async () => {
    const cwd = createWorkspace();
    const { bridge, flowRunService } = createBridge({ stdout: cliStdout() });
    await flowRunService.startRun(cwd, { definition: 'delivery', runId: 'r1' });

    const result = await bridge.attachReadinessEvidence(cwd, 'r1', {
      gate: 'implement-gate',
    });
    expect(result.attached).toBe(true);
    if (!result.attached) throw new Error('expected attached outcome');
    expect(result.gateId).toBe('implement-gate');
    // No readiness-type expectation on that gate -> no expectation ids.
    expect(result.entry.expectation_ids).toBeUndefined();
  });

  test('supersedes prior readiness evidence on re-attach (route-back recovery)', async () => {
    const cwd = createWorkspace();
    const { bridge, flowRunService } = createBridge({ stdout: cliStdout() });
    await flowRunService.startRun(cwd, { definition: 'delivery', runId: 'r1' });

    const first = await bridge.attachReadinessEvidence(cwd, 'r1');
    const second = await bridge.attachReadinessEvidence(cwd, 'r1');
    if (!first.attached || !second.attached) {
      throw new Error('expected attached outcomes');
    }

    const run = await flowRunService.getRun(cwd, 'r1');
    const entries = run.manifest.evidence.filter(
      (entry) => entry.gate_id === 'readiness-gate',
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(first.entry.id);
    expect(entries[0].superseded_by).toBe(second.entry.id);
    expect(entries[1].superseded_by).toBeUndefined();
  });

  test('attaches a not-ready run as failed evidence that routes back', async () => {
    const cwd = createWorkspace();
    const { bridge, flowRunService } = createBridge({
      stdout: cliStdout({
        evidenceCheckFailure: { label: 'npm test', exitCode: 1 },
      }),
      exitCode: 1,
    });
    await flowRunService.startRun(cwd, { definition: 'delivery', runId: 'r1' });

    const result = await bridge.attachReadinessEvidence(cwd, 'r1');
    expect(result.attached).toBe(true);
    if (!result.attached) throw new Error('expected attached outcome');
    expect(result.snapshot.overall).toBe('not-ready');
    expect(result.entry).toMatchObject({
      gate_id: 'readiness-gate',
      status: 'failed',
      route_reason: 'missing_evidence',
    });
    // Entry-level `failed` drives route-back; the bundle claim records the
    // not-ready value (status stays `assumed` — synthetic, no backing).
    expect(result.entry.bundle?.claims?.[0]).toMatchObject({
      claimType: READINESS_CLAIM_TYPE,
      value: 'not-ready',
    });

    const outcome = await flowRunService.evaluate(cwd, 'r1', 'readiness-gate');
    expect(outcome.outcomes[0]).toMatchObject({
      gate_id: 'readiness-gate',
      status: 'route-back',
      route_back_to: 'readiness',
    });
  });

  test('onlyWhenReady skips attaching when readiness is not-ready', async () => {
    const cwd = createWorkspace();
    const { bridge, flowRunService } = createBridge({
      stdout: cliStdout(),
      exitCode: 1,
    });
    await flowRunService.startRun(cwd, { definition: 'delivery', runId: 'r1' });

    const result = await bridge.attachReadinessEvidence(cwd, 'r1', {
      onlyWhenReady: true,
    });
    expect(result).toMatchObject({ attached: false, reason: 'not-ready' });

    const run = await flowRunService.getRun(cwd, 'r1');
    expect(run.manifest.evidence).toEqual([]);
  });

  test('throws invalid when no gate expects the readiness claim type', async () => {
    const cwd = createWorkspace({ definition: NO_READINESS_DEFINITION });
    const { bridge, flowRunService } = createBridge({ stdout: cliStdout() });
    await flowRunService.startRun(cwd, {
      definition: 'no-readiness',
      runId: 'r1',
    });

    await expect(bridge.attachReadinessEvidence(cwd, 'r1')).rejects.toThrow(
      FlowRunInvalidError,
    );
  });

  test('propagates not-configured for workspaces without Veritas', async () => {
    const cwd = createWorkspace({ veritas: false });
    const { bridge, flowRunService } = createBridge({ stdout: cliStdout() });
    await flowRunService.startRun(cwd, { definition: 'delivery', runId: 'r1' });

    await expect(
      bridge.attachReadinessEvidence(cwd, 'r1'),
    ).rejects.toBeInstanceOf(VeritasNotConfiguredError);
    expect(bridge.detectWorkspace(cwd).configured).toBe(false);
  });
});
