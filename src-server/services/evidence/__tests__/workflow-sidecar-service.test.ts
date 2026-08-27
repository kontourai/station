/**
 * WorkflowSidecarService tests — run against the REAL schema files shipped in
 * the installed @kontourai/flow-agents package (no fixtures): what these
 * tests validate is what the canonical hooks and harnesses validate.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRunCorrelationEnvelope,
  validateRunCorrelationPresence,
} from '@kontourai/flow-agents';
import type { WorkflowState } from '@kontourai/station-contracts/workflow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  workflowSidecarTransitions: { add: vi.fn() },
}));

const {
  WorkflowSidecarService,
  WorkflowSidecarInvalidError,
  WorkflowSidecarNotFoundError,
} = await import('../workflow-sidecar-service.js');

const logger = { debug: vi.fn(), warn: vi.fn() };

function validState(taskSlug: string): WorkflowState {
  const now = new Date().toISOString();
  return {
    schema_version: '1.0',
    task_slug: taskSlug,
    status: 'in_progress',
    phase: 'execution',
    created_at: now,
    updated_at: now,
    next_action: { status: 'continue', summary: 'Keep going' },
  };
}

describe('WorkflowSidecarService', () => {
  let cwd: string;
  let service: InstanceType<typeof WorkflowSidecarService>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'workflow-sidecar-'));
    service = new WorkflowSidecarService({ logger });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('loads the schema files from the installed package', () => {
    expect(service.schemaAvailable).toBe(true);
  });

  test('round-trips a schema-valid state through the Flow Agents writer', () => {
    service.writeState(cwd, 'demo', validState('demo'));

    const file = join(cwd, '.kontourai', 'flow-agents', 'demo', 'state.json');
    const legacyHookFile = join(cwd, '.flow-agents', 'demo', 'state.json');
    expect(existsSync(file)).toBe(true);
    expect(existsSync(legacyHookFile)).toBe(true);
    // The Flow Agents writer owns sidecar JSON formatting and leaves no
    // Station-local temp-file protocol behind.
    expect(
      readdirSync(join(cwd, '.kontourai', 'flow-agents', 'demo')).filter(
        (name) => name.includes('.tmp-'),
      ),
    ).toEqual([]);

    const state = service.readState(cwd, 'demo');
    expect(state).toMatchObject({
      schema_version: '1.0',
      task_slug: 'demo',
      status: 'in_progress',
      phase: 'execution',
    });
    // The file itself parses as what the canonical hooks expect.
    expect(JSON.parse(readFileSync(file, 'utf-8')).task_slug).toBe('demo');
    expect(JSON.parse(readFileSync(legacyHookFile, 'utf-8')).task_slug).toBe(
      'demo',
    );
  });

  test('preserves the canonical Flow run and open gates in list and detail projections', () => {
    service.writeState(cwd, 'gated-task', {
      ...validState('gated-task'),
      work_item_refs: ['kontourai/station#592'],
      flow_run: {
        run_id: 'gated-task',
        definition_id: 'builder.build',
        definition_version: '1.1',
        status: 'running',
        current_step: 'verify',
        run_ref: '.kontourai/flow/runs/gated-task',
        open_gate_ids: ['verify-gate'],
      },
      next_action: {
        status: 'continue',
        summary: 'Complete the verify gate.',
        skills: ['review-work', 'verify-work'],
        command:
          'flow-agents builder-run sync --session-dir .kontourai/flow-agents/gated-task',
      },
    });

    expect(service.readState(cwd, 'gated-task')?.flow_run).toMatchObject({
      current_step: 'verify',
      open_gate_ids: ['verify-gate'],
    });
    expect(service.listTasks(cwd)[0]?.flowRun).toMatchObject({
      current_step: 'verify',
      open_gate_ids: ['verify-gate'],
    });
    expect(service.listTasks(cwd)[0]?.workItemRefs).toEqual([
      'kontourai/station#592',
    ]);
  });

  test('listTasks carries run_correlation — the only join key an unstarted session has', () => {
    service.writeState(cwd, 'correlated-task', {
      ...validState('correlated-task'),
      run_correlation: {
        schema_version: '1.0',
        correlation_id: 'run-9aac6bd3-ac12-4490-90b4-80ff724417c8',
        identities: {
          runtime_session: {
            status: 'present',
            value: 'thread-6377ca0c787f951bb744ed6b',
          },
          runtime_turn: {
            status: 'unavailable',
            reason: 'a runtime turn identity is not established at run start',
          },
          flow_run: { status: 'present', value: 'correlated-task' },
          flow_step: {
            status: 'unavailable',
            reason: 'the envelope spans changing Flow steps',
          },
          work_item: { status: 'present', value: 'kontourai/station#189' },
          agent: { status: 'present', value: 'codex:thread-6377:Kontour' },
          delegation_trace: {
            status: 'unsupported',
            reason: 'the runtime does not expose delegation trace context',
          },
          delegation_span: {
            status: 'unsupported',
            reason: 'the runtime does not expose delegation span context',
          },
          terminal_record: {
            status: 'unavailable',
            reason: 'the terminal record does not exist at run start',
          },
        },
      },
    });

    const summary = service
      .listTasks(cwd)
      .find((entry) => entry.taskSlug === 'correlated-task');
    expect(summary?.runCorrelation).toMatchObject({
      identities: {
        runtime_session: {
          status: 'present',
          value: 'thread-6377ca0c787f951bb744ed6b',
        },
      },
    });
  });

  test('round-trips a Flow Agents correlation envelope without widening its projection', () => {
    const envelope = createRunCorrelationEnvelope({
      correlation_id: 'run-9aac6bd3-ac12-4490-90b4-80ff724417c8',
      identities: {
        runtime_session: { status: 'present', value: 'thread-6377' },
        runtime_turn: { status: 'unavailable', reason: 'not started' },
        flow_run: { status: 'present', value: 'flow-6377' },
        flow_step: { status: 'unavailable', reason: 'not reached' },
        work_item: { status: 'present', value: 'kontourai/station#2258' },
        agent: { status: 'present', value: 'codex' },
        delegation_trace: { status: 'unsupported', reason: 'not exposed' },
        delegation_span: { status: 'unsupported', reason: 'not exposed' },
        terminal_record: { status: 'unavailable', reason: 'not created' },
      },
    });

    service.writeState(cwd, 'canonical-correlation', {
      ...validState('canonical-correlation'),
      run_correlation: envelope,
    });

    expect(
      service.readState(cwd, 'canonical-correlation')?.run_correlation,
    ).toEqual(envelope);
  });

  test('rejects correlations the canonical Flow Agents validator rejects', () => {
    const fallbackService = new WorkflowSidecarService({
      packageRoot: join(cwd, 'no-such-package-root'),
      logger,
    });
    const bad = {
      ...validState('bad-correlation'),
      run_correlation: {
        schema_version: '1.0',
        correlation_id: 'run-1',
        identities: {
          runtime_session: { status: 'present', value: 'thread-1' },
          extra_identity: { status: 'present', value: 'must-not-pass' },
        },
      },
    } as unknown as WorkflowState;

    expect(() => validateRunCorrelationPresence(bad.run_correlation)).toThrow();
    expect(() => service.writeState(cwd, 'bad-correlation', bad)).toThrow(
      WorkflowSidecarInvalidError,
    );
    expect(() =>
      fallbackService.writeState(cwd, 'bad-correlation', bad),
    ).toThrow(WorkflowSidecarInvalidError);
  });

  test('rejects writes that violate the package schema (status enum)', () => {
    const bad = {
      ...validState('demo'),
      status: 'bogus',
    } as unknown as WorkflowState;
    expect(() => service.writeState(cwd, 'demo', bad)).toThrow(
      WorkflowSidecarInvalidError,
    );
    expect(
      existsSync(join(cwd, '.kontourai', 'flow-agents', 'demo', 'state.json')),
    ).toBe(false);
  });

  test('rejects writes that violate the package schema (missing next_action.summary)', () => {
    const bad = {
      ...validState('demo'),
      next_action: { status: 'continue' },
    } as unknown as WorkflowState;
    expect(() => service.writeState(cwd, 'demo', bad)).toThrow(
      WorkflowSidecarInvalidError,
    );
  });

  test('rejects a task_slug/directory mismatch and unsafe slugs', () => {
    expect(() => service.writeState(cwd, 'other', validState('demo'))).toThrow(
      WorkflowSidecarInvalidError,
    );
    expect(() => service.readState(cwd, '../escape')).toThrow(
      WorkflowSidecarInvalidError,
    );
    expect(() => service.ensureTask(cwd, '.hidden/../x')).toThrow(
      WorkflowSidecarInvalidError,
    );
  });

  test('ensureTask creates a fresh schema-valid sidecar once, then resumes it', () => {
    const first = service.ensureTask(cwd, 'fresh-task', {
      summary: 'Picked up by session s-1 (claude)',
    });
    expect(first.created).toBe(true);
    expect(first.state).toMatchObject({
      status: 'new',
      phase: 'pickup',
      next_action: {
        status: 'continue',
        summary: 'Picked up by session s-1 (claude)',
      },
    });

    const second = service.ensureTask(cwd, 'fresh-task');
    expect(second.created).toBe(false);
    expect(second.state).toEqual(first.state);
  });

  test('transition merges a patch, bumps updated_at, and validates the result', async () => {
    service.ensureTask(cwd, 'demo');
    const before = service.readState(cwd, 'demo');
    await new Promise((resolve) => setTimeout(resolve, 5));

    const next = service.transition(cwd, 'demo', {
      status: 'verifying',
      phase: 'verification',
      nextAction: { status: 'continue', summary: 'Run the verify lane' },
    });
    expect(next).toMatchObject({
      status: 'verifying',
      phase: 'verification',
      next_action: { summary: 'Run the verify lane' },
    });
    expect(next.updated_at > (before?.updated_at ?? '')).toBe(true);

    // Empty patch = touch (activity recorded, state preserved).
    const touched = service.transition(cwd, 'demo', {});
    expect(touched.status).toBe('verifying');

    expect(() =>
      service.transition(cwd, 'missing-task', { status: 'blocked' }),
    ).toThrow(WorkflowSidecarNotFoundError);
  });

  test('transition promotes legacy task state without hiding sibling legacy handoff', () => {
    const taskDir = join(cwd, '.flow-agents', 'legacy-task');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, 'state.json'),
      JSON.stringify(validState('legacy-task')),
    );
    writeFileSync(
      join(taskDir, 'handoff.json'),
      JSON.stringify({
        schema_version: '1.0',
        task_slug: 'legacy-task',
        summary: 'Legacy handoff survives state transitions.',
        next_steps: ['Resume from old task root'],
        blockers: [],
      }),
    );

    service.transition(cwd, 'legacy-task', {
      status: 'verifying',
      phase: 'verification',
    });

    expect(
      existsSync(
        join(cwd, '.kontourai', 'flow-agents', 'legacy-task', 'state.json'),
      ),
    ).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(cwd, '.kontourai', 'flow-agents', 'legacy-task', 'state.json'),
          'utf-8',
        ),
      ).status,
    ).toBe('verifying');
    expect(
      JSON.parse(readFileSync(join(taskDir, 'state.json'), 'utf-8')).status,
    ).toBe('verifying');
    expect(service.readHandoff(cwd, 'legacy-task')).toMatchObject({
      summary: 'Legacy handoff survives state transitions.',
      next_steps: ['Resume from old task root'],
    });
  });

  test('listTasks summarizes valid sidecars and skips invalid/archive entries', () => {
    service.writeState(cwd, 'task-a', validState('task-a'));
    service.writeState(cwd, 'task-b', {
      ...validState('task-b'),
      status: 'blocked',
      updated_at: '2099-01-01T00:00:00.000Z',
    });
    // Invalid sidecar: skipped with a warning, never breaks the listing.
    mkdirSync(join(cwd, '.flow-agents', 'task-broken'), { recursive: true });
    writeFileSync(
      join(cwd, '.flow-agents', 'task-broken', 'state.json'),
      '{"status":"nope"}',
    );
    // Archive dir is ignored (mirrors the canonical hooks' walk).
    mkdirSync(join(cwd, '.flow-agents', 'archive', 'old-task'), {
      recursive: true,
    });
    writeFileSync(
      join(cwd, '.flow-agents', 'archive', 'old-task', 'state.json'),
      JSON.stringify(validState('old-task')),
    );

    const tasks = service.listTasks(cwd);
    expect(tasks.map((task) => task.taskSlug)).toEqual(['task-b', 'task-a']);
    expect(tasks[0]).toMatchObject({
      status: 'blocked',
      hasHandoff: false,
      path: '.kontourai/flow-agents/task-b',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping invalid workflow sidecar',
      expect.objectContaining({ taskSlug: 'task-broken' }),
    );

    expect(
      service.listTasks(mkdtempSync(join(tmpdir(), 'no-sidecars-'))),
    ).toEqual([]);
  });

  test('handoff.json round-trips against the package handoff schema', () => {
    service.ensureTask(cwd, 'demo');
    expect(service.readHandoff(cwd, 'demo')).toBeNull();

    service.writeHandoff(cwd, 'demo', {
      schema_version: '1.0',
      task_slug: 'demo',
      summary: 'Verification outstanding; readiness gate wired.',
      next_steps: ['Run verify lane', 'Attach readiness evidence'],
      blockers: [],
    });
    expect(service.readHandoff(cwd, 'demo')).toMatchObject({
      summary: 'Verification outstanding; readiness gate wired.',
      next_steps: ['Run verify lane', 'Attach readiness evidence'],
    });
    expect(service.listTasks(cwd)[0]?.hasHandoff).toBe(true);

    expect(() =>
      service.writeHandoff(cwd, 'demo', {
        schema_version: '1.0',
        task_slug: 'demo',
        summary: '',
        next_steps: [],
      }),
    ).toThrow(WorkflowSidecarInvalidError);
  });

  test('readTrustBundle: null when trust.bundle does not exist', () => {
    service.ensureTask(cwd, 'demo');
    expect(service.readTrustBundle(cwd, 'demo')).toBeNull();
  });

  test('readTrustBundle: returns the parsed JSON when the file exists', () => {
    service.ensureTask(cwd, 'demo');
    const dir = join(cwd, '.kontourai', 'flow-agents', 'demo');
    writeFileSync(
      join(dir, 'trust.bundle'),
      JSON.stringify({ claims: [{ id: 'c1' }] }),
    );
    expect(service.readTrustBundle(cwd, 'demo')).toEqual({
      claims: [{ id: 'c1' }],
    });
  });

  test('readTrustBundle: malformed JSON throws WorkflowSidecarInvalidError', () => {
    service.ensureTask(cwd, 'demo');
    const dir = join(cwd, '.kontourai', 'flow-agents', 'demo');
    writeFileSync(join(dir, 'trust.bundle'), '{ not valid json');
    expect(() => service.readTrustBundle(cwd, 'demo')).toThrow(
      WorkflowSidecarInvalidError,
    );
  });

  test('readTrustBundle: rejects an unsafe task slug the same as every other read/write', () => {
    expect(() => service.readTrustBundle(cwd, '../escape')).toThrow(
      WorkflowSidecarInvalidError,
    );
  });

  test('readTrustBundle: falls back to the legacy .flow-agents root when only a legacy trust.bundle exists', () => {
    const legacyTaskDir = join(cwd, '.flow-agents', 'legacy-task');
    mkdirSync(legacyTaskDir, { recursive: true });
    writeFileSync(
      join(legacyTaskDir, 'state.json'),
      JSON.stringify(validState('legacy-task')),
    );
    writeFileSync(
      join(legacyTaskDir, 'trust.bundle'),
      JSON.stringify({ claims: [{ id: 'legacy-critique' }] }),
    );

    // No canonical .kontourai/flow-agents/legacy-task directory exists at all.
    expect(
      existsSync(join(cwd, '.kontourai', 'flow-agents', 'legacy-task')),
    ).toBe(false);

    expect(service.readTrustBundle(cwd, 'legacy-task')).toEqual({
      claims: [{ id: 'legacy-critique' }],
    });
  });

  test('readTrustBundle: prefers the canonical trust.bundle when both canonical and legacy exist', () => {
    const legacyTaskDir = join(cwd, '.flow-agents', 'both-task');
    mkdirSync(legacyTaskDir, { recursive: true });
    writeFileSync(
      join(legacyTaskDir, 'trust.bundle'),
      JSON.stringify({ claims: [{ id: 'legacy-critique' }] }),
    );

    service.ensureTask(cwd, 'both-task');
    const canonicalDir = join(cwd, '.kontourai', 'flow-agents', 'both-task');
    writeFileSync(
      join(canonicalDir, 'trust.bundle'),
      JSON.stringify({ claims: [{ id: 'canonical-critique' }] }),
    );

    expect(service.readTrustBundle(cwd, 'both-task')).toEqual({
      claims: [{ id: 'canonical-critique' }],
    });
  });

  test('explicit but invalid packageRoot does NOT auto-discover (documented fallback)', () => {
    const fallback = new WorkflowSidecarService({
      packageRoot: join(cwd, 'nowhere'),
      logger,
    });
    expect(fallback.schemaAvailable).toBe(false);

    // Structural fallback still enforces the documented shape…
    fallback.writeState(cwd, 'demo', validState('demo'));
    expect(() =>
      fallback.writeState(cwd, 'demo', {
        ...validState('demo'),
        status: 'bogus',
      } as unknown as WorkflowState),
    ).toThrow(WorkflowSidecarInvalidError);
    expect(() =>
      fallback.writeState(cwd, 'demo', {
        ...validState('demo'),
        flow_run: {
          run_id: 'demo',
          definition_id: 'builder.build',
          definition_version: '1.1',
          status: 'active',
          current_step: 'verify',
          run_ref: '.kontourai/flow/runs/demo',
          open_gate_ids: { length: 1 },
        },
      } as unknown as WorkflowState),
    ).toThrow(WorkflowSidecarInvalidError);
    // …and the degradation is logged once.
    expect(
      logger.warn.mock.calls.filter(
        ([message]) =>
          typeof message === 'string' && message.includes('degrading'),
      ),
    ).toHaveLength(1);
  });
});
