import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../telemetry/metrics.js', () => ({
  flowRunsStarted: { add: vi.fn() },
  flowEvidenceAttached: { add: vi.fn() },
  flowEvidenceAutoSuperseded: { add: vi.fn() },
  flowGateEvaluations: { add: vi.fn() },
  flowRunLocationDiagnostics: { add: vi.fn() },
  flowExceptionsAccepted: { add: vi.fn() },
  flowReportsGenerated: { add: vi.fn() },
  flowRunConsoleProjections: { add: vi.fn() },
  flowToolEvidenceSpooled: { add: vi.fn() },
  flowToolEvidenceAttached: { add: vi.fn() },
}));

const { FlowRunService } = await import('../flow/flow-run-service.js');
const { DefaultCommandEvidenceRoutingPolicy } = await import(
  '../evidence/command-evidence-routing-policy.js'
);
const { FlowCommandEvidenceBridge } = await import(
  '../flow/flow-command-evidence-bridge.js'
);
const { evaluateFlowCompletionGate } = await import(
  '../flow/orchestration-flow-gate.js'
);
const { attachEvidence } = await import('@kontourai/flow');
const { buildSyntheticTrustBundle } = await import(
  '../evidence/trust-bundle.js'
);

/** One gated step expecting a quality.tests claim. */
const DEFINITION = {
  id: 'test-flow',
  version: '1',
  steps: [{ id: 'build', next: null }],
  gates: {
    'build-gate': {
      step: 'build',
      expects: [
        {
          id: 'tests-passed',
          kind: 'trust.bundle',
          required: true,
          description: 'Tests pass.',
          bundle_claim: {
            claimType: 'quality.tests',
            accepted_statuses: ['assumed'],
          },
        },
      ],
      on_route_back: { default: 'build' },
      route_back_policy: { max_attempts: 2, on_exceeded: 'block' },
    },
  },
};

