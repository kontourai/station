import { describe, expect, it } from 'vitest';
import { isStarterWorkReference } from '../starter-work.js';
import {
  isWorkReference,
  WORK_REFERENCE_KINDS,
  workReferenceIdentityKey,
} from '../work-reference.js';

describe('WorkReference', () => {
  it('is a closed identity-only union', () => {
    expect(WORK_REFERENCE_KINDS).toEqual([
      'project',
      'task',
      'session',
      'approval',
      'receipt',
      'run',
      'artifact',
      'agent',
    ]);
    expect(isWorkReference({ kind: 'project', id: 'project-1' })).toBe(true);
    expect(
      isWorkReference({
        kind: 'project',
        id: 'project-1',
        title: 'copied authority',
      }),
    ).toBe(false);
    expect(
      isWorkReference({ kind: 'task', id: 'task-1', projectId: 'p-1' }),
    ).toBe(true);
    expect(
      isWorkReference({
        kind: 'task',
        id: 'task-1',
        projectId: 'p-1',
        title: 'copied authority',
      }),
    ).toBe(false);
    expect(isWorkReference({ kind: 'session', id: 'session-1' })).toBe(true);
    expect(
      isWorkReference({
        kind: 'session',
        id: 'session-1',
        status: 'copied authority',
      }),
    ).toBe(false);
    expect(isWorkReference({ kind: 'approval', id: 'notification-1' })).toBe(
      true,
    );
    expect(
      isWorkReference({
        kind: 'approval',
        id: 'notification-1',
        approvalId: 'private-target',
      }),
    ).toBe(false);
    expect(
      isWorkReference({
        kind: 'receipt',
        owner: 'scheduler-run',
        id: 'schedule:run-1',
      }),
    ).toBe(true);
    expect(
      isWorkReference({
        kind: 'receipt',
        owner: 'independent-review',
        id: 'receipt-1',
        projectSlug: 'alpha',
      }),
    ).toBe(true);
    expect(isWorkReference({ kind: 'receipt', id: 'receipt-1' })).toBe(false);
    expect(
      isWorkReference({
        kind: 'receipt',
        owner: 'unknown',
        id: 'receipt-1',
      }),
    ).toBe(false);
    expect(
      isWorkReference({
        kind: 'run',
        owner: 'flow',
        projectId: 'project-1',
        id: 'run-1',
      }),
    ).toBe(true);
    expect(
      isWorkReference({
        kind: 'run',
        owner: 'flow',
        projectId: 'project-1',
        id: 'run-1',
        gateId: 'gate-1',
      }),
    ).toBe(true);
    expect(
      isWorkReference({
        kind: 'run',
        owner: 'flow',
        projectId: 'project-1',
        id: 'run-1',
        gateId: '',
      }),
    ).toBe(false);
    expect(
      isWorkReference({
        kind: 'run',
        owner: 'flow',
        projectId: 'project-1',
        id: 'run-1',
        gateId: undefined,
      }),
    ).toBe(false);
    expect(
      isWorkReference({
        kind: 'run',
        owner: 'flow',
        projectId: 'project-1',
        id: 'run-1',
        status: 'copied authority',
      }),
    ).toBe(false);
    expect(
      isWorkReference({
        kind: 'run',
        owner: 'scheduler-run',
        projectId: 'project-1',
        id: 'run-1',
      }),
    ).toBe(false);
    expect(
      isWorkReference({
        kind: 'artifact',
        owner: 'run-output',
        runId: 'run-1',
        id: 'artifact-1',
      }),
    ).toBe(true);
    expect(isWorkReference({ kind: 'artifact', id: 'artifact-1' })).toBe(false);
    expect(
      isWorkReference({
        kind: 'artifact',
        owner: 'run-output',
        runId: 'run-1',
        id: 'artifact-1',
        title: 'copied authority',
      }),
    ).toBe(false);
    expect(isWorkReference({ kind: 'agent', id: 'agent-1' })).toBe(true);
    expect(
      isWorkReference({
        kind: 'agent',
        id: 'agent-1',
        availability: 'copied authority',
      }),
    ).toBe(false);
  });

  it('keys every full identity tuple without delimiter or scope collisions', () => {
    const references = [
      { kind: 'task', projectId: 'a:b', id: 'c' },
      { kind: 'task', projectId: 'a', id: 'b:c' },
      { kind: 'project', id: 'a:b:c' },
      { kind: 'session', id: 'a:b:c' },
      { kind: 'receipt', owner: 'scheduler-run', id: 'a:b:c' },
      {
        kind: 'receipt',
        owner: 'independent-review',
        projectSlug: 'a:b',
        id: 'c',
      },
      {
        kind: 'receipt',
        owner: 'independent-review',
        projectSlug: 'a',
        id: 'b:c',
      },
      { kind: 'run', owner: 'flow', projectId: 'a:b', id: 'c' },
      {
        kind: 'run',
        owner: 'flow',
        projectId: 'a',
        id: 'b:c',
        gateId: 'gate:1',
      },
      {
        kind: 'artifact',
        owner: 'run-output',
        runId: 'a:b',
        id: 'c',
      },
      { kind: 'agent', id: 'a:b:c' },
    ] as const;

    const keys = references.map(workReferenceIdentityKey);
    expect(new Set(keys)).toHaveProperty('size', references.length);
    expect(
      workReferenceIdentityKey({
        kind: 'run',
        owner: 'flow',
        projectId: 'project-1',
        id: 'run-1',
      }),
    ).not.toBe(
      workReferenceIdentityKey({
        kind: 'run',
        owner: 'flow',
        projectId: 'project-1',
        id: 'run-1',
        gateId: 'gate-1',
      }),
    );
  });

  it('keeps Starter Work closed to its owner-backed catalog', () => {
    expect(
      isStarterWorkReference({ kind: 'task', id: 'task-1', projectId: 'p-1' }),
    ).toBe(true);
    for (const reference of [
      { kind: 'project', id: 'project-1' },
      { kind: 'run', owner: 'flow', projectId: 'project-1', id: 'run-1' },
      {
        kind: 'artifact',
        owner: 'run-output',
        runId: 'run-1',
        id: 'artifact-1',
      },
      { kind: 'agent', id: 'agent-1' },
    ])
      expect(isStarterWorkReference(reference)).toBe(false);
  });
});
