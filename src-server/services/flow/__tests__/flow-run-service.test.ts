import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachEvidence } from '@kontourai/flow';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildSyntheticTrustBundle } from '../../evidence/trust-bundle.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  flowRunsStarted: { add: vi.fn() },
  flowEvidenceAttached: { add: vi.fn() },
  flowEvidenceAutoSuperseded: { add: vi.fn() },
  flowGateEvaluations: { add: vi.fn() },
  flowRunLocationDiagnostics: { add: vi.fn() },
  flowExceptionsAccepted: { add: vi.fn() },
  flowReportsGenerated: { add: vi.fn() },
  flowRunConsoleProjections: { add: vi.fn() },
}));

const {
  FLOW_RUN_LOCATION_ALLOCATION_COLLISION,
  FLOW_RUN_LOCATION_NO_COMPLETE_CANDIDATE,
  FLOW_RUN_LOCATION_NOT_FOUND,
  FlowRunService,
  FlowRunInvalidError,
  FlowRunNotFoundError,
  commandOutcomePassed,
} = await import('../flow-run-service.js');

/** Minimal valid Flow Definition: two steps, one gated with route-back. */
const TEST_DEFINITION = {
  id: 'test-flow',
  version: '1',
  steps: [
    { id: 'build', next: 'verify' },
    { id: 'verify', next: null },
  ],
  gates: {
    'build-gate': {
      step: 'build',
      expects: [
        {
          id: 'tests-passed',
          kind: 'trust.bundle',
          required: true,
          description: 'Tests pass for the change.',
          bundle_claim: {
            claimType: 'quality.tests',
            accepted_statuses: ['assumed'],
          },
        },
      ],
      on_route_back: {
        implementation_defect: 'build',
        missing_evidence: 'build',
        default: 'build',
      },
      route_back_policy: { max_attempts: 2, on_exceeded: 'block' },
    },
    'verify-gate': {
      step: 'verify',
      expects: [
        {
          id: 'verified',
          kind: 'trust.bundle',
          required: true,
          description: 'Verification completed.',
          bundle_claim: {
            claimType: 'quality.verified',
            accepted_statuses: ['assumed'],
          },
        },
      ],
    },
  },
};

