import type {
  CanonicalRuntimeEvent,
  FlowGateVerdictEvent,
} from '@kontourai/station-contracts/runtime-events';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import type { AgentPolicyService } from '../../agents/agent-policy-service.js';
import type { WorkflowSidecarService } from '../../evidence/workflow-sidecar-service.js';
import type { FlowRunService } from '../../flow/flow-run-service.js';
import { evaluateFlowCompletionGate } from '../../flow/orchestration-flow-gate.js';
import {
  FlowPolicySidecar,
  type FlowPolicySidecarDeps,
} from '../flow-policy-sidecar.js';

// Only the evaluation is stubbed; the binding resolvers stay REAL so these
// pins exercise the sidecar's own event-history reads. The specifier must
// resolve to the same module id the SUT imports ('../flow/…' from the
// orchestration dir) or the stub silently misses.
vi.mock('../../flow/orchestration-flow-gate.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../flow/orchestration-flow-gate.js')
    >();
  return { ...actual, evaluateFlowCompletionGate: vi.fn() };
});

/**
 * Unit pins for the C15 extraction (epic archive#4024, archive#4218) — the
 * contracts the service suite proved it CANNOT discriminate (each ran green
 * under injection at the service level, or has no service-level fixture):
 *
 * 1. Gate ORDER inside `prepareCompletion`: the flow gate throws BEFORE the
 *    policy stop gate runs. Every service fixture binds one gate or the
 *    other, never both with a failing flow verdict.
 * 2. The deferred `apply` reads the REVALIDATED events handed to it, not
 *    the pre-gate `input.events` it closed over.
 * 3. The spool completion arms: success spools `output`; error spools
 *    `error ?? output`. Neither claims an exit code or a duration — Station
 *    observed these calls, it did not run them (archive#4237). And the I12
 *    inverse: no
 *    veritasReadinessService (every fixture here omits it) still spools —
 *    the command-evidence bridge needs only flowRunService.
 * 4. The cached-FALSY pairs: `isFlowBoundThread` caches `false` and
 *    `resolvePolicyCwd` caches `null` (the `!== undefined` reads), so the
 *    event store is consulted once per thread — and the two seam accessors
 *    are what drop those entries.
 */

const THREAD = 'unit-thread';

function flowAttached(threadId = THREAD): CanonicalRuntimeEvent {
  return {
    eventId: 'evt-flow-attached',
    provider: 'claude',
    threadId,
    createdAt: '2026-08-01T00:00:00.000Z',
    method: 'flow.run-attached',
    runId: 'run-1',
    definitionId: 'def-1',
    cwd: '/ws',
  } as unknown as CanonicalRuntimeEvent;
}

function policyAttached(threadId = THREAD): CanonicalRuntimeEvent {
  return {
    eventId: 'evt-policy-attached',
    provider: 'claude',
    threadId,
    createdAt: '2026-08-01T00:00:00.000Z',
    method: 'policy.hooks-attached',
    cwd: '/ws',
    profile: 'standard',
  } as unknown as CanonicalRuntimeEvent;
}

function verdictEvent(
  verdict: 'pass' | 'fail',
  nextAction?: string,
): FlowGateVerdictEvent {
  return {
    eventId: `evt-verdict-${verdict}`,
    provider: 'claude',
    threadId: THREAD,
    createdAt: '2026-08-01T00:00:01.000Z',
    method: 'flow.gate-verdict',
    verdict,
    gateId: 'gate-1',
    stepId: 'step-1',
    ...(nextAction ? { nextAction } : {}),
  } as unknown as FlowGateVerdictEvent;
}

