/**
 * Unit tests for the platform-mutation gate (S3 item 4).
 *
 * The run-bound cases run against the REAL @kontourai/flow library through
 * FlowRunService in temp-dir workspaces — no mocked Flow — so the audit
 * evidence attachment is proven against the published contract.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlatformMutationEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildSyntheticTrustBundle } from '../trust-bundle.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  policyChecks: { add: vi.fn() },
  platformMutations: { add: vi.fn() },
  flowRunsStarted: { add: vi.fn() },
  flowEvidenceAttached: { add: vi.fn() },
  flowEvidenceAutoSuperseded: { add: vi.fn() },
  flowGateEvaluations: { add: vi.fn() },
  flowExceptionsAccepted: { add: vi.fn() },
  flowReportsGenerated: { add: vi.fn() },
  flowRunConsoleProjections: { add: vi.fn() },
}));

const { AgentPolicyService } = await import(
  '../../agents/agent-policy-service.js'
);
const { FlowRunService } = await import('../../flow/flow-run-service.js');
const { policyChecks } = await import('../../../telemetry/metrics.js');
const {
  PlatformMutationGate,
  setPlatformMutationGateForTesting,
  summarizeToolArgs,
  wrapPlatformMutationGatedTools,
} = await import('../platform-mutation-gate.js');

/** Minimal gated delivery definition (one step, one gate). */
const GATED_DEFINITION = {
  id: 'test-delivery',
  version: '1',
  steps: [{ id: 'implement', next: null }],
  gates: {
    'implement-gate': {
      step: 'implement',
      expects: [
        {
          id: 'static-checks',
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
  },
};

const tempDirs: string[] = [];

afterEach(() => {
  setPlatformMutationGateForTesting(null);
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempWorkspace(prefix = 'platform-gate-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Policy-opted workspace: has `.flow-agents/`. */
function optedWorkspace(): string {
  const dir = tempWorkspace();
  mkdirSync(join(dir, '.flow-agents'), { recursive: true });
  return dir;
}

/** Opted workspace with a Flow definition installed. */
function optedFlowWorkspace(): string {
  const dir = optedWorkspace();
  const definitionsDir = join(dir, '.flow', 'definitions');
  mkdirSync(definitionsDir, { recursive: true });
  writeFileSync(
    join(definitionsDir, 'test-delivery.json'),
    JSON.stringify(GATED_DEFINITION, null, 2),
  );
  return dir;
}

function createPolicyService(env: Record<string, string | undefined> = {}) {
  return new AgentPolicyService({
    // Engine root irrelevant for the platform-mutation class (Station-side),
    // but keep resolution deterministic.
    env: { SA_HOOK_PROFILE: 'standard', ...env } as NodeJS.ProcessEnv,
  });
}

interface GateHarness {
  gate: InstanceType<typeof PlatformMutationGate>;
  events: PlatformMutationEvent[];
}

function createGate(options: {
  cwd: string;
  env?: Record<string, string | undefined>;
  flowRunService?: InstanceType<typeof FlowRunService>;
}): GateHarness {
  const events: PlatformMutationEvent[] = [];
  const gate = new PlatformMutationGate({
    policyService: createPolicyService(options.env),
    flowRunService: options.flowRunService,
    workspaceCwd: options.cwd,
    emitEvent: (event) => events.push(event),
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  return { gate, events };
}

function makeTool(name: string, executeImpl?: () => unknown) {
  const execute = vi.fn(
    async (_args?: unknown) => executeImpl?.() ?? { ok: true, name },
  );
  return { tool: { name, description: name, execute }, execute };
}

function wrapWithGate(
  harness: GateHarness,
  tool: { name: string; execute: any },
) {
  setPlatformMutationGateForTesting(harness.gate);
  const [wrapped] = wrapPlatformMutationGatedTools([tool], {
    agentSlug: 'default',
    toolId: 'station-control',
  });
  return wrapped;
}

describe('classification at the wrapper', () => {
  test('read-only tools are returned untouched', () => {
    const { tool } = makeTool('station-control_list_agents');
    const [wrapped] = wrapPlatformMutationGatedTools([tool], {
      agentSlug: 'default',
      toolId: 'station-control',
    });
    expect(wrapped).toBe(tool);
  });

  test('tools of other integrations are returned untouched', () => {
    const { tool } = makeTool('create_agent');
    const [wrapped] = wrapPlatformMutationGatedTools([tool], {
      agentSlug: 'default',
      toolId: 'github',
    });
    expect(wrapped).toBe(tool);
  });

  test('mutating tools get a gate-wrapped execute', () => {
    const { tool } = makeTool('station-control_create_agent');
    const [wrapped] = wrapPlatformMutationGatedTools([tool], {
      agentSlug: 'default',
      toolId: 'station-control',
    });
    expect(wrapped).not.toBe(tool);
    expect(wrapped.execute).not.toBe(tool.execute);
  });
});

describe('non-opted workspace (zero change)', () => {
  test('mutating tool executes with no events and no audit', async () => {
    const harness = createGate({ cwd: tempWorkspace() });
    const { tool, execute } = makeTool('station-control_create_agent');
    const wrapped = wrapWithGate(harness, tool);

    const result = await wrapped.execute!({ name: 'A', slug: 'a' });
    expect(result).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual([]);
  });
});

describe('opted workspace, ungated (no active run)', () => {
  test('default policy profile: warns, execution proceeds, event recorded', async () => {
    const cwd = optedWorkspace();
    const harness = createGate({ cwd });
    const { tool, execute } = makeTool('station-control_update_config');
    const wrapped = wrapWithGate(harness, tool);

    const result = await wrapped.execute!({ updates: { theme: 'dark' } });
    expect(result).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      method: 'platform.mutation',
      tool: 'update_config',
      outcome: 'warned',
      decision: 'warn',
      profile: 'standard',
      cwd,
      agentSlug: 'default',
    });
    expect(harness.events[0].reason).toMatch(/ungated/i);
    expect(harness.events[0].runId).toBeUndefined();
  });

  test('strict profile: BLOCKS with the reason as the thrown tool error', async () => {
    const cwd = optedWorkspace();
    const harness = createGate({ cwd, env: { SA_HOOK_PROFILE: 'strict' } });
    const { tool, execute } = makeTool('station-control_delete_agent');
    const wrapped = wrapWithGate(harness, tool);

    await expect(wrapped.execute!({ slug: 'victim' })).rejects.toThrow(
      /BLOCKED: platform mutation 'delete_agent'/,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      outcome: 'blocked',
      decision: 'block',
      profile: 'strict',
      tool: 'delete_agent',
    });
  });

  test('failed execution records a failed audit and rethrows', async () => {
    const cwd = optedWorkspace();
    const harness = createGate({ cwd });
    const { tool } = makeTool('station-control_install_plugin', () => {
      throw new Error('install exploded');
    });
    const wrapped = wrapWithGate(harness, tool);

    await expect(wrapped.execute!({ source: './x' })).rejects.toThrow(
      'install exploded',
    );
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      outcome: 'failed',
      tool: 'install_plugin',
    });
  });

  test('SA_DISABLED_HOOKS=pre:platform-mutation disables the gate', async () => {
    const cwd = optedWorkspace();
    const harness = createGate({
      cwd,
      env: { SA_DISABLED_HOOKS: 'pre:platform-mutation' },
    });
    const { tool, execute } = makeTool('station-control_create_agent');
    const wrapped = wrapWithGate(harness, tool);

    await wrapped.execute!({ name: 'A', slug: 'a' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual([]);
  });

  test('minimal profile disables the gate', async () => {
    const cwd = optedWorkspace();
    const harness = createGate({ cwd, env: { SA_HOOK_PROFILE: 'minimal' } });
    const { tool, execute } = makeTool('station-control_create_agent');
    const wrapped = wrapWithGate(harness, tool);

    await wrapped.execute!({ name: 'A', slug: 'a' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual([]);
  });

  test.each([
    ['SA_DISABLED_HOOKS', { SA_DISABLED_HOOKS: 'pre:platform-mutation' }],
    ['minimal profile', { SA_HOOK_PROFILE: 'minimal' }],
  ])('%s remains inactive before a failing Flow lookup', async (_name, env) => {
    const cwd = optedWorkspace();
    const listRunsWithDiagnostics = vi.fn(async () => {
      throw new Error('flow enumeration exploded');
    });
    const harness = createGate({
      cwd,
      env,
      flowRunService: { listRunsWithDiagnostics } as any,
    });
    const { tool, execute } = makeTool('station-control_create_agent');
    const wrapped = wrapWithGate(harness, tool);

    await wrapped.execute!({ name: 'A', slug: 'a' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(listRunsWithDiagnostics).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
  });
});

describe('opted workspace with an active gated Flow run', () => {
  test('mutation is allowed and attached to the run as audit evidence', async () => {
    const cwd = optedFlowWorkspace();
    const flowRunService = new FlowRunService();
    await flowRunService.startRun(cwd, {
      definition: 'test-delivery',
      runId: 'audit-run',
    });

    const harness = createGate({ cwd, flowRunService });
    const { tool, execute } = makeTool('station-control_update_skill');
    const wrapped = wrapWithGate(harness, tool);

    const result = await wrapped.execute!({
      name: 'Audit Proof',
      body: 'gated mutation',
    });
    expect(result).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);

    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      outcome: 'allowed',
      decision: 'allow',
      tool: 'update_skill',
      runId: 'audit-run',
      gateId: 'implement-gate',
    });
    expect(policyChecks.add).toHaveBeenCalledTimes(1);
    expect(policyChecks.add).toHaveBeenCalledWith(1, {
      policy: 'platform-mutation',
      outcome: 'allow',
      engine: 'station',
      runtime_kind: 'managed',
    });

    // The audit record landed on the REAL run's evidence manifest without
    // binding (or satisfying) any gate expectation.
    const run = await flowRunService.getRun(cwd, 'audit-run');
    const audit = run.manifest.evidence.find((entry: any) =>
      entry.bundle?.claims?.some(
        (claim: any) => claim.claimType === 'station.platform-mutation',
      ),
    ) as any;
    expect(audit).toBeDefined();
    expect(audit.producer).toBe('station/platform-mutation-gate');
    expect(audit.gate_id).toBe('implement-gate');
    expect(audit.expectation_ids ?? []).toEqual([]);
    expect(run.openGates.map((gate: any) => gate.id)).toContain(
      'implement-gate',
    );

    // Strict mode with a bound run also allows (the run IS the gate).
    const strict = createGate({
      cwd,
      flowRunService,
      env: { SA_HOOK_PROFILE: 'strict' },
    });
    const second = makeTool('station-control_update_agent');
    const strictWrapped = wrapWithGate(strict, second.tool);
    await strictWrapped.execute!({ slug: 'a', name: 'A2' });
    expect(second.execute).toHaveBeenCalledTimes(1);
    expect(strict.events[0]).toMatchObject({
      outcome: 'allowed',
      runId: 'audit-run',
    });
  });

  test('a completed run does not count as an active binding', async () => {
    const cwd = optedFlowWorkspace();
    const flowRunService = new FlowRunService();
    await flowRunService.startRun(cwd, {
      definition: 'test-delivery',
      runId: 'done-run',
    });
    // Satisfy and pass the only gate so the run completes.
    const evidenceFile = join(cwd, 'checks.json');
    writeFileSync(
      evidenceFile,
      JSON.stringify(
        buildSyntheticTrustBundle({
          claimType: 'quality.static-checks',
          subjectId: 'done-run',
        }),
      ),
    );
    await flowRunService.attachEvidence(cwd, 'done-run', {
      gate: 'implement-gate',
      file: 'checks.json',
      kind: 'trust.bundle',
      producer: 'test',
    });
    const evaluated = await flowRunService.evaluate(cwd, 'done-run');
    expect(evaluated.state.status).toBe('completed');

    const harness = createGate({ cwd, flowRunService });
    const { tool } = makeTool('station-control_create_agent');
    const wrapped = wrapWithGate(harness, tool);
    await wrapped.execute!({ name: 'A', slug: 'a' });
    expect(harness.events[0]).toMatchObject({
      outcome: 'warned',
      decision: 'warn',
    });
    expect(harness.events[0].runId).toBeUndefined();
  });
});

describe('gate-evaluation failure contract', () => {
  test('run-resolution errors fail closed with an observable blocked receipt', async () => {
    const cwd = optedWorkspace();
    const events: PlatformMutationEvent[] = [];
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const gate = new PlatformMutationGate({
      policyService: createPolicyService(),
      flowRunService: {
        listRunsWithDiagnostics: async () => {
          throw new Error('flow storage corrupted');
        },
      } as any,
      workspaceCwd: cwd,
      emitEvent: (event) => events.push(event),
      logger,
    });
    const { tool, execute } = makeTool('station-control_create_agent');
    setPlatformMutationGateForTesting(gate);
    const [wrapped] = wrapPlatformMutationGatedTools([tool], {
      agentSlug: 'default',
      toolId: 'station-control',
    });

    await expect(wrapped.execute!({ name: 'A', slug: 'a' })).rejects.toThrow(
      'BLOCKED: platform-mutation policy evaluation failed; mutation was not executed.',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'blocked',
      decision: 'block',
      profile: 'standard',
      tool: 'create_agent',
      cwd,
      agentSlug: 'default',
      reason:
        'BLOCKED: platform-mutation policy evaluation failed; mutation was not executed.',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Platform-mutation gate evaluation failed — blocking mutation',
      expect.objectContaining({ error: 'flow storage corrupted' }),
    );
  });

  test('a corrupt Flow run location blocks without leaking its diagnostic', async () => {
    const cwd = optedFlowWorkspace();
    const flowRunService = new FlowRunService();
    // This is the real on-disk incomplete-run shape Flow reports through
    // listRunsWithDiagnostics while listRuns silently omits it.
    mkdirSync(join(cwd, '.kontourai', 'flow', 'runs', 'half-written'), {
      recursive: true,
    });
    const harness = createGate({ cwd, flowRunService });
    const { tool, execute } = makeTool('station-control_create_agent');
    const wrapped = wrapWithGate(harness, tool);

    await expect(wrapped.execute!({ name: 'A', slug: 'a' })).rejects.toThrow(
      'BLOCKED: platform-mutation policy evaluation failed; mutation was not executed.',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]).toMatchObject({
      outcome: 'blocked',
      decision: 'block',
      tool: 'create_agent',
      reason:
        'BLOCKED: platform-mutation policy evaluation failed; mutation was not executed.',
    });
    expect(JSON.stringify(harness.events[0])).not.toContain('half-written');
  });
});

describe('summarizeToolArgs', () => {
  test('redacts secret-like keys and truncates long payloads', () => {
    const summary = summarizeToolArgs({
      name: 'p',
      config: { apiKey: 'sk-123', region: 'us-east-1' },
      env: { MY_TOKEN: 'abc' },
    });
    expect(summary).toContain('[redacted]');
    expect(summary).not.toContain('sk-123');
    expect(summary).not.toContain('"abc"');
    expect(summary).toContain('us-east-1');

    const long = summarizeToolArgs({ content: 'x'.repeat(5000) });
    expect(long.length).toBeLessThanOrEqual(513);
  });
});
