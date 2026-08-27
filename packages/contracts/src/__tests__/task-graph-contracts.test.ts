import { describe, expect, test } from 'vitest';
import {
  canTransitionTaskStatus,
  createTaskSessionId,
  encodeTaskToolResultReference,
  encodeTaskTurnReference,
  encodeTaskUserInputReference,
  MAX_TASK_REFERENCE_ID_LENGTH,
  parseTaskToolResultReference,
  parseTaskTurnReference,
  parseTaskUserInputReference,
  type RelationGraphLink,
  type TaskRecord,
  taskReferenceToRelationGraphLinkInput,
  validateRelationGraphLinkInput,
  validateTaskCreateInput,
  validateTaskReferenceInput,
} from '../task-graph.js';

describe('task graph contracts', () => {
  test('task records expose the dispatch-oriented status model', () => {
    const task: TaskRecord = {
      id: 'task-1',
      projectId: 'project-alpha',
      title: 'Harden dispatch',
      description: 'Create a dispatch proof lane',
      priority: 'high',
      status: 'ready',
      createdBy: 'agent',
      createdAt: '2026-05-03T00:00:00.000Z',
      updatedAt: '2026-05-03T00:00:00.000Z',
    };

    expect(task).toEqual(
      expect.objectContaining({
        projectId: 'project-alpha',
        priority: 'high',
        status: 'ready',
      }),
    );
  });

  test('status transitions allow dispatch progress without reopening terminal states', () => {
    expect(canTransitionTaskStatus('todo', 'ready')).toBe(true);
    expect(canTransitionTaskStatus('ready', 'triage')).toBe(true);
    expect(canTransitionTaskStatus('triage', 'in_progress')).toBe(true);
    expect(canTransitionTaskStatus('ready', 'in_progress')).toBe(true);
    expect(canTransitionTaskStatus('in_progress', 'done')).toBe(true);
    expect(canTransitionTaskStatus('done', 'in_progress')).toBe(false);
    expect(canTransitionTaskStatus('canceled', 'todo')).toBe(false);
  });

  // #593 (follow-up from #581's review, finding 2): review/verification can
  // reach blocked directly, and blocked can resume straight back to
  // review/verification, without a misleading in_progress detour.
  test('review and verification can transition directly to blocked', () => {
    expect(canTransitionTaskStatus('review', 'blocked')).toBe(true);
    expect(canTransitionTaskStatus('verification', 'blocked')).toBe(true);
  });

  test('blocked can resume directly back to review or verification', () => {
    expect(canTransitionTaskStatus('blocked', 'review')).toBe(true);
    expect(canTransitionTaskStatus('blocked', 'verification')).toBe(true);
  });

  test('task create validation rejects missing user-facing fields', () => {
    expect(
      validateTaskCreateInput({
        projectId: '',
        title: '',
      }),
    ).toEqual(['projectId is required', 'title is required']);
  });

  test('bounds Task text, reference targets, and reference metadata', () => {
    expect(
      validateTaskCreateInput({
        projectId: 'project-alpha',
        title: 'x'.repeat(241),
        description: 'y'.repeat(12_001),
      }),
    ).toEqual([
      'title must be at most 240 characters',
      'description must be at most 12000 characters',
    ]);
    expect(
      validateTaskReferenceInput({
        kind: 'artifact',
        targetId: 'x'.repeat(4_097),
        metadata: { payload: 'y'.repeat(16_384) },
      }),
    ).toEqual([
      'targetId must be at most 4096 characters',
      'metadata must be at most 16384 bytes',
    ]);
    expect(
      validateTaskReferenceInput({
        kind: 'artifact',
        targetId: 'unicode-payload',
        metadata: { payload: '😀'.repeat(4_096) },
      }),
    ).toEqual(['metadata must be at most 16384 bytes']);
  });

  test('workspace bindings retain exact full and partial snapshots', () => {
    expect(
      validateTaskCreateInput({
        projectId: 'project-alpha',
        title: 'Bound task',
        workspaceBinding: {
          workingDirectory: '/work/project-alpha',
          repoRoot: '/work/project-alpha',
          worktreePath: '/work/project-alpha-worktrees/task-1',
          branch: 'feature/task-1',
          sourceSurface: 'ui',
          capturedAt: '2026-07-19T00:00:00.000Z',
          availability: 'available',
        },
      }),
    ).toEqual([]);
    expect(
      validateTaskCreateInput({
        projectId: 'project-alpha',
        title: 'Partial binding',
        workspaceBinding: { workingDirectory: '/work/project-alpha' },
      }),
    ).toEqual([]);
  });

  test('relation graph links model task to session/file/agent/skill edges', () => {
    const link: RelationGraphLink = {
      id: 'link-1',
      sourceType: 'task',
      sourceId: 'task-1',
      targetType: 'session',
      targetId: 'session-1',
      relationType: 'spawned_session',
      confidence: 1,
      createdAt: '2026-05-03T00:00:00.000Z',
      source: 'dispatch',
    };

    expect(validateRelationGraphLinkInput(link)).toEqual([]);
    expect(link).toEqual(
      expect.objectContaining({
        sourceType: 'task',
        targetType: 'session',
        relationType: 'spawned_session',
      }),
    );
  });

  test('task references map artifact, receipt, and opaque external handles into graph links', () => {
    const cases = [
      ['artifact', 'artifact://plan', 'artifact', 'references_artifact'],
      ['receipt', 'receipt://build', 'receipt', 'references_receipt'],
      ['external', 'flow:run-1', 'external', 'references_external'],
    ] as const;

    for (const [kind, targetId, targetType, relationType] of cases) {
      const reference = { kind, targetId, metadata: { label: 'Known ref' } };
      expect(validateTaskReferenceInput(reference)).toEqual([]);
      expect(
        taskReferenceToRelationGraphLinkInput('task-1', reference),
      ).toEqual(
        expect.objectContaining({
          sourceType: 'task',
          sourceId: 'task-1',
          targetType,
          targetId,
          relationType,
        }),
      );
    }
  });

  test('turn references preserve the exact Session/turn tuple in one canonical target identity', () => {
    const first = encodeTaskTurnReference('session-a', 'turn-1');
    const secondTurn = encodeTaskTurnReference('session-a', 'turn-2');
    const secondSession = encodeTaskTurnReference('session-b', 'turn-1');

    expect(first).not.toBe(secondTurn);
    expect(first).not.toBe(secondSession);
    expect(parseTaskTurnReference(first)).toEqual({
      kind: 'turn',
      sessionId: 'session-a',
      turnId: 'turn-1',
    });
    expect(parseTaskTurnReference('turn/session-a/turn%2f1')).toBeNull();

    const reference = {
      kind: 'turn' as const,
      sessionId: 'session-a',
      turnId: 'turn-1',
      sourceSurface: 'chat',
    };
    expect(validateTaskReferenceInput(reference)).toEqual([]);
    expect(taskReferenceToRelationGraphLinkInput('task-1', reference)).toEqual(
      expect.objectContaining({
        targetType: 'turn',
        targetId: first,
        relationType: 'references_turn',
      }),
    );
  });

  test('turn references reject opaque target and metadata fields', () => {
    expect(
      validateTaskReferenceInput({
        kind: 'turn',
        sessionId: 'session-1',
        turnId: 'turn-1',
        metadata: { copied: 'answer' },
      } as never),
    ).toEqual(['turn references do not accept metadata']);
    expect(
      validateRelationGraphLinkInput({
        sourceType: 'task',
        sourceId: 'task-1',
        targetType: 'turn',
        targetId: 'turn/session-1/turn-1',
        relationType: 'references_external',
      }),
    ).toEqual(['turn links must use relationType references_turn']);
  });

  test('user-input references preserve the exact Session/event tuple and reject noncanonical storage', () => {
    const first = encodeTaskUserInputReference('session-a', 'event-1');
    const secondEvent = encodeTaskUserInputReference('session-a', 'event-2');
    const secondSession = encodeTaskUserInputReference('session-b', 'event-1');
    expect(first).not.toBe(secondEvent);
    expect(first).not.toBe(secondSession);
    expect(parseTaskUserInputReference(first)).toEqual({
      kind: 'user-input',
      sessionId: 'session-a',
      eventId: 'event-1',
    });
    expect(
      parseTaskUserInputReference('user-input/session-a/event%2f1'),
    ).toBeNull();
    expect(
      validateTaskReferenceInput({
        kind: 'user-input',
        sessionId: 'session-a',
        eventId: 'event-1',
        metadata: { prompt: 'must not persist' },
      } as never),
    ).toEqual(['user-input references do not accept metadata']);
    expect(
      validateRelationGraphLinkInput({
        sourceType: 'task',
        sourceId: 'task-1',
        targetType: 'user_input',
        targetId: first,
        relationType: 'references_user_input',
      }),
    ).toEqual([]);
    expect(
      validateTaskReferenceInput({
        kind: 'user-input',
        sessionId: '😀',
        eventId: 'event',
      }),
    ).toEqual([]);
    expect(
      validateTaskReferenceInput({
        kind: 'user-input',
        sessionId: 's'.repeat(MAX_TASK_REFERENCE_ID_LENGTH + 1),
        eventId: 'event',
      }),
    ).toEqual(['sessionId is required']);
    expect(
      validateTaskReferenceInput({
        kind: 'user-input',
        sessionId: '\ud800',
        eventId: 'event',
      }),
    ).toEqual(['sessionId is required']);
    expect(() => encodeTaskUserInputReference('\ud800', 'event')).not.toThrow();
    expect(parseTaskUserInputReference('user-input/%/event')).toBeNull();
  });

  test('tool-result references retain the portable Thread Session/event tuple', () => {
    const first = encodeTaskToolResultReference('session-a', 'event-1');
    const second = encodeTaskToolResultReference('session-a', 'event-2');
    expect(first).not.toBe(second);
    expect(parseTaskToolResultReference(first)).toEqual({
      kind: 'tool-result',
      sessionId: 'session-a',
      eventId: 'event-1',
    });
    expect(
      parseTaskToolResultReference('tool-result/session-a/event%2f1'),
    ).toBeNull();
    expect(
      validateTaskReferenceInput({
        kind: 'tool-result',
        sessionId: 'session-a',
        eventId: 'event-1',
      }),
    ).toEqual([]);
    expect(
      taskReferenceToRelationGraphLinkInput('task-1', {
        kind: 'tool-result',
        sessionId: 'session-a',
        eventId: 'event-1',
      }),
    ).toMatchObject({
      targetType: 'tool_result',
      targetId: first,
      relationType: 'references_tool_result',
    });
    expect(
      validateTaskReferenceInput({
        kind: 'tool-result',
        sessionId: '\ud800',
        eventId: 'event',
      }),
    ).toEqual(['sessionId is required']);
  });

  test('task references reject blank targets and invalid metadata', () => {
    expect(
      validateTaskReferenceInput({ kind: 'artifact', targetId: '   ' }),
    ).toEqual(['targetId is required']);
    expect(
      validateTaskReferenceInput({
        kind: 'receipt',
        targetId: 'receipt-1',
        metadata: { value: Number.NaN },
      }),
    ).toEqual(['metadata must be a JSON object']);
  });

  test('legacy task objects remain valid without additive workspace fields', () => {
    const legacy: TaskRecord = {
      id: 'task-legacy',
      projectId: 'project-alpha',
      title: 'Existing task',
      description: '',
      priority: 'normal',
      status: 'todo',
      createdBy: 'user',
      createdAt: '2026-05-03T00:00:00.000Z',
      updatedAt: '2026-05-03T00:00:00.000Z',
    };

    expect(legacy.workspaceBinding).toBeUndefined();
    expect(legacy.id).toBe('task-legacy');
  });

  test('dispatch session ids are deterministic per task dispatch index', () => {
    expect(createTaskSessionId('task-1', 2)).toBe('task-task-1-2');
  });
});