describe('FlowRunService', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createWorkspace(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'station-flow-run-'));
    tempDirs.push(cwd);
    const definitionsDir = join(cwd, '.flow', 'definitions');
    mkdirSync(definitionsDir, { recursive: true });
    writeFileSync(
      join(definitionsDir, 'test-flow.json'),
      JSON.stringify(TEST_DEFINITION, null, 2),
    );
    return cwd;
  }

  function writeEvidenceFile(cwd: string, name: string, value: unknown) {
    const file = join(cwd, name);
    writeFileSync(file, JSON.stringify(value, null, 2));
    return name;
  }

  function passingEvidence(cwd: string, name = 'tests.json') {
    return writeEvidenceFile(cwd, name, {
      tests: 'all green',
    });
  }

  /**
   * Flow gate evidence is a Hachure TrustBundle, not a legacy claim record.
   * Write a schema-valid synthetic bundle asserting `claimType` at status
   * `assumed` (the trust-model-honoring status Station mints) and attach it
   * with `kind: 'trust.bundle'`. `value: 'fail'` mints a not-pass claim for
   * route-back cases (paired with entry `status: 'failed'`).
   */
  function bundleEvidence(
    cwd: string,
    claimType: string,
    name = 'bundle.json',
    value: 'pass' | 'fail' = 'pass',
  ) {
    const bundle =
      claimType === 'governance.merge-readiness'
        ? readinessBundle('veritas')
        : buildSyntheticTrustBundle({ claimType, subjectId: 'run-1', value });
    return writeEvidenceFile(cwd, name, bundle);
  }

  function readinessBundle(
    producerId: string,
    authorityRef = 'authority:readiness',
  ) {
    const now = '2026-08-25T00:00:00.000Z';
    return {
      schemaVersion: 7,
      source: 'fixture',
      producerId,
      claims: [
        {
          id: 'claim.readiness',
          subjectType: 'change',
          subjectId: 'r1',
          facet: 'governance',
          claimType: 'governance.merge-readiness',
          fieldOrBehavior: 'readiness',
          value: 'pass',
          createdAt: now,
          updatedAt: now,
        },
      ],
      evidence: [],
      policies: [],
      events: [
        {
          id: 'event.readiness',
          claimId: 'claim.readiness',
          status: 'verified',
          actor: 'veritas',
          method: 'review',
          evidenceIds: [],
          createdAt: now,
          verifiedAt: now,
        },
      ],
      authorityTrace: [
        {
          id: 'trace.readiness',
          subject: { subjectType: 'change', subjectId: 'r1' },
          actorRef: 'veritas',
          authorityType: 'system',
          authorityRef,
          sourceRef: 'policy:readiness',
          observedAt: now,
          claimIds: ['claim.readiness'],
        },
      ],
    };
  }

  describe('detectWorkspace', () => {
    test('reports uninitialized workspace without .flow/definitions', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'station-flow-empty-'));
      tempDirs.push(cwd);
      const status = await new FlowRunService().detectWorkspace(cwd);
      expect(status.initialized).toBe(false);
      expect(status.definitions).toEqual([]);
    });

    test('lists definitions with validity', async () => {
      const cwd = createWorkspace();
      writeFileSync(
        join(cwd, '.flow', 'definitions', 'broken.json'),
        '{"id":"broken"}',
      );
      const status = await new FlowRunService().detectWorkspace(cwd);
      expect(status.initialized).toBe(true);
      const byId = Object.fromEntries(status.definitions.map((d) => [d.id, d]));
      expect(byId['test-flow'].valid).toBe(true);
      expect(byId['test-flow'].version).toBe('1');
      expect(byId.broken.valid).toBe(false);
    });
  });

  describe('startRun', () => {
    test('starts a run from a definition id', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      const result = await svc.startRun(cwd, {
        definition: 'test-flow',
        runId: 'run-1',
        params: { subject: 'demo-change' },
      });
      expect(result.runId).toBe('run-1');
      expect(result.state.definition_id).toBe('test-flow');
      expect(result.state.current_step).toBe('build');
      expect(result.state.subject).toBe('demo-change');
      expect(result.dir).toBe(join(cwd, '.kontourai', 'flow', 'runs', 'run-1'));
      expect(
        existsSync(
          join(cwd, '.kontourai', 'flow', 'runs', 'run-1', 'state.json'),
        ),
      ).toBe(true);
    });

    test('starts a run from a workspace-relative path', async () => {
      const cwd = createWorkspace();
      const result = await new FlowRunService().startRun(cwd, {
        definition: '.flow/definitions/test-flow.json',
        runId: 'run-path',
      });
      expect(result.state.definition_id).toBe('test-flow');
    });

    test('throws not-found for unknown definition', async () => {
      const cwd = createWorkspace();
      await expect(
        new FlowRunService().startRun(cwd, { definition: 'nope' }),
      ).rejects.toBeInstanceOf(FlowRunNotFoundError);
    });

    test('throws invalid for duplicate run id', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'dup' });
      await expect(
        svc.startRun(cwd, { definition: 'test-flow', runId: 'dup' }),
      ).rejects.toBeInstanceOf(FlowRunInvalidError);
    });

    test('discardRun removes the canonical run directory', async () => {
      const cwd = createWorkspace();
      const runId = 'rollback-run';
      const canonical = join(cwd, '.kontourai', 'flow', 'runs', runId);
      mkdirSync(canonical, { recursive: true });
      writeFileSync(join(canonical, 'state.json'), '{}');

      await new FlowRunService().discardRun(cwd, runId);

      expect(existsSync(canonical)).toBe(false);
    });

    /**
     * archive#290 forbids a legacy fallback, dual read, or dual write for generated
     * run state: a run present only under `.flow/runs` must not be discovered.
     * The pre-Flow-3 service mirrored every mutation into `.flow/runs` and
     * fell back to reading it, so this is the pinned proof that both halves
     * are gone — not merely unused.
     */
    test('a run present only under the legacy .flow/runs is not discovered', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'canonical' });

      /*
       * Build the legacy fixture WITH FLOW, then move it. A hand-written
       * `state.json` is not a fixture this test can draw a conclusion from:
       * Flow only resolves a run whose directory holds a valid
       * `definition.json`, a consistent `state.json`, AND an identity-checked
       * evidence manifest, so a partial directory is classified `incomplete`
       * and rejected on its own merits — the assertion below would pass
       * whether or not a legacy read existed. Relocating a run Flow actually
       * produced yields the only fixture a reintroduced legacy read could
       * successfully resolve, and it cannot drift from Flow's format.
       */
      await svc.startRun(cwd, {
        definition: 'test-flow',
        runId: 'legacy-only',
      });
      mkdirSync(join(cwd, '.flow', 'runs'), { recursive: true });
      renameSync(
        join(cwd, '.kontourai', 'flow', 'runs', 'legacy-only'),
        join(cwd, '.flow', 'runs', 'legacy-only'),
      );

      /*
       * The CODE is the load-bearing assertion, not the error class.
       * `FlowRunNotFoundError` is also what an `incomplete` candidate raises,
       * so `instanceof` alone cannot tell "Station never looked at
       * `.flow/runs`" apart from "Station looked and disliked what it found".
       * `FLOW_RUN_LOCATION_NOT_FOUND` means the canonical location is ABSENT.
       */
      await expect(svc.getRun(cwd, 'legacy-only')).rejects.toMatchObject({
        name: 'FlowRunNotFoundError',
        code: FLOW_RUN_LOCATION_NOT_FOUND,
      });
      expect((await svc.listRuns(cwd)).map((run) => run.run_id)).toEqual([
        'canonical',
      ]);
      // The relocated run is intact where we put it: this test failed for the
      // right reason (not discovered), not because the fixture was broken.
      expect(
        existsSync(join(cwd, '.flow', 'runs', 'legacy-only', 'state.json')),
      ).toBe(true);
      expect(
        existsSync(
          join(cwd, '.flow', 'runs', 'legacy-only', 'definition.json'),
        ),
      ).toBe(true);
    });

    test('startRun never writes generated state under .flow/runs', async () => {
      const cwd = createWorkspace();
      await new FlowRunService().startRun(cwd, {
        definition: 'test-flow',
        runId: 'no-mirror',
      });
      expect(existsSync(join(cwd, '.flow', 'runs'))).toBe(false);
    });
  });

  describe('getRun / listRuns', () => {
    test('returns definition, state, manifest, and open gates', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const run = await svc.getRun(cwd, 'run-1');
      expect(run.dir).toBe(join(cwd, '.kontourai', 'flow', 'runs', 'run-1'));
      expect(run.definition.id).toBe('test-flow');
      expect(run.state.run_id).toBe('run-1');
      expect(run.manifest.evidence).toEqual([]);
      expect(run.openGates.map((g) => g.id)).toEqual(['build-gate']);
    });

    test('getRun throws not-found for unknown run', async () => {
      const cwd = createWorkspace();
      await expect(
        new FlowRunService().getRun(cwd, 'missing'),
      ).rejects.toBeInstanceOf(FlowRunNotFoundError);
    });

    test('listRuns returns run summaries', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-a' });
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-b' });
      const runs = await svc.listRuns(cwd);
      expect(runs.map((r) => r.run_id).sort()).toEqual(['run-a', 'run-b']);
      expect(runs[0].status).toBe('active');
    });

    test('listRuns returns empty array without a runs directory', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'station-flow-noruns-'));
      tempDirs.push(cwd);
      expect(await new FlowRunService().listRuns(cwd)).toEqual([]);
    });
  });

  describe('getRunConsole', () => {
    test('projects run identity, gates with expectations, and open gates', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const console_ = await svc.getRunConsole(cwd, 'run-1');
      expect(console_.run.run_id).toBe('run-1');
      expect(console_.run.definition_id).toBe('test-flow');
      expect(console_.current_step).toBe('build');
      expect(console_.open_gates).toContain('build-gate');
      const buildGate = console_.gates.find((gate) => gate.id === 'build-gate');
      expect(buildGate).toBeTruthy();
      expect(buildGate?.is_open).toBe(true);
      expect(
        buildGate?.expectations.map((expectation) => expectation.id),
      ).toEqual(['tests-passed']);
    });

    test('reflects attached evidence, gate outcomes, and the report path', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      await svc.attachEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        file: bundleEvidence(cwd, 'quality.tests'),
        kind: 'trust.bundle',
      });
      await svc.evaluate(cwd, 'run-1', 'build-gate');
      await svc.getReport(cwd, 'run-1', 'json');

      const console_ = await svc.getRunConsole(cwd, 'run-1');
      expect(console_.evidence).toHaveLength(1);
      expect(console_.evidence[0].gate_id).toBe('build-gate');
      expect(console_.evidence[0].kind).toBe('trust.bundle');
      // The console projection keeps the full entry under `raw`; the bundle's
      // claim is the projected evidence content under the trust.bundle model.
      const rawBundle = (
        console_.evidence[0].raw as {
          bundle?: { claims?: Array<{ claimType?: string }> };
        }
      ).bundle;
      expect(rawBundle?.claims?.[0]).toMatchObject({
        claimType: 'quality.tests',
      });
      const buildGate = console_.gates.find((gate) => gate.id === 'build-gate');
      expect(buildGate?.status).toBe('pass');
      expect(console_.current_step).toBe('verify');
      expect(console_.report?.path).toContain('report.json');
    });

    test('throws not-found for unknown run', async () => {
      const cwd = createWorkspace();
      await expect(
        new FlowRunService().getRunConsole(cwd, 'missing'),
      ).rejects.toBeInstanceOf(FlowRunNotFoundError);
    });
  });

  describe('attachEvidence', () => {
    test('attaches claim evidence to a gate', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const entry = await svc.attachEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        file: bundleEvidence(cwd, 'quality.tests'),
        kind: 'trust.bundle',
      });
      expect(entry.gate_id).toBe('build-gate');
      expect(entry.kind).toBe('trust.bundle');
      expect(entry.bundle?.claims?.[0]).toMatchObject({
        claimType: 'quality.tests',
        status: 'assumed',
      });
    });

    test('supports veritas-readiness kind', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const entry = await svc.attachEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        file: writeEvidenceFile(cwd, 'readiness.json', { decision: 'ready' }),
        kind: 'veritas-readiness',
      });
      expect(entry.kind).toBe('veritas-readiness');
    });

    test('throws invalid for unknown gate', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      await expect(
        svc.attachEvidence(cwd, 'run-1', {
          gate: 'nope-gate',
          file: passingEvidence(cwd),
        }),
      ).rejects.toBeInstanceOf(FlowRunInvalidError);
    });

    test('throws not-found for missing evidence file', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      await expect(
        svc.attachEvidence(cwd, 'run-1', {
          gate: 'build-gate',
          file: 'does-not-exist.json',
        }),
      ).rejects.toBeInstanceOf(FlowRunNotFoundError);
    });

    test('throws invalid when superseding unknown evidence', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      await expect(
        svc.attachEvidence(cwd, 'run-1', {
          gate: 'build-gate',
          file: passingEvidence(cwd),
          supersede: 'ev.unknown',
        }),
      ).rejects.toBeInstanceOf(FlowRunInvalidError);
    });
  });

  describe('attachCommandEvidence', () => {
    /**
     * Read the command-evidence sidecar JSON. Flow 1.3.x stores the
     * gate-satisfying trust.bundle as the entry's evidence file; the command
     * output/exit metadata is returned separately on `result.evidencePath`.
     */
    function readStoredEvidence(result: { evidencePath?: unknown }) {
      return JSON.parse(readFileSync(String(result.evidencePath), 'utf8'));
    }

    test('passing command attaches a trusted claim and the gate passes', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const result = await svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command: 'node -e "console.log(\'tests green\')"',
        claimType: 'quality.tests',
      });
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.outputTail).toEqual(['tests green']);
      expect(result.entry).toMatchObject({
        gate_id: 'build-gate',
        kind: 'trust.bundle',
        status: 'passed',
        producer: 'station/command',
        expectation_ids: ['tests-passed'],
      });
      // Passing command mints an `assumed` quality.tests claim (value 'pass').
      expect(result.entry.bundle?.claims?.[0]).toMatchObject({
        claimType: 'quality.tests',
        status: 'assumed',
        value: 'pass',
      });
      const stored = readStoredEvidence(result);
      expect(stored).toMatchObject({
        kind: 'station.command-evidence',
        command: 'node -e "console.log(\'tests green\')"',
        exit_code: 0,
        timed_out: false,
        output_truncated: false,
        output_tail: ['tests green'],
      });
      const evaluation = await svc.evaluate(cwd, 'run-1');
      expect(evaluation.outcomes[0]).toMatchObject({
        gate_id: 'build-gate',
        status: 'pass',
      });
      expect(evaluation.state.current_step).toBe('verify');
    });

    test('failing command attaches failed evidence that routes back on evaluate', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const result = await svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command: 'node -e "console.error(\'boom\'); process.exit(3)"',
        claimType: 'quality.tests',
        label: 'unit tests',
      });
      expect(result.exitCode).toBe(3);
      expect(result.outputTail).toEqual(['boom']);
      expect(result.entry).toMatchObject({
        status: 'failed',
        route_reason: 'implementation_defect',
      });
      // Failed command mints a quality.tests claim with value 'fail'; the
      // entry-level `failed` status is what drives route-back.
      expect(result.entry.bundle?.claims?.[0]).toMatchObject({
        claimType: 'quality.tests',
        value: 'fail',
      });
      const stored = readStoredEvidence(result);
      expect(stored).toMatchObject({ label: 'unit tests', exit_code: 3 });
      const evaluation = await svc.evaluate(cwd, 'run-1');
      expect(evaluation.outcomes[0]).toMatchObject({
        gate_id: 'build-gate',
        status: 'route-back',
        route_back_to: 'build',
        route_reason: 'implementation_defect',
      });
      expect(evaluation.state.current_step).toBe('build');
    });

    test('recovers a route-back by superseding the failed command evidence', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const failed = await svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command: 'node -e "process.exit(1)"',
        claimType: 'quality.tests',
      });
      await svc.evaluate(cwd, 'run-1');
      await svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command: 'node -e "process.exit(0)"',
        claimType: 'quality.tests',
        supersede: failed.entry.id,
      });
      const evaluation = await svc.evaluate(cwd, 'run-1');
      expect(evaluation.outcomes[0].status).toBe('pass');
      expect(evaluation.state.current_step).toBe('verify');
    });

    test('auto-supersedes the prior failed entry on retry: fail -> retry pass -> gate passes', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const failed = await svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command: 'node -e "process.exit(1)"',
        claimType: 'quality.tests',
      });
      await svc.evaluate(cwd, 'run-1');
      // Retry without plumbing the failed entry id.
      const retried = await svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command: 'node -e "process.exit(0)"',
        claimType: 'quality.tests',
      });
      const evaluation = await svc.evaluate(cwd, 'run-1');
      expect(evaluation.outcomes[0].status).toBe('pass');
      expect(evaluation.state.current_step).toBe('verify');
      const run = await svc.getRun(cwd, 'run-1');
      const failedEntry = run.manifest.evidence.find(
        (entry) => entry.id === failed.entry.id,
      );
      expect(failedEntry?.superseded_by).toBe(retried.entry.id);
    });

    test('does not auto-supersede failed evidence from a different producer', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const failed = await svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command: 'node -e "process.exit(1)"',
        claimType: 'quality.tests',
      });
      await svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command: 'node -e "process.exit(0)"',
        claimType: 'quality.tests',
        producer: 'station/vitest',
      });
      const run = await svc.getRun(cwd, 'run-1');
      const failedEntry = run.manifest.evidence.find(
        (entry) => entry.id === failed.entry.id,
      );
      expect(failedEntry?.superseded_by).toBeUndefined();
      // The non-superseded failed entry still drives the gate.
      const evaluation = await svc.evaluate(cwd, 'run-1');
      expect(evaluation.outcomes[0].status).toBe('route-back');
    });

    test('an explicit empty supersede list overrides auto-supersede', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const failed = await svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command: 'node -e "process.exit(1)"',
        claimType: 'quality.tests',
      });
      await svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command: 'node -e "process.exit(0)"',
        claimType: 'quality.tests',
        supersede: [],
      });
      const run = await svc.getRun(cwd, 'run-1');
      const failedEntry = run.manifest.evidence.find(
        (entry) => entry.id === failed.entry.id,
      );
      expect(failedEntry?.superseded_by).toBeUndefined();
    });

    test('caps the recorded output to the last 80 lines', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const result = await svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command:
          'node -e "for (let i = 1; i <= 200; i++) console.log(\'line \' + i)"',
        claimType: 'quality.tests',
      });
      expect(result.outputTail).toHaveLength(80);
      expect(result.outputTail[0]).toBe('line 121');
      expect(result.outputTail[79]).toBe('line 200');
      const stored = readStoredEvidence(result);
      expect(stored.output_total_lines).toBe(200);
      expect(stored.output_tail_lines).toBe(80);
      expect(stored.output_truncated).toBe(true);
    });

    test('treats a timeout as a failing command', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const result = await svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command: 'node -e "setTimeout(() => {}, 30000)"',
        claimType: 'quality.tests',
        timeoutMs: 250,
      });
      expect(result.timedOut).toBe(true);
      expect(result.entry).toMatchObject({
        status: 'failed',
        route_reason: 'implementation_defect',
      });
      expect(result.entry.bundle?.claims?.[0]).toMatchObject({ value: 'fail' });
    });

    test('respects an explicit producer and expectation ids', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const result = await svc.attachCommandEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        command: 'node -e "process.exit(0)"',
        claimType: 'quality.tests',
        producer: 'station/vitest',
        expectationIds: ['tests-passed'],
      });
      expect(result.entry.producer).toBe('station/vitest');
      expect(result.entry.expectation_ids).toEqual(['tests-passed']);
    });

    test('rejects an unknown gate before running the command', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const marker = join(cwd, 'should-not-exist.txt');
      await expect(
        svc.attachCommandEvidence(cwd, 'run-1', {
          gate: 'nope-gate',
          command: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`,
          claimType: 'quality.tests',
        }),
      ).rejects.toBeInstanceOf(FlowRunInvalidError);
      expect(existsSync(marker)).toBe(false);
    });

    test('throws not-found for an unknown run', async () => {
      const cwd = createWorkspace();
      await expect(
        new FlowRunService().attachCommandEvidence(cwd, 'missing', {
          gate: 'build-gate',
          command: 'node -e "process.exit(0)"',
          claimType: 'quality.tests',
        }),
      ).rejects.toBeInstanceOf(FlowRunNotFoundError);
    });
  });

  describe('attachCommandEvidenceResult', () => {
    function readStoredEvidence(result: { evidencePath?: unknown }) {
      return JSON.parse(readFileSync(String(result.evidencePath), 'utf8'));
    }

    test('attaches a trusted claim from a provided result without re-running', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const result = await svc.attachCommandEvidenceResult(
        cwd,
        'run-1',
        {
          command: 'npm test',
          output: 'all green\n',
          exitCode: 0,
          timedOut: false,
          durationMs: 1234,
          outputTruncated: false,
        },
        { gate: 'build-gate', claimType: 'quality.tests' },
      );
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBe(1234);
      expect(result.outputTail).toEqual(['all green']);
      expect(result.entry).toMatchObject({
        gate_id: 'build-gate',
        status: 'passed',
        producer: 'station/command',
        expectation_ids: ['tests-passed'],
        kind: 'trust.bundle',
      });
      expect(result.entry.bundle?.claims?.[0]).toMatchObject({
        claimType: 'quality.tests',
        status: 'assumed',
        value: 'pass',
      });
      const stored = readStoredEvidence(result);
      expect(stored).toMatchObject({
        kind: 'station.command-evidence',
        command: 'npm test',
        exit_code: 0,
        duration_ms: 1234,
      });
      const evaluation = await svc.evaluate(cwd, 'run-1');
      expect(evaluation.outcomes[0]).toMatchObject({
        gate_id: 'build-gate',
        status: 'pass',
      });
    });

    test('non-zero exit attaches failed evidence with route-back reason', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const result = await svc.attachCommandEvidenceResult(
        cwd,
        'run-1',
        {
          command: 'npm test',
          output: 'boom\n',
          exitCode: 1,
          timedOut: false,
          durationMs: 5,
          outputTruncated: false,
        },
        {
          gate: 'build-gate',
          claimType: 'quality.tests',
          producer: 'station/command-auto',
          label: 'auto: npm test',
        },
      );
      expect(result.entry).toMatchObject({
        status: 'failed',
        route_reason: 'implementation_defect',
        producer: 'station/command-auto',
      });
      expect(result.entry.bundle?.claims?.[0]).toMatchObject({
        claimType: 'quality.tests',
        value: 'fail',
      });
      const stored = readStoredEvidence(result);
      expect(stored).toMatchObject({ label: 'auto: npm test', exit_code: 1 });
      const evaluation = await svc.evaluate(cwd, 'run-1');
      expect(evaluation.outcomes[0]).toMatchObject({
        gate_id: 'build-gate',
        status: 'route-back',
        route_reason: 'implementation_defect',
      });
    });

    test('rejects an unknown gate', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      await expect(
        svc.attachCommandEvidenceResult(
          cwd,
          'run-1',
          {
            command: 'npm test',
            output: '',
            exitCode: 0,
            timedOut: false,
            durationMs: 1,
            outputTruncated: false,
          },
          { gate: 'nope-gate', claimType: 'quality.tests' },
        ),
      ).rejects.toBeInstanceOf(FlowRunInvalidError);
    });

    /**
     * archive#4237: Station only OBSERVED these commands — a connected/ACP
     * agent dispatched them. The durable evidence must not state execution
     * facts nobody measured, and the pass/fail claim must be derived from the
     * one fact that was measured: the runtime's own status.
     */
    describe('observed (not executed) commands', () => {
      function observed(status: 'success' | 'error' | 'cancelled') {
        return {
          command: 'npm test',
          output: 'all green\n',
          exitCode: null,
          timedOut: false,
          durationMs: null,
          outputTruncated: false,
          observedStatus: status,
        };
      }

      test('a runtime-reported success passes while claiming no exit code, duration or start time', async () => {
        const cwd = createWorkspace();
        const svc = new FlowRunService();
        await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });

        const result = await svc.attachCommandEvidenceResult(
          cwd,
          'run-1',
          observed('success'),
          { gate: 'build-gate', claimType: 'quality.tests' },
        );

        expect(result.entry).toMatchObject({ status: 'passed' });
        expect(result.entry.bundle?.claims?.[0]).toMatchObject({
          claimType: 'quality.tests',
          value: 'pass',
        });
        const stored = readStoredEvidence(result);
        // Explicit nulls, not omission: a reader must be able to tell
        // "unknown" from "measured zero", and a MISSING key is
        // indistinguishable from a record written before the field existed.
        expect(Object.keys(stored)).toEqual(
          expect.arrayContaining(['exit_code', 'duration_ms', 'started_at']),
        );
        expect(stored.exit_code).toBeNull();
        expect(stored.duration_ms).toBeNull();
        expect(stored.started_at).toBeNull();
        // Station did observe when it saw the completion, so this stays real.
        expect(stored.finished_at).toEqual(expect.any(String));
        expect(result.durationMs).toBeNull();

        const evaluation = await svc.evaluate(cwd, 'run-1');
        expect(evaluation.outcomes[0]).toMatchObject({
          gate_id: 'build-gate',
          status: 'pass',
        });
      });

      test('a runtime-reported error routes the gate back', async () => {
        const cwd = createWorkspace();
        const svc = new FlowRunService();
        await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });

        const result = await svc.attachCommandEvidenceResult(
          cwd,
          'run-1',
          observed('error'),
          { gate: 'build-gate', claimType: 'quality.tests' },
        );

        expect(result.entry).toMatchObject({
          status: 'failed',
          route_reason: 'implementation_defect',
        });
        expect(result.entry.bundle?.claims?.[0]).toMatchObject({
          value: 'fail',
        });

        const evaluation = await svc.evaluate(cwd, 'run-1');
        expect(evaluation.outcomes[0]).toMatchObject({
          gate_id: 'build-gate',
          status: 'route-back',
          route_reason: 'implementation_defect',
        });
      });

      test('a cancelled tool call does not pass the gate', async () => {
        const cwd = createWorkspace();
        const svc = new FlowRunService();
        await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });

        const result = await svc.attachCommandEvidenceResult(
          cwd,
          'run-1',
          observed('cancelled'),
          { gate: 'build-gate', claimType: 'quality.tests' },
        );

        expect(result.entry).toMatchObject({ status: 'failed' });
        expect(result.entry.bundle?.claims?.[0]).toMatchObject({
          value: 'fail',
        });
      });

      test('an EXECUTED command killed by a signal still fails and keeps its measured timings', async () => {
        const cwd = createWorkspace();
        const svc = new FlowRunService();
        await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });

        // The executed path: `exitCode: null` means killed/unknown and there
        // is no runtime status to fall back on, so the claim must stay
        // failing — the observed-path fallback must never leak into it.
        const result = await svc.attachCommandEvidenceResult(
          cwd,
          'run-1',
          {
            command: 'npm test',
            output: 'killed\n',
            exitCode: null,
            timedOut: true,
            durationMs: 4321,
            outputTruncated: false,
          },
          { gate: 'build-gate', claimType: 'quality.tests' },
        );

        expect(result.entry).toMatchObject({ status: 'failed' });
        expect(result.entry.bundle?.claims?.[0]).toMatchObject({
          value: 'fail',
        });
        const stored = readStoredEvidence(result);
        expect(stored.duration_ms).toBe(4321);
        expect(stored.started_at).toEqual(expect.any(String));
      });
    });
  });

  describe('commandOutcomePassed', () => {
    // The predicate both the durable claim and the bridge's telemetry read,
    // exported so the two cannot drift (archive#4237).
    test.each([
      // [exitCode, timedOut, observedStatus, expected]
      [0, false, undefined, true],
      [0, true, undefined, false],
      [1, false, undefined, false],
      [null, false, undefined, false],
      [null, true, undefined, false],
      [null, false, 'success', true],
      [null, false, 'error', false],
      [null, false, 'cancelled', false],
      // A real exit code always decides; an observed status never overrides it.
      [1, false, 'success', false],
      [0, false, 'error', true],
      // The row the predicate was missing (archive#4237 review M2): a timeout must
      // fail even when the observed status says success. No producer can
      // construct this today — which is exactly why it needed pinning before
      // someone plumbs a real observed timeout and a runtime reports the
      // killed call as `success`.
      [null, true, 'success', false],
    ] as Array<
      [
        number | null,
        boolean,
        'success' | 'error' | 'cancelled' | undefined,
        boolean,
      ]
    >)(
      'exitCode=%s timedOut=%s observedStatus=%s -> %s',
      (exitCode, timedOut, observedStatus, expected) => {
        expect(
          commandOutcomePassed({ exitCode, timedOut, observedStatus }),
        ).toBe(expected);
      },
    );
  });

  describe('trusted producer pinning via .flow/config.json', () => {
    /** Flow owns trusted producer and rich authority policy in Flow 5.1. */
    const PINNED_CONFIG = {
      schema_version: '0.1',
      trusted_producers: {
        'governance.merge-readiness': { producers: ['veritas'] },
      },
      gate_overrides: {},
    };

    /** Single readiness-gated step, same shape as station-delivery's last step. */
    const READINESS_DEFINITION = {
      id: 'pinned-readiness',
      version: '1',
      steps: [{ id: 'readiness', next: null }],
      gates: {
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
                accepted_statuses: ['verified'],
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

    function createPinnedWorkspace(): string {
      const cwd = createWorkspace();
      writeFileSync(
        join(cwd, '.flow', 'definitions', 'pinned-readiness.json'),
        JSON.stringify(READINESS_DEFINITION, null, 2),
      );
      writeFileSync(
        join(cwd, '.flow', 'config.json'),
        JSON.stringify(PINNED_CONFIG, null, 2),
      );
      return cwd;
    }

    test('a veritas-producer readiness claim satisfies the pinned gate', async () => {
      const cwd = createPinnedWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'pinned-readiness', runId: 'r1' });
      await svc.attachEvidence(cwd, 'r1', {
        gate: 'readiness-gate',
        file: bundleEvidence(cwd, 'governance.merge-readiness'),
        kind: 'trust.bundle',
        producer: 'veritas',
      });
      const result = await svc.evaluate(cwd, 'r1');
      expect(result.outcomes[0]).toMatchObject({
        gate_id: 'readiness-gate',
        status: 'pass',
      });
      expect(result.state.status).toBe('completed');
    });

    test('an attachment producer that disagrees with its bundle producer routes back', async () => {
      const cwd = createPinnedWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'pinned-readiness', runId: 'r1' });
      await svc.attachEvidence(cwd, 'r1', {
        gate: 'readiness-gate',
        file: bundleEvidence(cwd, 'governance.merge-readiness'),
        kind: 'trust.bundle',
        producer: 'station/command',
      });
      const result = await svc.evaluate(cwd, 'r1');
      expect(result.outcomes[0]).toMatchObject({
        status: 'route-back',
        diagnostics: {
          claim_evaluation: [
            {
              expectation_id: 'merge-readiness',
              evidence_id: expect.any(String),
              reason: 'untrusted_producer',
              authority: { code: 'producer_mismatch' },
            },
          ],
        },
      });
    });

    test('an attachment producer alone cannot satisfy the gate', async () => {
      const cwd = createPinnedWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'pinned-readiness', runId: 'r1' });
      await svc.attachEvidence(cwd, 'r1', {
        gate: 'readiness-gate',
        file: writeEvidenceFile(
          cwd,
          'unattributed.json',
          buildSyntheticTrustBundle({
            claimType: 'governance.merge-readiness',
            subjectId: 'r1',
          }),
        ),
        kind: 'trust.bundle',
      });
      expect((await svc.evaluate(cwd, 'r1')).outcomes[0].status).toBe(
        'route-back',
      );
    });

    /**
     * H1 (independent review): the attach check resolved the evidence path with
     * `join(cwd, file)` while Flow uses `path.resolve(cwd, file)`. For an
     * ABSOLUTE path — which is what EVERY production caller passes, because
     * `attachCommandEvidenceResult` and `FlowReadinessBridge` both write their
     * bundle into `createStationTempDir()` — `join` produced `<cwd><abs>`, the
     * read failed, and the pin waved the attach through. The original attach
     * tests all used relative paths: the one shape production never uses.
     *
     * These mirror the real caller shape instead.
     */
    test('an untrusted producer on an absolute path is retained but fails the gate', async () => {
      const cwd = createPinnedWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'pinned-readiness', runId: 'r1' });

      // Exactly what attachCommandEvidenceResult does: bundle written into a
      // temp dir outside the workspace, referenced by absolute path.
      const outside = mkdtempSync(join(tmpdir(), 'station-command-evidence-'));
      tempDirs.push(outside);
      const bundlePath = join(outside, 'bundle.json');
      writeFileSync(
        bundlePath,
        JSON.stringify(
          buildSyntheticTrustBundle({
            claimType: 'governance.merge-readiness',
            subjectId: 'r1',
          }),
          null,
          2,
        ),
      );

      await svc.attachEvidence(cwd, 'r1', {
        gate: 'readiness-gate',
        file: bundlePath,
        kind: 'trust.bundle',
        producer: 'station/command',
      });
      expect((await svc.evaluate(cwd, 'r1')).outcomes[0].status).toBe(
        'route-back',
      );
    });

    /**
     * The same proof through the real production entry point rather than a
     * hand-built absolute path — `attachCommandEvidence` mints its own
     * temp-dir bundle and defaults to the `station/command` producer.
     */
    test('attachCommandEvidence retains untrusted evidence but Flow rejects it', async () => {
      const cwd = createPinnedWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'pinned-readiness', runId: 'r1' });

      await svc.attachCommandEvidence(cwd, 'r1', {
        gate: 'readiness-gate',
        command: 'node --version',
        claimType: 'governance.merge-readiness',
      });
      expect((await svc.evaluate(cwd, 'r1')).outcomes[0].status).toBe(
        'route-back',
      );
    });

    test('an absolute-path bundle from a TRUSTED producer still attaches', async () => {
      const cwd = createPinnedWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'pinned-readiness', runId: 'r1' });
      const outside = mkdtempSync(join(tmpdir(), 'station-command-evidence-'));
      tempDirs.push(outside);
      const bundlePath = join(outside, 'bundle.json');
      writeFileSync(
        bundlePath,
        JSON.stringify(
          buildSyntheticTrustBundle({
            claimType: 'governance.merge-readiness',
            subjectId: 'r1',
          }),
          null,
          2,
        ),
      );
      const entry = await svc.attachEvidence(cwd, 'r1', {
        gate: 'readiness-gate',
        file: bundlePath,
        kind: 'trust.bundle',
        producer: 'veritas',
      });
      expect(entry.gate_id).toBe('readiness-gate');
    });

    // Failed evidence bypasses the attach check on purpose: a failed entry can
    // never satisfy an expectation, so it cannot launder trust, and refusing
    // it would break the fail-then-fix loop.
    test('failed evidence from an untrusted producer still attaches', async () => {
      const cwd = createPinnedWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'pinned-readiness', runId: 'r1' });
      const entry = await svc.attachEvidence(cwd, 'r1', {
        gate: 'readiness-gate',
        file: bundleEvidence(cwd, 'governance.merge-readiness'),
        kind: 'trust.bundle',
        producer: 'station/command',
        status: 'failed',
        routeReason: 'implementation_defect',
      });
      expect(entry.status).toBe('failed');
    });

    test('out-of-band untrusted evidence is rejected by Flow policy', async () => {
      const cwd = createPinnedWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'pinned-readiness', runId: 'r1' });
      const entry = await attachEvidence('r1', {
        cwd,
        gate: 'readiness-gate',
        file: bundleEvidence(cwd, 'governance.merge-readiness'),
        kind: 'trust.bundle',
        producer: 'station/command',
      });

      const result = await svc.evaluate(cwd, 'r1');
      expect(result.outcomes[0]).toMatchObject({
        gate_id: 'readiness-gate',
        status: 'route-back',
        diagnostics: {
          claim_evaluation: [
            {
              expectation_id: 'merge-readiness',
              evidence_id: entry.id,
              reason: 'untrusted_producer',
              authority: { code: 'producer_mismatch' },
            },
          ],
        },
      });
    });

    test('a trusted producer alongside an untrusted one satisfies the pin', async () => {
      const cwd = createPinnedWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'pinned-readiness', runId: 'r1' });
      await attachEvidence('r1', {
        cwd,
        gate: 'readiness-gate',
        file: bundleEvidence(cwd, 'governance.merge-readiness', 'rogue.json'),
        kind: 'trust.bundle',
        producer: 'station/command',
      });
      await svc.attachEvidence(cwd, 'r1', {
        gate: 'readiness-gate',
        file: bundleEvidence(cwd, 'governance.merge-readiness', 'real.json'),
        kind: 'trust.bundle',
        producer: 'veritas',
      });

      const result = await svc.evaluate(cwd, 'r1');
      expect(result.outcomes[0].status).toBe('pass');
      expect(result.state.status).toBe('completed');
    });

    test('an authority_refs policy accepts only an active scoped trace', async () => {
      const cwd = createPinnedWorkspace();
      writeFileSync(
        join(cwd, '.flow', 'config.json'),
        JSON.stringify(
          {
            schema_version: '0.1',
            trusted_producers: {
              'governance.merge-readiness': {
                authority_refs: ['authority:readiness'],
              },
            },
            gate_overrides: {},
          },
          null,
          2,
        ),
      );
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'pinned-readiness', runId: 'r1' });
      await svc.attachEvidence(cwd, 'r1', {
        gate: 'readiness-gate',
        file: writeEvidenceFile(
          cwd,
          'authority.json',
          readinessBundle('other'),
        ),
        kind: 'trust.bundle',
        producer: 'other',
      });
      expect((await svc.evaluate(cwd, 'r1')).outcomes[0].status).toBe('pass');
    });

    test('a mismatched authority trace routes back with Flow diagnostics', async () => {
      const cwd = createPinnedWorkspace();
      writeFileSync(
        join(cwd, '.flow', 'config.json'),
        JSON.stringify(
          {
            schema_version: '0.1',
            trusted_producers: {
              'governance.merge-readiness': {
                authority_refs: ['authority:readiness'],
              },
            },
            gate_overrides: {},
          },
          null,
          2,
        ),
      );
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'pinned-readiness', runId: 'r1' });
      await svc.attachEvidence(cwd, 'r1', {
        gate: 'readiness-gate',
        file: writeEvidenceFile(
          cwd,
          'wrong-authority.json',
          readinessBundle('other', 'authority:wrong'),
        ),
        kind: 'trust.bundle',
        producer: 'other',
      });
      expect((await svc.evaluate(cwd, 'r1')).outcomes[0]).toMatchObject({
        status: 'route-back',
        diagnostics: {
          claim_evaluation: [
            {
              expectation_id: 'merge-readiness',
              evidence_id: expect.any(String),
              reason: 'untrusted_producer',
              authority: { code: 'authority_ref_mismatch' },
            },
          ],
        },
      });
    });

    test('an obsolete Station switch cannot disable Flow policy', async () => {
      const cwd = createPinnedWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'pinned-readiness', runId: 'r1' });
      await svc.attachEvidence(cwd, 'r1', {
        gate: 'readiness-gate',
        file: bundleEvidence(cwd, 'governance.merge-readiness'),
        kind: 'trust.bundle',
        producer: 'station/command',
      });
      expect((await svc.evaluate(cwd, 'r1')).outcomes[0].status).toBe(
        'route-back',
      );
    });

    test('quality.* gates stay unpinned: manual and helper attachments keep working', async () => {
      const cwd = createPinnedWorkspace();
      const svc = new FlowRunService();

      // Manual attach with an arbitrary producer on the quality.tests gate.
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'manual' });
      await svc.attachEvidence(cwd, 'manual', {
        gate: 'build-gate',
        file: bundleEvidence(cwd, 'quality.tests'),
        kind: 'trust.bundle',
        producer: 'somebody/else',
      });
      const manual = await svc.evaluate(cwd, 'manual');
      expect(manual.outcomes[0]).toMatchObject({
        gate_id: 'build-gate',
        status: 'pass',
      });

      // Command-evidence helper with its default producer.
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'helper' });
      await svc.attachCommandEvidence(cwd, 'helper', {
        gate: 'build-gate',
        command: 'node -e "process.exit(0)"',
        claimType: 'quality.tests',
      });
      const helper = await svc.evaluate(cwd, 'helper');
      expect(helper.outcomes[0]).toMatchObject({
        gate_id: 'build-gate',
        status: 'pass',
      });
    });
  });

  describe('evaluate', () => {
    test('passes the gate and advances when claim evidence matches', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      await svc.attachEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        file: bundleEvidence(cwd, 'quality.tests'),
        kind: 'trust.bundle',
      });
      const result = await svc.evaluate(cwd, 'run-1');
      expect(result.outcomes[0]).toMatchObject({
        gate_id: 'build-gate',
        status: 'pass',
      });
      expect(result.state.current_step).toBe('verify');
    });

    test('routes back on failed evidence with attempt budget', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      await svc.attachEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        file: passingEvidence(cwd, 'failed-tests.json'),
        status: 'failed',
        routeReason: 'implementation_defect',
      });
      const result = await svc.evaluate(cwd, 'run-1', 'build-gate');
      expect(result.outcomes[0]).toMatchObject({
        gate_id: 'build-gate',
        status: 'route-back',
        route_back_to: 'build',
        route_reason: 'implementation_defect',
        attempt: 1,
        max_attempts: 2,
        limit_exceeded: false,
      });
      expect(result.state.current_step).toBe('build');
    });

    test('routes back on missing required evidence', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const result = await svc.evaluate(cwd, 'run-1');
      expect(result.outcomes[0]).toMatchObject({
        gate_id: 'build-gate',
        status: 'route-back',
        route_reason: 'missing_evidence',
        missing: ['tests-passed'],
      });
    });

    test('recovers a route-back by superseding failed evidence', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const failed = await svc.attachEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        file: passingEvidence(cwd, 'failed-tests.json'),
        status: 'failed',
        routeReason: 'implementation_defect',
      });
      await svc.evaluate(cwd, 'run-1');
      await svc.attachEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        file: bundleEvidence(cwd, 'quality.tests', 'retried-tests.json'),
        kind: 'trust.bundle',
        supersede: failed.id,
      });
      const result = await svc.evaluate(cwd, 'run-1');
      expect(result.outcomes[0].status).toBe('pass');
      expect(result.state.current_step).toBe('verify');
    });

    /**
     * Flow 3.1.2-3.1.4 behavior delta, pinned here because nothing else in the
     * suite could see it: gate evidence is now scoped to the CURRENT gate
     * visit. Evidence attached before a route-back no longer counts once the
     * gate is re-entered — it reads as `attachment_not_current`. A recovery
     * that only supersedes the failing entry therefore does NOT resurrect the
     * older passing entry; fresh evidence must be attached for the new visit.
     */
    test('evidence from before a route-back does not satisfy the re-entered gate', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      await svc.attachEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        file: bundleEvidence(cwd, 'quality.tests', 'first-pass.json'),
        kind: 'trust.bundle',
      });
      const failed = await svc.attachEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        file: passingEvidence(cwd, 'failed-tests.json'),
        status: 'failed',
        routeReason: 'implementation_defect',
      });
      const routed = await svc.evaluate(cwd, 'run-1', 'build-gate');
      expect(routed.outcomes[0].status).toBe('route-back');

      // Clear the failure with a current, NON-failing bundle for a claim type
      // this gate does not expect. That leaves the gate with no failing
      // evidence at all, so the only thing that could satisfy `tests-passed`
      // is the earlier passing bundle — which is still on the manifest and
      // still un-superseded. Under pre-3.1.2 semantics the gate would pass.
      await svc.attachEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        file: bundleEvidence(cwd, 'quality.lint', 'unrelated.json'),
        kind: 'trust.bundle',
        supersede: failed.id,
      });
      const after = await svc.evaluate(cwd, 'run-1', 'build-gate');
      expect(after.outcomes[0]).toMatchObject({
        status: 'route-back',
        missing: ['tests-passed'],
      });
      expect(after.state.current_step).toBe('build');
      // Prove the visit scoping is what excluded it, and not supersession: the
      // first-pass entry remains on the manifest and un-superseded.
      const run = await svc.getRun(cwd, 'run-1');
      const stale = run.manifest.evidence.find((entry) =>
        entry.original_path?.endsWith('first-pass.json'),
      );
      expect(stale?.superseded_by).toBeFalsy();

      // Fresh evidence for the new visit clears it.
      await svc.attachEvidence(cwd, 'run-1', {
        gate: 'build-gate',
        file: bundleEvidence(cwd, 'quality.tests', 'second-pass.json'),
        kind: 'trust.bundle',
      });
      const recovered = await svc.evaluate(cwd, 'run-1', 'build-gate');
      expect(recovered.outcomes[0].status).toBe('pass');
      expect(recovered.state.current_step).toBe('verify');
    });

    test('throws invalid for unknown gate', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      await expect(
        svc.evaluate(cwd, 'run-1', 'nope-gate'),
      ).rejects.toBeInstanceOf(FlowRunInvalidError);
    });

    /**
     * Flow 3 raises the duplicate-run error with a stable CODE
     * (`flow.run_location.allocation_collision`); its message changed from the
     * pre-3 "run already exists". `attachFlowRunForSessionStart` resumes on
     * exactly this error, so the code must survive translation into
     * `FlowRunInvalidError` — a bare `instanceof` check there would resume on
     * every other invalid-start error too.
     */
    test('a duplicate run id surfaces the allocation-collision code', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'dup-code' });
      await expect(
        svc.startRun(cwd, { definition: 'test-flow', runId: 'dup-code' }),
      ).rejects.toMatchObject({
        name: 'FlowRunInvalidError',
        code: FLOW_RUN_LOCATION_ALLOCATION_COLLISION,
      });
    });

    /**
     * M4 (independent review): a run directory that exists but is missing its
     * artifacts raises `flow.run_location.no_complete_candidate`, which matched
     * nothing in the code table and surfaced as an untyped 500 — where Flow
     * 1.3.0 produced a typed 404. It also wedged session start: the
     * resume-on-collision path calls `getRun` for the deterministic run id and
     * re-threw untyped.
     */
    test('a half-written run directory is a typed not-found, not an untyped throw', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      // A directory at the canonical location with no state/definition in it.
      mkdirSync(join(cwd, '.kontourai', 'flow', 'runs', 'half-written'), {
        recursive: true,
      });

      const error = await svc.getRun(cwd, 'half-written').catch((e) => e);
      expect(error).toBeInstanceOf(FlowRunNotFoundError);
      expect(error.code).toBe(FLOW_RUN_LOCATION_NO_COMPLETE_CANDIDATE);
      // Flow's own words survive: "not found" and "exists but incomplete" send
      // an operator to different places.
      expect(error.message).toMatch(/incomplete/i);
    });

    /**
     * The end-to-end shape M4 names: startRun collides with the half-written
     * directory, the resume path reads it, and session start degrades with a
     * typed error instead of an untyped 500.
     */
    test('session start over a half-written run degrades honestly', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      mkdirSync(join(cwd, '.kontourai', 'flow', 'runs', 'session-wedged'), {
        recursive: true,
      });

      const startError = await svc
        .startRun(cwd, { definition: 'test-flow', runId: 'session-wedged' })
        .catch((e) => e);
      expect(startError).toBeInstanceOf(FlowRunInvalidError);
      expect(startError.code).toBe(FLOW_RUN_LOCATION_ALLOCATION_COLLISION);

      // The resume path's read: typed, so the caller can report it as a
      // missing run rather than a server fault.
      const resumeError = await svc
        .getRun(cwd, 'session-wedged')
        .catch((e) => e);
      expect(resumeError).toBeInstanceOf(FlowRunNotFoundError);
      expect(resumeError.code).toBe(FLOW_RUN_LOCATION_NO_COMPLETE_CANDIDATE);
    });

    /**
     * A run directory Flow cannot enumerate is REPORTED, not silently dropped
     * from a list that then looks complete.
     */
    test('listRunsWithDiagnostics names run directories it could not read', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'good' });
      mkdirSync(join(cwd, '.kontourai', 'flow', 'runs', 'broken'), {
        recursive: true,
      });

      const { runs, diagnostics } = await svc.listRunsWithDiagnostics(cwd);
      expect(runs.map((run) => run.run_id)).toEqual(['good']);
      expect(diagnostics.map((entry) => entry.run_id)).toContain('broken');
      // The summary-only view is deliberately lossy, and that is exactly why
      // the diagnostics-bearing call exists.
      expect((await svc.listRuns(cwd)).map((run) => run.run_id)).toEqual([
        'good',
      ]);
    });

    /** Flow 3 reports a missing run by code, not by an ENOENT errno. */
    test('a missing run surfaces the run-location not-found code', async () => {
      const cwd = createWorkspace();
      await expect(
        new FlowRunService().getRun(cwd, 'nope'),
      ).rejects.toMatchObject({
        name: 'FlowRunNotFoundError',
        code: FLOW_RUN_LOCATION_NOT_FOUND,
      });
    });

    test('throws not-found for unknown run', async () => {
      const cwd = createWorkspace();
      await expect(
        new FlowRunService().evaluate(cwd, 'missing'),
      ).rejects.toBeInstanceOf(FlowRunNotFoundError);
    });
  });

  describe('previewRouteBack', () => {
    test('returns the route-back contract without mutating state', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const preview = await svc.previewRouteBack(
        cwd,
        'run-1',
        'build-gate',
        'implementation_defect',
      );
      expect(preview).toMatchObject({
        route_back_to: 'build',
        attempt: 1,
        max_attempts: 2,
        limit_exceeded: false,
      });
      const run = await svc.getRun(cwd, 'run-1');
      expect(run.state.transitions).toEqual([]);
    });

    test('throws invalid for unknown gate', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      await expect(
        svc.previewRouteBack(cwd, 'run-1', 'nope-gate'),
      ).rejects.toBeInstanceOf(FlowRunInvalidError);
    });
  });

  describe('acceptException', () => {
    test('records the exception and lets the gate pass on re-evaluate', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const exception = await svc.acceptException(cwd, 'run-1', {
        gate: 'build-gate',
        reason: 'known flake, tracked upstream',
        authority: 'team-lead',
      });
      expect(exception).toMatchObject({
        gate_id: 'build-gate',
        authority: 'team-lead',
      });
      const result = await svc.evaluate(cwd, 'run-1');
      expect(result.outcomes[0]).toMatchObject({
        gate_id: 'build-gate',
        status: 'pass',
        summary: 'accepted exception',
      });
    });

    test('throws invalid for unknown gate', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      await expect(
        svc.acceptException(cwd, 'run-1', {
          gate: 'nope-gate',
          reason: 'r',
          authority: 'a',
        }),
      ).rejects.toBeInstanceOf(FlowRunInvalidError);
    });
  });

  describe('getReport', () => {
    test('returns json report and writes report files', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const report = (await svc.getReport(cwd, 'run-1', 'json')) as Record<
        string,
        unknown
      >;
      expect(report.run_id).toBe('run-1');
      expect(report.definition_id).toBe('test-flow');
      const runDir = join(cwd, '.kontourai', 'flow', 'runs', 'run-1');
      expect(existsSync(join(runDir, 'report.md'))).toBe(true);
      expect(existsSync(join(runDir, 'report.json'))).toBe(true);
      expect(existsSync(join(cwd, '.flow', 'runs'))).toBe(false);
    });

    test('returns markdown report', async () => {
      const cwd = createWorkspace();
      const svc = new FlowRunService();
      await svc.startRun(cwd, { definition: 'test-flow', runId: 'run-1' });
      const report = await svc.getReport(cwd, 'run-1', 'markdown');
      expect(typeof report).toBe('string');
      expect(report).toContain('run-1');
    });

    test('throws not-found for unknown run', async () => {
      const cwd = createWorkspace();
      await expect(
        new FlowRunService().getReport(cwd, 'missing', 'json'),
      ).rejects.toBeInstanceOf(FlowRunNotFoundError);
    });
  });

  describe('ensureLayout', () => {
    /**
     * Flow 3 splits the layout: durable definitions and config stay in the
     * contract-owned `.flow/`, generated run state moves to
     * `.kontourai/flow/runs`. The old assertion demanded `.flow/runs` — the
     * exact directory archive#290 exists to retire.
     */
    test('creates durable .flow config and the canonical generated run root', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'station-flow-layout-'));
      tempDirs.push(cwd);
      await new FlowRunService().ensureLayout(cwd);
      expect(existsSync(join(cwd, '.flow', 'definitions'))).toBe(true);
      expect(existsSync(join(cwd, '.flow', 'config.json'))).toBe(true);
      expect(existsSync(join(cwd, '.kontourai', 'flow', 'runs'))).toBe(true);
      expect(existsSync(join(cwd, '.flow', 'runs'))).toBe(false);
    });
  });
});
