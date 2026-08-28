/**
 * Integration coverage for archive#582's task/session-detail join: a Station task
 * (title, and optionally workItemRef), exact-matched against a workspace's
 * REAL flow-agents sidecar `task_slug`s (read through the existing
 * WorkflowSidecarService — no parallel reader). Fixtures are written to a
 * temp dir per test, never to a real `.kontourai/flow-agents` in this repo.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowState } from '@kontourai/station-contracts/workflow';
import { resolveWorkflowTaskMatch } from '@kontourai/station-contracts/workflow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../telemetry/metrics.js', () => ({
  workflowSidecarTransitions: { add: vi.fn() },
}));

const { WorkflowSidecarService } = await import(
  '../evidence/workflow-sidecar-service.js'
);

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

describe('task-detail workflow join against real sidecar fixtures', () => {
  let cwd: string;
  let service: InstanceType<typeof WorkflowSidecarService>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'workflow-sidecar-join-'));
    service = new WorkflowSidecarService({
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('a Station task title exact-matches its sidecar by slugified title', () => {
    // Fixture sidecar written through the real writer, mirroring what
    // flow-agents' `ensure-session --task-slug sidecar-join-582` produces.
    service.writeState(cwd, 'sidecar-join-582', validState('sidecar-join-582'));
    service.writeState(cwd, 'other-task', {
      ...validState('other-task'),
      status: 'blocked',
      phase: 'planning',
    });

    const tasks = service.listTasks(cwd);
    expect(tasks.map((t) => t.taskSlug).sort()).toEqual([
      'other-task',
      'sidecar-join-582',
    ]);

    const task = { title: 'Sidecar Join #582' };
    const result = resolveWorkflowTaskMatch(task, [task], tasks);
    expect(result).toMatchObject({
      kind: 'title-heuristic',
      match: {
        taskSlug: 'sidecar-join-582',
        status: 'in_progress',
        phase: 'execution',
      },
    });
  });

  test('a durable workItemRef exact-matches its sidecar even with an unrelated title', () => {
    service.writeState(cwd, 'other-task', validState('other-task'));
    const tasks = service.listTasks(cwd);

    const task = {
      title: 'Totally unrelated title',
      workItemRef: 'other-task',
    };
    const result = resolveWorkflowTaskMatch(task, [task], tasks);
    expect(result).toMatchObject({
      kind: 'workItemRef',
      match: { taskSlug: 'other-task' },
    });
  });

  test('a provider-shaped workItemRef matches the canonical sidecar reference', () => {
    service.writeState(cwd, 'kontourai-station-592', {
      ...validState('kontourai-station-592'),
      work_item_refs: ['kontourai/station#592'],
    });
    const tasks = service.listTasks(cwd);

    const task = {
      title: 'A title unrelated to the sidecar slug',
      workItemRef: 'kontourai/station#592',
    };
    expect(resolveWorkflowTaskMatch(task, [task], tasks)).toMatchObject({
      kind: 'workItemRef',
      match: { taskSlug: 'kontourai-station-592' },
    });
  });

  test('a title with no exact sidecar match renders nothing (undefined)', () => {
    service.writeState(cwd, 'sidecar-join-582', validState('sidecar-join-582'));
    const tasks = service.listTasks(cwd);

    const task = { title: 'A totally different task' };
    expect(resolveWorkflowTaskMatch(task, [task], tasks)).toBeUndefined();
  });

  test('a workspace with no flow-agents dir at all yields no match (graceful absence)', () => {
    const bareCwd = mkdtempSync(join(tmpdir(), 'no-flow-agents-'));
    try {
      const tasks = service.listTasks(bareCwd);
      expect(tasks).toEqual([]);
      const task = { title: 'Sidecar Join #582' };
      expect(resolveWorkflowTaskMatch(task, [task], tasks)).toBeUndefined();
    } finally {
      rmSync(bareCwd, { recursive: true, force: true });
    }
  });

  test('a malformed state.json is skipped by listTasks, so it never surfaces as a match', () => {
    // Invalid sidecar (bad status enum) — listTasks silently skips it, so the
    // join sees no candidate for this slug at all.
    const badDir = join(cwd, '.kontourai', 'flow-agents', 'broken-task');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'state.json'), '{"status":"nope"}');

    const tasks = service.listTasks(cwd);
    expect(tasks).toEqual([]);
    const task = { title: 'Broken Task' };
    expect(resolveWorkflowTaskMatch(task, [task], tasks)).toBeUndefined();
  });

  test('two real sidecars, two colliding titles: neither task renders a match', () => {
    service.writeState(cwd, 'sidecar-join-582', validState('sidecar-join-582'));
    const tasks = service.listTasks(cwd);

    const taskA = { title: 'Sidecar Join #582' };
    const taskB = { title: 'sidecar   join 582' }; // normalizes identically
    const allProjectTasks = [taskA, taskB];

    expect(
      resolveWorkflowTaskMatch(taskA, allProjectTasks, tasks),
    ).toBeUndefined();
    expect(
      resolveWorkflowTaskMatch(taskB, allProjectTasks, tasks),
    ).toBeUndefined();
  });
});
