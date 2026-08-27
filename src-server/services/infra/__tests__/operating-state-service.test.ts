/**
 * OperatingStateService tests (roadmap #586, part of epic #580, S6) — real
 * `WorkflowSidecarService` against a temp-dir workspace fixture (matching
 * `workflow-sidecar-service.test.ts`'s own convention), the REAL published
 * `@kontourai/console-server` bridge functions (no mocks on
 * `translateWorkflowProcessProjectionEnvelope`/`buildCurrentOperatingState`)
 * — proving the full in-process pipeline, including the malformed-workflow
 * skip acceptance bar.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowState } from '@kontourai/station-contracts/workflow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  workflowSidecarTransitions: { add: vi.fn() },
}));

const { WorkflowSidecarService } = await import(
  '../../evidence/workflow-sidecar-service.js'
);
const { OperatingStateService, qualifiedWorkflowProcessId } = await import(
  '../operating-state-service.js'
);

const logger = { debug: vi.fn(), warn: vi.fn() };

function writeState(
  cwd: string,
  taskSlug: string,
  state: Partial<WorkflowState> = {},
): void {
  const dir = join(cwd, '.kontourai', 'flow-agents', taskSlug);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const full: WorkflowState = {
    schema_version: '1.0',
    task_slug: taskSlug,
    status: 'in_progress',
    phase: 'execution',
    created_at: now,
    updated_at: now,
    next_action: { status: 'continue', summary: 'Keep going' },
    ...state,
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(full, null, 2));
}

function writeMalformedState(cwd: string, taskSlug: string): void {
  const dir = join(cwd, '.kontourai', 'flow-agents', taskSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), '{ not valid json');
}

function critiqueClaim(overrides: Record<string, unknown> = {}) {
  return {
    id: 'critique-1',
    status: 'accepted',
    value: 'not_verified',
    metadata: { origin: 'critique' },
    ...overrides,
  };
}

function writeTrustBundle(
  cwd: string,
  taskSlug: string,
  claims: Record<string, unknown>[],
): void {
  const dir = join(cwd, '.kontourai', 'flow-agents', taskSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'trust.bundle'), JSON.stringify({ claims }, null, 2));
}

function writeMalformedTrustBundle(cwd: string, taskSlug: string): void {
  const dir = join(cwd, '.kontourai', 'flow-agents', taskSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'trust.bundle'), '{ not valid json');
}

describe('OperatingStateService', () => {
  let cwd: string;
  let service: InstanceType<typeof OperatingStateService>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'operating-state-'));
    service = new OperatingStateService(
      { workflowSidecarService: new WorkflowSidecarService({ logger }) },
      { now: () => Date.parse('2026-07-23T12:00:00.000Z') },
    );
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('an empty workspace derives an empty OperatingState', () => {
    const state = service.deriveOperatingState(cwd, 'demo');
    expect(state.processes ?? []).toEqual([]);
  });

  test('one valid task sidecar folds into exactly one ConsoleProcess', () => {
    writeState(cwd, 'demo-task', {
      status: 'blocked',
      next_action: { status: 'blocked', summary: 'waiting on CI' },
    });

    const state = service.deriveOperatingState(cwd, 'demo');
    expect(state.processes).toHaveLength(1);
    const process = state.processes?.[0];
    expect(process?.id).toBe(qualifiedWorkflowProcessId('demo', 'demo-task'));
    expect(process?.status).toBe('blocked');
    expect(process?.blockedReason).toBe('waiting on CI');
    expect(process?.label).toBe('demo-task');
  });

  test('status mapping is applied per task (in_progress -> running, delivered -> completed)', () => {
    writeState(cwd, 'task-a', { status: 'in_progress' });
    writeState(cwd, 'task-b', {
      status: 'delivered',
      next_action: { status: 'done', summary: 'shipped' },
    });

    const state = service.deriveOperatingState(cwd, 'demo');
    const byId = new Map(
      (state.processes ?? []).map((process) => [process.id, process]),
    );
    expect(byId.get(qualifiedWorkflowProcessId('demo', 'task-a'))?.status).toBe(
      'running',
    );
    expect(byId.get(qualifiedWorkflowProcessId('demo', 'task-b'))?.status).toBe(
      'completed',
    );
  });

  test('malformed-workflow skip: a corrupt sidecar is skipped, valid siblings still fold', () => {
    writeState(cwd, 'good-task', { status: 'planning' });
    writeMalformedState(cwd, 'bad-task');

    const state = service.deriveOperatingState(cwd, 'demo');
    expect(state.processes).toHaveLength(1);
    expect(state.processes?.[0]?.id).toBe(
      qualifiedWorkflowProcessId('demo', 'good-task'),
    );
  });

  test('two projects with the same task slug never collide (scope-qualified ids)', () => {
    writeState(cwd, 'shared-slug', { status: 'in_progress' });
    const stateA = service.deriveOperatingState(cwd, 'project-a');
    const stateB = service.deriveOperatingState(cwd, 'project-b');

    expect(stateA.processes?.[0]?.id).not.toBe(stateB.processes?.[0]?.id);
    expect(stateA.processes?.[0]?.id).toBe(
      qualifiedWorkflowProcessId('project-a', 'shared-slug'),
    );
  });
});

describe('OperatingStateService — trust.bundle critique detection (roadmap #753)', () => {
  let cwd: string;
  let service: InstanceType<typeof OperatingStateService>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'operating-state-critique-'));
    service = new OperatingStateService(
      { workflowSidecarService: new WorkflowSidecarService({ logger }) },
      { logger, now: () => Date.parse('2026-07-23T12:00:00.000Z') },
    );
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('an unresolved live critique folds a non-terminal task to review_pending with a blockedReason', () => {
    writeState(cwd, 'demo-task', { status: 'in_progress' });
    writeTrustBundle(cwd, 'demo-task', [
      critiqueClaim({
        value: 'not_verified',
        metadata: {
          origin: 'critique',
          workflow_subject_ref: 'flow-agents://session/demo-task',
        },
      }),
    ]);

    const state = service.deriveOperatingState(cwd, 'demo');
    const process = state.processes?.[0];
    expect(process?.status).toBe('review_pending');
    expect(process?.blockedReason).toMatch(/unresolved live critique/);
  });

  test('a resolved (superseded) critique does not force review_pending — base status renders', () => {
    writeState(cwd, 'demo-task', { status: 'in_progress' });
    writeTrustBundle(cwd, 'demo-task', [
      critiqueClaim({
        value: 'not_verified',
        metadata: {
          origin: 'critique',
          workflow_subject_ref: 'flow-agents://session/demo-task',
          superseded_by: 'critique-2',
        },
      }),
    ]);

    const state = service.deriveOperatingState(cwd, 'demo');
    expect(state.processes?.[0]?.status).toBe('running');
    expect(state.processes?.[0]?.blockedReason).toBeUndefined();
  });

  test('an absent trust.bundle renders the base status (no critique signal)', () => {
    writeState(cwd, 'demo-task', { status: 'in_progress' });

    const state = service.deriveOperatingState(cwd, 'demo');
    expect(state.processes?.[0]?.status).toBe('running');
  });

  test('a passing critique does not force review_pending', () => {
    writeState(cwd, 'demo-task', { status: 'in_progress' });
    writeTrustBundle(cwd, 'demo-task', [
      critiqueClaim({
        value: 'pass',
        metadata: {
          origin: 'critique',
          workflow_subject_ref: 'flow-agents://session/demo-task',
        },
      }),
    ]);

    const state = service.deriveOperatingState(cwd, 'demo');
    expect(state.processes?.[0]?.status).toBe('running');
  });

  test('a malformed trust.bundle is skipped (warned), the task still folds under its base status, siblings unaffected', () => {
    writeState(cwd, 'bad-bundle-task', { status: 'in_progress' });
    writeMalformedTrustBundle(cwd, 'bad-bundle-task');
    writeState(cwd, 'good-task', { status: 'in_progress' });
    writeTrustBundle(cwd, 'good-task', [
      critiqueClaim({
        value: 'not_verified',
        metadata: {
          origin: 'critique',
          workflow_subject_ref: 'flow-agents://session/good-task',
        },
      }),
    ]);

    const state = service.deriveOperatingState(cwd, 'demo');
    const byId = new Map(
      (state.processes ?? []).map((process) => [process.id, process]),
    );
    expect(
      byId.get(qualifiedWorkflowProcessId('demo', 'bad-bundle-task'))?.status,
    ).toBe('running');
    expect(
      byId.get(qualifiedWorkflowProcessId('demo', 'good-task'))?.status,
    ).toBe('review_pending');
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping unreadable workflow trust.bundle',
      expect.objectContaining({ taskSlug: 'bad-bundle-task' }),
    );
  });

  test('a critique whose workflow_subject_ref names a different session is excluded — filterCritiquesForSlug semantics', () => {
    writeState(cwd, 'demo-task', { status: 'in_progress' });
    writeTrustBundle(cwd, 'demo-task', [
      critiqueClaim({
        value: 'not_verified',
        metadata: {
          origin: 'critique',
          workflow_subject_ref: 'flow-agents://session/some-other-task',
        },
      }),
    ]);

    const state = service.deriveOperatingState(cwd, 'demo');
    expect(state.processes?.[0]?.status).toBe('running');
    expect(logger.warn).toHaveBeenCalledWith(
      'Excluding trust.bundle critique from review_pending signal',
      expect.objectContaining({
        taskSlug: 'demo-task',
        warning: expect.stringMatching(/some-other-task/),
      }),
    );
  });

  test('a critique bound to this task via a matching work_item_ref is included (not excluded as foreign)', () => {
    writeState(cwd, 'demo-task', {
      status: 'in_progress',
      work_item_refs: ['github:kontourai/station#753'],
    });
    writeTrustBundle(cwd, 'demo-task', [
      critiqueClaim({
        value: 'not_verified',
        metadata: {
          origin: 'critique',
          workflow_subject_ref: 'github:kontourai/station#753',
        },
      }),
    ]);

    const state = service.deriveOperatingState(cwd, 'demo');
    expect(state.processes?.[0]?.status).toBe('review_pending');
  });

  test('a terminal task status is never overridden to review_pending by an unresolved critique', () => {
    writeState(cwd, 'demo-task', {
      status: 'delivered',
      next_action: { status: 'done', summary: 'shipped' },
    });
    writeTrustBundle(cwd, 'demo-task', [
      critiqueClaim({
        value: 'not_verified',
        metadata: {
          origin: 'critique',
          workflow_subject_ref: 'flow-agents://session/demo-task',
        },
      }),
    ]);

    const state = service.deriveOperatingState(cwd, 'demo');
    expect(state.processes?.[0]?.status).toBe('completed');
  });
});

describe('qualifiedWorkflowProcessId / taskSlugFromQualifiedProcessId round-trip', () => {
  test('recovers the exact task slug for the matching scope', async () => {
    const { taskSlugFromQualifiedProcessId } = await import(
      '../operating-state-service.js'
    );
    const id = qualifiedWorkflowProcessId('demo', 'my-task-slug');
    expect(taskSlugFromQualifiedProcessId(id, 'demo')).toBe('my-task-slug');
  });

  test('fails closed for a different scope id', async () => {
    const { taskSlugFromQualifiedProcessId } = await import(
      '../operating-state-service.js'
    );
    const id = qualifiedWorkflowProcessId('demo', 'my-task-slug');
    expect(taskSlugFromQualifiedProcessId(id, 'other-project')).toBeUndefined();
  });
});