describe('evaluateFlowCompletionGate command-evidence drain', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createWorkspace(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'station-cmd-evidence-gate-'));
    tempDirs.push(cwd);
    const dir = join(cwd, '.flow', 'definitions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'test-flow.json'),
      JSON.stringify(DEFINITION, null, 2),
    );
    return cwd;
  }

  test('drains a spooled passing test command so the gate passes', async () => {
    const cwd = createWorkspace();
    const flowRunService = new FlowRunService();
    await flowRunService.startRun(cwd, {
      definition: 'test-flow',
      runId: 'run-1',
    });
    const bridge = new FlowCommandEvidenceBridge({
      flowRunService,
      policy: new DefaultCommandEvidenceRoutingPolicy(),
    });
    bridge.spool('thread-1', {
      toolName: 'Bash',
      toolCallId: 'call-1',
      command: 'npm test',
      output: 'all green',
      status: 'success',
      exitCode: 0,
      timedOut: false,
      durationMs: 12,
      outputTruncated: false,
    });

    const verdict = await evaluateFlowCompletionGate({
      flowRunService,
      binding: { runId: 'run-1', definitionId: 'test-flow', cwd },
      provider: 'claude',
      threadId: 'thread-1',
      commandEvidenceBridge: bridge,
    });

    expect(verdict.verdict).toBe('pass');
    expect(bridge.hasSpooled('thread-1')).toBe(false);
  });

  /**
   * station#4237, end to end: the spool now carries what Station actually
   * observed — a runtime status, no exit code, no duration. The gate verdict
   * must still be derived, and an errored tool call must not pass.
   */
  function observedSpool(status: 'success' | 'error' | 'cancelled') {
    return {
      toolName: 'Bash',
      toolCallId: 'call-1',
      command: 'npm test',
      output: status === 'success' ? 'all green' : 'boom',
      status,
      exitCode: null,
      timedOut: false,
      durationMs: null,
      outputTruncated: false,
    };
  }

  test('drains an observed passing command (no exit code) so the gate passes', async () => {
    const cwd = createWorkspace();
    const flowRunService = new FlowRunService();
    await flowRunService.startRun(cwd, {
      definition: 'test-flow',
      runId: 'run-1',
    });
    const bridge = new FlowCommandEvidenceBridge({
      flowRunService,
      policy: new DefaultCommandEvidenceRoutingPolicy(),
    });
    bridge.spool('thread-1', observedSpool('success'));

    const verdict = await evaluateFlowCompletionGate({
      flowRunService,
      binding: { runId: 'run-1', definitionId: 'test-flow', cwd },
      provider: 'claude',
      threadId: 'thread-1',
      commandEvidenceBridge: bridge,
    });

    expect(verdict.verdict).toBe('pass');
    expect(bridge.hasSpooled('thread-1')).toBe(false);
  });

  test('an observed errored command does not pass the gate', async () => {
    const cwd = createWorkspace();
    const flowRunService = new FlowRunService();
    await flowRunService.startRun(cwd, {
      definition: 'test-flow',
      runId: 'run-1',
    });
    const bridge = new FlowCommandEvidenceBridge({
      flowRunService,
      policy: new DefaultCommandEvidenceRoutingPolicy(),
    });
    bridge.spool('thread-1', observedSpool('error'));

    const verdict = await evaluateFlowCompletionGate({
      flowRunService,
      binding: { runId: 'run-1', definitionId: 'test-flow', cwd },
      provider: 'claude',
      threadId: 'thread-1',
      commandEvidenceBridge: bridge,
    });

    expect(verdict.verdict).not.toBe('pass');
    expect(bridge.hasSpooled('thread-1')).toBe(false);
  });

  test('without spooled evidence the gate waits/routes (no auto-pass)', async () => {
    const cwd = createWorkspace();
    const flowRunService = new FlowRunService();
    await flowRunService.startRun(cwd, {
      definition: 'test-flow',
      runId: 'run-1',
    });
    const bridge = new FlowCommandEvidenceBridge({
      flowRunService,
      policy: new DefaultCommandEvidenceRoutingPolicy(),
    });

    const verdict = await evaluateFlowCompletionGate({
      flowRunService,
      binding: { runId: 'run-1', definitionId: 'test-flow', cwd },
      provider: 'claude',
      threadId: 'thread-1',
      commandEvidenceBridge: bridge,
    });

    expect(verdict.verdict).not.toBe('pass');
  });

  test('preserves Flow-owned producer-policy route-back verdicts', async () => {
    const cwd = createWorkspace();
    writeFileSync(
      join(cwd, '.flow', 'config.json'),
      JSON.stringify(
        {
          schema_version: '0.1',
          trusted_producers: { 'quality.tests': { producers: ['veritas'] } },
          gate_overrides: {},
        },
        null,
        2,
      ),
    );
    const flowRunService = new FlowRunService();
    await flowRunService.startRun(cwd, {
      definition: 'test-flow',
      runId: 'run-1',
    });
    const bundleFile = join(cwd, 'bundle.json');
    writeFileSync(
      bundleFile,
      JSON.stringify(
        {
          ...buildSyntheticTrustBundle({
            claimType: 'quality.tests',
            subjectId: 'run-1',
          }),
          producerId: 'veritas',
        },
        null,
        2,
      ),
    );
    await attachEvidence('run-1', {
      cwd,
      gate: 'build-gate',
      file: 'bundle.json',
      kind: 'trust.bundle',
      producer: 'station/command',
    });

    const verdict = await evaluateFlowCompletionGate({
      flowRunService,
      binding: { runId: 'run-1', definitionId: 'test-flow', cwd },
      provider: 'claude',
      threadId: 'thread-1',
    });

    expect(verdict.verdict).not.toBe('pass');
    expect(verdict.missing).toEqual(['tests-passed']);
  });

  test('preserves owner recovery fields after an earlier producer-policy refusal', async () => {
    const cwd = createWorkspace();
    // Two steps: `build` passes on untrusted evidence (pin violation), then
    // `verify` routes back for missing evidence.
    writeFileSync(
      join(cwd, '.flow', 'definitions', 'two-step.json'),
      JSON.stringify(
        {
          id: 'two-step',
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
                  description: 'Tests pass.',
                  bundle_claim: {
                    claimType: 'quality.tests',
                    accepted_statuses: ['assumed'],
                  },
                },
              ],
            },
            'verify-gate': {
              step: 'verify',
              expects: [
                {
                  id: 'verified',
                  kind: 'trust.bundle',
                  required: true,
                  description: 'Verified.',
                  bundle_claim: {
                    claimType: 'quality.verified',
                    accepted_statuses: ['assumed'],
                  },
                },
              ],
              on_route_back: { missing_evidence: 'build', default: 'build' },
              route_back_policy: { max_attempts: 3, on_exceeded: 'block' },
            },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(cwd, '.flow', 'config.json'),
      JSON.stringify(
        {
          schema_version: '0.1',
          trusted_producers: { 'quality.tests': { producers: ['veritas'] } },
          gate_overrides: {},
        },
        null,
        2,
      ),
    );
    const flowRunService = new FlowRunService();
    await flowRunService.startRun(cwd, {
      definition: 'two-step',
      runId: 'run-1',
    });
    writeFileSync(
      join(cwd, 'bundle.json'),
      JSON.stringify(
        {
          ...buildSyntheticTrustBundle({
            claimType: 'quality.tests',
            subjectId: 'run-1',
          }),
          producerId: 'veritas',
        },
        null,
        2,
      ),
    );
    await attachEvidence('run-1', {
      cwd,
      gate: 'build-gate',
      file: 'bundle.json',
      kind: 'trust.bundle',
      producer: 'veritas',
    });

    const verdict = await evaluateFlowCompletionGate({
      flowRunService,
      binding: { runId: 'run-1', definitionId: 'two-step', cwd },
      provider: 'claude',
      threadId: 'thread-1',
    });

    expect(verdict.verdict).not.toBe('pass');
    expect(verdict.missing).toEqual(['verified']);
    expect(verdict.nextAction).toBeTruthy();
  });

  test('an evaluation failure fails closed', async () => {
    const cwd = createWorkspace();
    const flowRunService = new FlowRunService();
    await flowRunService.startRun(cwd, {
      definition: 'test-flow',
      runId: 'run-1',
    });
    writeFileSync(
      join(cwd, 'bundle.json'),
      JSON.stringify(
        {
          ...buildSyntheticTrustBundle({
            claimType: 'quality.tests',
            subjectId: 'run-1',
          }),
          producerId: 'veritas',
        },
        null,
        2,
      ),
    );
    await flowRunService.attachEvidence(cwd, 'run-1', {
      gate: 'build-gate',
      file: 'bundle.json',
      kind: 'trust.bundle',
      producer: 'anyone',
    });

    const reportCalls: string[] = [];
    const realGetReport = flowRunService.getReport.bind(flowRunService);
    flowRunService.getReport = async (...args) => {
      reportCalls.push(args[1]);
      return realGetReport(...args);
    };

    flowRunService.evaluate = async () => {
      throw new Error('Flow evaluation failed');
    };
    await expect(
      evaluateFlowCompletionGate({
        flowRunService,
        binding: { runId: 'run-1', definitionId: 'test-flow', cwd },
        provider: 'claude',
        threadId: 'thread-1',
      }),
    ).rejects.toThrow('Flow evaluation failed');
    expect(reportCalls).toEqual([]);
  });

  test('a trusted producer reaches the pass verdict unimpeded', async () => {
    const cwd = createWorkspace();
    writeFileSync(
      join(cwd, '.flow', 'config.json'),
      JSON.stringify(
        {
          schema_version: '0.1',
          trusted_producers: { 'quality.tests': { producers: ['veritas'] } },
          gate_overrides: {},
        },
        null,
        2,
      ),
    );
    const flowRunService = new FlowRunService();
    await flowRunService.startRun(cwd, {
      definition: 'test-flow',
      runId: 'run-1',
    });
    writeFileSync(
      join(cwd, 'bundle.json'),
      JSON.stringify(
        {
          ...buildSyntheticTrustBundle({
            claimType: 'quality.tests',
            subjectId: 'run-1',
          }),
          producerId: 'veritas',
        },
        null,
        2,
      ),
    );
    await flowRunService.attachEvidence(cwd, 'run-1', {
      gate: 'build-gate',
      file: 'bundle.json',
      kind: 'trust.bundle',
      producer: 'veritas',
    });

    const verdict = await evaluateFlowCompletionGate({
      flowRunService,
      binding: { runId: 'run-1', definitionId: 'test-flow', cwd },
      provider: 'claude',
      threadId: 'thread-1',
    });

    expect(verdict.verdict).toBe('pass');
    expect(verdict.reportPaths).toEqual({
      json: '.kontourai/flow/runs/run-1/report.json',
      markdown: '.kontourai/flow/runs/run-1/report.md',
    });
  });
});