function makeDeps(overrides: Partial<FlowPolicySidecarDeps> = {}) {
  const deps: FlowPolicySidecarDeps = {
    flowRunService: () => ({}) as unknown as FlowRunService,
    // Absent on purpose in EVERY fixture (contract 3's I12 inverse): the
    // readiness bridge is missing while spooling still works.
    veritasReadinessService: () => undefined,
    agentPolicyService: () => undefined,
    workflowSidecarService: () => undefined,
    publishEvent: vi.fn(),
    readSession: vi.fn(async () => null),
    runtimeKindFor: () => 'connected',
    engineExecutionForAdapter: () => 'external',
    latestEventPayloadByMethod: vi.fn(() => undefined),
    logger: { debug: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return deps;
}

const adapter = {} as ProviderAdapterShape;

function completionInput(events: CanonicalRuntimeEvent[]) {
  return {
    threadId: THREAD,
    provider: 'claude',
    events,
    fromState: 'running',
  } as unknown as Parameters<FlowPolicySidecar['prepareCompletion']>[0];
}

describe('FlowPolicySidecar (unit pins)', () => {
  it('a failing flow gate throws before the policy stop gate can run', async () => {
    const checkStop = vi.fn(async () => ({
      verdict: 'pass' as const,
      warnings: [],
      strict: false,
    }));
    const deps = makeDeps({
      agentPolicyService: () =>
        ({ checkStop }) as unknown as AgentPolicyService,
    });
    vi.mocked(evaluateFlowCompletionGate).mockResolvedValueOnce(
      verdictEvent('fail', 'record the evidence'),
    );
    const sidecar = new FlowPolicySidecar(deps);
    // BOTH bindings present: without the policy binding this pin has no
    // power (checkStop would stay uncalled under either ordering).
    await expect(
      sidecar.prepareCompletion(
        completionInput([flowAttached(), policyAttached()]),
      ),
    ).rejects.toThrow('Flow gate verdict: fail — record the evidence');
    expect(checkStop).not.toHaveBeenCalled();
    expect(deps.publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'flow.gate-verdict', verdict: 'fail' }),
    );
  });

  it('a passing flow gate reaches the policy stop gate (order-pin power arm)', async () => {
    const checkStop = vi.fn(async () => ({
      verdict: 'pass' as const,
      warnings: [],
      strict: false,
    }));
    const deps = makeDeps({
      agentPolicyService: () =>
        ({ checkStop }) as unknown as AgentPolicyService,
    });
    vi.mocked(evaluateFlowCompletionGate).mockResolvedValueOnce(
      verdictEvent('pass'),
    );
    const sidecar = new FlowPolicySidecar(deps);
    await sidecar.prepareCompletion(
      completionInput([flowAttached(), policyAttached()]),
    );
    expect(checkStop).toHaveBeenCalledOnce();
  });

  it('the deferred apply reads the REVALIDATED events, not the pre-gate input', async () => {
    // A structurally complete WorkflowState: the publish half of the pin
    // dies silently in the fail-open catch if the event builder throws on a
    // partial state (it reads state.next_action.status).
    const transition = vi.fn(() => ({
      task_slug: 'demo-task',
      status: 'done',
      phase: 'delivery',
      next_action: { status: 'none', summary: '' },
    }));
    const deps = makeDeps({
      workflowSidecarService: () =>
        ({ transition }) as unknown as WorkflowSidecarService,
    });
    vi.mocked(evaluateFlowCompletionGate).mockResolvedValueOnce(
      verdictEvent('pass'),
    );
    const sidecar = new FlowPolicySidecar(deps);
    // input.events carries NO workflow binding: if apply read the closed-over
    // input, the transition below could never fire.
    const { apply } = await sidecar.prepareCompletion(
      completionInput([flowAttached()]),
    );
    expect(transition).not.toHaveBeenCalled();
    apply([
      {
        eventId: 'evt-workflow',
        provider: 'claude',
        threadId: THREAD,
        createdAt: '2026-08-01T00:00:02.000Z',
        method: 'workflow.state-changed',
        taskSlug: 'demo-task',
        cwd: '/ws',
        ownership: 'station-owned',
      } as unknown as CanonicalRuntimeEvent,
    ]);
    expect(transition).toHaveBeenCalledWith(
      '/ws',
      'demo-task',
      expect.anything(),
      { trigger: 'completion' },
    );
    expect(deps.publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'workflow.state-changed' }),
    );
  });

  function spoolSpy(sidecar: FlowPolicySidecar) {
    const bridge = (
      sidecar as unknown as {
        commandEvidenceBridge: { spool(...args: unknown[]): void };
      }
    ).commandEvidenceBridge;
    expect(bridge).toBeDefined();
    return vi.spyOn(bridge, 'spool');
  }

  function toolStarted(command: string): CanonicalRuntimeEvent {
    return {
      eventId: 'evt-tool-start',
      provider: 'claude',
      threadId: THREAD,
      createdAt: '2026-08-01T00:00:03.000Z',
      method: 'tool.started',
      toolName: 'bash',
      toolCallId: 'call-1',
      arguments: { command },
    } as unknown as CanonicalRuntimeEvent;
  }

  it('spools a successful command completion with its output and exit code 0', () => {
    const deps = makeDeps({
      latestEventPayloadByMethod: vi.fn(() => flowAttached()),
    });
    const sidecar = new FlowPolicySidecar(deps);
    const spool = spoolSpy(sidecar);
    sidecar.spoolCommandEvidence(toolStarted('npm test'));
    sidecar.spoolCommandEvidence({
      eventId: 'evt-tool-done',
      provider: 'claude',
      threadId: THREAD,
      createdAt: '2026-08-01T00:00:04.000Z',
      method: 'tool.completed',
      toolName: 'bash',
      toolCallId: 'call-1',
      status: 'success',
      output: 'all green',
    } as unknown as CanonicalRuntimeEvent);
    expect(spool).toHaveBeenCalledWith(
      THREAD,
      expect.objectContaining({
        command: 'npm test',
        toolCallId: 'call-1',
        output: 'all green',
        status: 'success',
        // Observed, not executed: no exit code, no duration is claimed
        // (archive#4237). `status` is the one execution fact Station has,
        // and the durable pass/fail claim derives from it.
        exitCode: null,
        durationMs: null,
      }),
    );
  });

  it('spools an errored completion preferring `error` over `output`, exit code 1', () => {
    const deps = makeDeps({
      latestEventPayloadByMethod: vi.fn(() => flowAttached()),
    });
    const sidecar = new FlowPolicySidecar(deps);
    const spool = spoolSpy(sidecar);
    sidecar.spoolCommandEvidence(toolStarted('npm test'));
    sidecar.spoolCommandEvidence({
      eventId: 'evt-tool-done',
      provider: 'claude',
      threadId: THREAD,
      createdAt: '2026-08-01T00:00:04.000Z',
      method: 'tool.completed',
      toolName: 'bash',
      toolCallId: 'call-1',
      status: 'error',
      error: { message: 'boom' },
      output: 'partial output the error must shadow',
    } as unknown as CanonicalRuntimeEvent);
    expect(spool).toHaveBeenCalledWith(
      THREAD,
      expect.objectContaining({
        output: '{"message":"boom"}',
        status: 'error',
        // The honesty fix L8's note anticipated landed as archive#4237: the
        // exit code is no longer synthesized from `status`, so this pin now
        // asserts the absence it used to ratchet. The load-bearing half of
        // the assertion remains the `error ?? output` preference above.
        exitCode: null,
        durationMs: null,
      }),
    );
  });

  it('reports truncation from the adapter receipt, not as a flat false', () => {
    // archive#4237 review M1: asserting `outputTruncated: false` recorded a
    // head-sliced output as complete, so the evidence file's "tail" was
    // actually the beginning of the run. The adapters that truncate say so
    // on the event; presence of the receipt IS the truncation.
    const deps = makeDeps({
      latestEventPayloadByMethod: vi.fn(() => flowAttached()),
    });
    const sidecar = new FlowPolicySidecar(deps);
    const spool = spoolSpy(sidecar);
    sidecar.spoolCommandEvidence(toolStarted('npm test'));
    sidecar.spoolCommandEvidence({
      eventId: 'evt-tool-done',
      provider: 'claude',
      threadId: THREAD,
      createdAt: '2026-08-01T00:00:04.000Z',
      method: 'tool.completed',
      toolName: 'bash',
      toolCallId: 'call-1',
      status: 'success',
      output: 'head slice only',
      outputReceipt: {
        truncated: true,
        reasons: ['bytes'],
        retainedBytes: 2000,
        omittedBytesAtLeast: 48_000,
        omittedUpdates: 0,
        strategy: 'utf8-tail',
        fullOutput: 'unavailable',
      },
    } as unknown as CanonicalRuntimeEvent);
    expect(spool).toHaveBeenCalledWith(
      THREAD,
      expect.objectContaining({ outputTruncated: true }),
    );
  });

  it('reports no truncation when the adapter attached no receipt', () => {
    // The discriminating pair: without this, a bug that hardcodes `true`
    // would pass the test above.
    const deps = makeDeps({
      latestEventPayloadByMethod: vi.fn(() => flowAttached()),
    });
    const sidecar = new FlowPolicySidecar(deps);
    const spool = spoolSpy(sidecar);
    sidecar.spoolCommandEvidence(toolStarted('npm test'));
    sidecar.spoolCommandEvidence({
      eventId: 'evt-tool-done',
      provider: 'claude',
      threadId: THREAD,
      createdAt: '2026-08-01T00:00:04.000Z',
      method: 'tool.completed',
      toolName: 'bash',
      toolCallId: 'call-1',
      status: 'success',
      output: 'complete output',
    } as unknown as CanonicalRuntimeEvent);
    expect(spool).toHaveBeenCalledWith(
      THREAD,
      expect.objectContaining({ outputTruncated: false }),
    );
  });

  it('caches a FALSE flow-bound verdict; forgetFlowBinding drops it', () => {
    const latest = vi.fn(() => undefined);
    const deps = makeDeps({ latestEventPayloadByMethod: latest });
    const sidecar = new FlowPolicySidecar(deps);
    const spool = spoolSpy(sidecar);
    sidecar.spoolCommandEvidence(toolStarted('npm test'));
    sidecar.spoolCommandEvidence(toolStarted('npm test'));
    // One store read for two calls: `false` was CACHED, not re-derived —
    // the `!== undefined` read, which a truthy-cache regression breaks.
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledWith(THREAD, 'flow.run-attached');
    expect(spool).not.toHaveBeenCalled();
    sidecar.forgetFlowBinding(THREAD);
    sidecar.spoolCommandEvidence(toolStarted('npm test'));
    expect(latest).toHaveBeenCalledTimes(2);
  });

  it('builds the readiness bridge only when BOTH services exist (I12)', () => {
    // Downstream code reads `readinessBridge` presence as "Veritas is
    // configured" (the auto-attach path guards on it) — flattening the
    // ctor conditional to flowRunService-only builds a lying non-null
    // bridge holding an undefined readiness service. The service suite
    // cannot see this: its only readiness fixtures wire a real service
    // (the 'not Veritas-configured' test unconfigures the WORKSPACE, not
    // the option). The command-evidence bridge is the deliberate inverse:
    // flowRunService alone must suffice (every fixture in this file
    // already proves spooling works with no readiness service).
    const bridges = (sidecar: FlowPolicySidecar) =>
      sidecar as unknown as {
        readinessBridge: unknown;
        commandEvidenceBridge: unknown;
      };
    const flowOnly = new FlowPolicySidecar(makeDeps());
    expect(bridges(flowOnly).readinessBridge).toBeUndefined();
    expect(bridges(flowOnly).commandEvidenceBridge).toBeDefined();
    const both = new FlowPolicySidecar(
      makeDeps({
        veritasReadinessService: () =>
          ({}) as unknown as ReturnType<
            FlowPolicySidecarDeps['veritasReadinessService']
          > &
            object,
      }),
    );
    expect(bridges(both).readinessBridge).toBeDefined();
    // The OTHER half of the conjunction (review L3): readiness present,
    // flow run service absent. Narrowing the guard to `if (readinessService)`
    // does NOT compile — `flowRunService` is possibly-undefined and the
    // bridge requires it, so the type system already derives this half.
    // Probed: only the CAST form (`flowRunService as FlowRunService`)
    // compiles, and this fixture reds it. Kept for that case and to state
    // the contract; do not describe it as covering the plain narrowing.
    const readinessOnly = new FlowPolicySidecar(
      makeDeps({
        flowRunService: () => undefined,
        veritasReadinessService: () =>
          ({}) as unknown as ReturnType<
            FlowPolicySidecarDeps['veritasReadinessService']
          > &
            object,
      }),
    );
    expect(bridges(readinessOnly).readinessBridge).toBeUndefined();
    const neither = new FlowPolicySidecar(
      makeDeps({ flowRunService: () => undefined }),
    );
    expect(bridges(neither).readinessBridge).toBeUndefined();
    expect(bridges(neither).commandEvidenceBridge).toBeUndefined();
  });

  it('caches a NULL policy cwd; forgetPolicyBinding drops it', () => {
    const latest = vi.fn(() => undefined);
    const isWriteTool = vi.fn(() => true);
    const deps = makeDeps({
      latestEventPayloadByMethod: latest,
      agentPolicyService: () =>
        ({ isWriteTool }) as unknown as AgentPolicyService,
    });
    const sidecar = new FlowPolicySidecar(deps);
    const started = {
      eventId: 'evt-tool-start',
      provider: 'claude',
      threadId: THREAD,
      createdAt: '2026-08-01T00:00:03.000Z',
      method: 'tool.started',
      toolName: 'write_file',
      toolCallId: 'call-1',
      arguments: { path: '/ws/biome.json' },
    } as unknown as CanonicalRuntimeEvent;
    sidecar.applyPostHocToolPolicies(adapter, started);
    sidecar.applyPostHocToolPolicies(adapter, started);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(latest).toHaveBeenCalledWith(THREAD, 'policy.hooks-attached');
    // Deliberately NOT asserting that `isWriteTool` went uncalled (review
    // L7): hoisting that cheap filter above the cwd lookup is a
    // behavior-neutral refactor, and this test's subject is the cache.
    sidecar.forgetPolicyBinding(THREAD);
    sidecar.applyPostHocToolPolicies(adapter, started);
    expect(latest).toHaveBeenCalledTimes(2);
  });
});
