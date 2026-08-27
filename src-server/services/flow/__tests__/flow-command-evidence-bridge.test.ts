import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  flowToolEvidenceSpooled: { add: vi.fn() },
  flowToolEvidenceAttached: { add: vi.fn() },
}));

const { FlowCommandEvidenceBridge } = await import(
  '../flow-command-evidence-bridge.js'
);
const { flowToolEvidenceAttached } = await import(
  '../../../telemetry/metrics.js'
);
const attachedCounter = flowToolEvidenceAttached.add as unknown as ReturnType<
  typeof vi.fn
>;

import type {
  CommandEvidenceRoute,
  CommandEvidenceRoutingPolicy,
  SpooledCommand,
} from '../../evidence/command-evidence-routing-policy.js';

const BINDING = { runId: 'run-1', definitionId: 'test-flow', cwd: '/ws' };

function spooled(overrides: Partial<SpooledCommand> = {}): SpooledCommand {
  return {
    toolName: 'Bash',
    toolCallId: 'call-1',
    command: 'npm test',
    output: 'all green',
    status: 'success',
    exitCode: 0,
    timedOut: false,
    durationMs: 10,
    outputTruncated: false,
    ...overrides,
  };
}

function policyRouting(
  route: CommandEvidenceRoute | null,
): CommandEvidenceRoutingPolicy {
  return { route: vi.fn().mockReturnValue(route) };
}

describe('FlowCommandEvidenceBridge', () => {
  let getRun: ReturnType<typeof vi.fn>;
  let attachCommandEvidenceResult: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getRun = vi.fn().mockResolvedValue({
      definition: { id: 'test-flow', gates: {} },
      openGates: [{ id: 'build-gate', step: 'build' }],
    });
    attachCommandEvidenceResult = vi.fn().mockResolvedValue({});
  });

  function makeBridge(policy: CommandEvidenceRoutingPolicy) {
    const flowRunService = {
      getRun,
      attachCommandEvidenceResult,
    } as unknown as ConstructorParameters<
      typeof FlowCommandEvidenceBridge
    >[0]['flowRunService'];
    return new FlowCommandEvidenceBridge({ flowRunService, policy });
  }

  test('spool then attach routes to the policy gate and clears the spool', async () => {
    const route: CommandEvidenceRoute = {
      gateId: 'build-gate',
      claimType: 'quality.tests',
      label: 'npm test',
    };
    const bridge = makeBridge(policyRouting(route));
    bridge.spool('thread-1', spooled());
    expect(bridge.hasSpooled('thread-1')).toBe(true);

    const outcomes = await bridge.attachSpooledEvidence(BINDING, 'thread-1');

    expect(attachCommandEvidenceResult).toHaveBeenCalledWith(
      '/ws',
      'run-1',
      expect.objectContaining({ command: 'npm test', exitCode: 0 }),
      expect.objectContaining({
        gate: 'build-gate',
        claimType: 'quality.tests',
        label: 'npm test',
        producer: 'station/command-auto',
      }),
    );
    expect(outcomes).toEqual([{ attached: true, route }]);
    expect(bridge.hasSpooled('thread-1')).toBe(false);
  });

  /**
   * station#4237: a command Station only OBSERVED carries no exit code and no
   * duration. The bridge must forward the runtime's status (the one measured
   * fact) rather than let the null exit code read as a failure — and its
   * telemetry verdict must agree with the durable claim the attach writes.
   */
  test('forwards the observed runtime status and claims no exit code or duration', async () => {
    const route: CommandEvidenceRoute = {
      gateId: 'build-gate',
      claimType: 'quality.tests',
      label: 'npm test',
    };
    const bridge = makeBridge(policyRouting(route));
    bridge.spool(
      'thread-1',
      spooled({ status: 'success', exitCode: null, durationMs: null }),
    );

    await bridge.attachSpooledEvidence(BINDING, 'thread-1');

    expect(attachCommandEvidenceResult).toHaveBeenCalledWith(
      '/ws',
      'run-1',
      {
        command: 'npm test',
        output: 'all green',
        exitCode: null,
        timedOut: false,
        durationMs: null,
        outputTruncated: false,
        observedStatus: 'success',
      },
      expect.objectContaining({ producer: 'station/command-auto' }),
    );
    expect(attachedCounter.mock.calls.at(-1)).toEqual([
      1,
      { gate: 'build-gate', claim_type: 'quality.tests', status: 'pass' },
    ]);
  });

  test('counts an observed error as a failing attach, not a pass', async () => {
    const route: CommandEvidenceRoute = {
      gateId: 'build-gate',
      claimType: 'quality.tests',
      label: 'npm test',
    };
    const bridge = makeBridge(policyRouting(route));
    bridge.spool(
      'thread-1',
      spooled({ status: 'error', exitCode: null, durationMs: null }),
    );

    await bridge.attachSpooledEvidence(BINDING, 'thread-1');

    expect(attachCommandEvidenceResult).toHaveBeenCalledWith(
      '/ws',
      'run-1',
      expect.objectContaining({ exitCode: null, observedStatus: 'error' }),
      expect.anything(),
    );
    expect(attachedCounter.mock.calls.at(-1)).toEqual([
      1,
      { gate: 'build-gate', claim_type: 'quality.tests', status: 'fail' },
    ]);
  });

  test('does not attach when the policy declines to route', async () => {
    const bridge = makeBridge(policyRouting(null));
    bridge.spool('thread-1', spooled({ command: 'git status' }));

    const outcomes = await bridge.attachSpooledEvidence(BINDING, 'thread-1');

    expect(attachCommandEvidenceResult).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ attached: false, reason: 'no-route' }]);
    expect(bridge.hasSpooled('thread-1')).toBe(false);
  });

  test('is fail-soft when an attach throws and still clears the spool', async () => {
    const route: CommandEvidenceRoute = {
      gateId: 'build-gate',
      claimType: 'quality.tests',
      label: 'npm test',
    };
    attachCommandEvidenceResult.mockRejectedValueOnce(new Error('disk full'));
    const bridge = makeBridge(policyRouting(route));
    bridge.spool('thread-1', spooled());

    const outcomes = await bridge.attachSpooledEvidence(BINDING, 'thread-1');

    expect(outcomes).toEqual([{ attached: false, route, reason: 'disk full' }]);
    expect(bridge.hasSpooled('thread-1')).toBe(false);
  });

  test('returns empty when nothing is spooled', async () => {
    const bridge = makeBridge(policyRouting(null));
    const outcomes = await bridge.attachSpooledEvidence(BINDING, 'thread-x');
    expect(outcomes).toEqual([]);
    expect(getRun).not.toHaveBeenCalled();
  });
});
