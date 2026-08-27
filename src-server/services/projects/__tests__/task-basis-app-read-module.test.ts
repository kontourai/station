import type { StationTaskBasisCollection } from '@kontourai/station-contracts/task-basis';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { createTaskBasisAppReadModule } from '../task-basis-app-read-module.js';

const authority = sessionReadAuthorityFromRequest(
  'owner',
  undefined,
  undefined,
);
function collection(count = 1): StationTaskBasisCollection {
  const result: StationTaskBasisCollection = {
    version: 'station.task-basis-collection/v4',
    taskId: 'task-a',
    answers: [
      {
        answerReferenceId: 'answer-a',
        projection: {
          version: 'surface.basis-projection/v1',
          answer: {
            owner: { authority: '@kontourai/thread' },
            state: 'available',
            observedAt: '2026-08-25T00:00:00.000Z',
            value: {
              ref: {
                authority: '@kontourai/thread',
                schemaVersion: '1.2.0',
                kind: 'assistant-message',
                standing: 'observed',
                threadId: 'session-a',
                messageId: 'message-a',
              },
              fact: 'answer-observed',
              observedAt: '2026-08-25T00:00:00.000Z',
            },
          },
          standing: 'execution-only',
          unresolvedReason: null,
          assessment: {
            owner: { authority: '@kontourai/surface' },
            state: 'not-captured',
            observedAt: '2026-08-25T00:00:00.000Z',
          },
          regions: {
            inputs: [],
            execution: [],
            process: [],
            outcomes: [],
            support: [],
            sources: [],
            live: [],
          },
          relationships: [],
          gaps: [],
        },
      },
    ],
    unassociated: [],
    keptToolResults: [],
    keptGateEvaluations: [],
    gaps: [],
  };
  const base = result.answers[0]!;
  const availableAnswer = base.projection.answer;
  if (availableAnswer.state !== 'available')
    throw new Error('fixture answer must be available');
  return {
    ...result,
    answers: Array.from({ length: count }, (_, index) => ({
      ...base,
      answerReferenceId: `answer-${index}`,
      projection: {
        ...base.projection,
        answer: {
          ...availableAnswer,
          value: {
            ...availableAnswer.value,
            ref: {
              ...availableAnswer.value.ref,
              messageId: `message-${index}`,
            },
          },
        },
      },
    })),
  };
}

describe('TaskBasisAppReadModule', () => {
  test('fails closed for replay, caller substitution, and hosted authority', async () => {
    const read = vi.fn(async () => ({
      status: 'found' as const,
      data: collection(9),
    }));
    const module = createTaskBasisAppReadModule({
      read,
      isEnabled: () => true,
    });
    const opened = await module.open({
      taskId: 'task-a',
      callerBinding: 'a'.repeat(24),
      authority,
    });
    expect(opened.status).toBe('available');
    if (opened.status !== 'available') return;
    const consumed = await module.continue({
      taskId: 'task-a',
      occurrenceId: opened.occurrenceId,
      continuationToken: opened.continuationToken ?? 'x'.repeat(24),
      callerBinding: 'a'.repeat(24),
      authority,
    });
    expect(consumed.status).toBe('available');
    const replay = await module.continue({
      taskId: 'task-a',
      occurrenceId: opened.occurrenceId,
      continuationToken: opened.continuationToken!,
      callerBinding: 'a'.repeat(24),
      authority,
    });
    expect(replay).toEqual({ status: 'unavailable' });
    const wrongCaller = await module.continue({
      taskId: 'task-a',
      occurrenceId: opened.occurrenceId,
      continuationToken: opened.continuationToken!,
      callerBinding: 'b'.repeat(24),
      authority,
    });
    expect(wrongCaller).toEqual({ status: 'unavailable' });
    expect(
      await module.open({
        taskId: 'task-a',
        callerBinding: 'c'.repeat(24),
        authority: { ...authority, mode: 'hosted' } as never,
      }),
    ).toEqual({ status: 'unavailable' });
  });

  test('a valid token is single-use and a changed collection is terminal', async () => {
    let current = collection(9);
    const read = vi.fn(async () => ({
      status: 'found' as const,
      data: current,
    }));
    const module = createTaskBasisAppReadModule({
      read,
      isEnabled: () => true,
    });
    const opened = await module.open({
      taskId: 'task-a',
      callerBinding: 'a'.repeat(24),
      authority,
    });
    expect(opened.status).toBe('available');
    if (opened.status !== 'available' || !opened.continuationToken) return;
    current = { ...current, gaps: [{ state: 'restricted' as const }] };
    await expect(
      module.continue({
        taskId: 'task-a',
        occurrenceId: opened.occurrenceId,
        continuationToken: opened.continuationToken,
        callerBinding: 'a'.repeat(24),
        authority,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    await expect(
      module.continue({
        taskId: 'task-a',
        occurrenceId: opened.occurrenceId,
        continuationToken: opened.continuationToken,
        callerBinding: 'a'.repeat(24),
        authority,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(read).toHaveBeenCalledTimes(4);
  });

  test('consumes a token before owner await and revoke prevents late publication', async () => {
    let resolve!: (value: {
      status: 'found';
      data: ReturnType<typeof collection>;
    }) => void;
    const read = vi.fn(
      () =>
        new Promise<
          typeof resolve extends (value: infer T) => void ? T : never
        >((r) => {
          resolve = r as never;
        }),
    );
    const module = createTaskBasisAppReadModule({
      read,
      isEnabled: () => true,
    });
    const pending = module.open({
      taskId: 'task-a',
      callerBinding: 'a'.repeat(24),
      authority,
    });
    await Promise.resolve();
    module.revoke('task-a', 'a'.repeat(24));
    resolve({ status: 'found', data: collection() });
    await expect(pending).resolves.toEqual({ status: 'unavailable' });
    expect(read).toHaveBeenCalledOnce();
  });

  test('terminates when render policy revokes during owner read', async () => {
    let enabled = true;
    const module = createTaskBasisAppReadModule({
      read: async () => {
        enabled = false;
        return { status: 'found', data: collection() };
      },
      isEnabled: () => enabled,
    });
    await expect(
      module.open({
        taskId: 'task-a',
        callerBinding: 'a'.repeat(24),
        authority,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  test('withholds a page when the final whole-response owner fence loses Flow membership', async () => {
    let reads = 0;
    const module = createTaskBasisAppReadModule({
      read: async () =>
        ++reads === 1
          ? { status: 'found' as const, data: collection() }
          : { status: 'unavailable' as const },
      isEnabled: () => true,
    });
    await expect(
      module.open({
        taskId: 'task-a',
        callerBinding: 'a'.repeat(24),
        authority,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(reads).toBe(2);
  });

  test('withholds a page when policy changes during the final owner read', async () => {
    let current = true;
    let reads = 0;
    const module = createTaskBasisAppReadModule({
      read: async () => {
        reads += 1;
        if (reads === 2) current = false;
        return { status: 'found' as const, data: collection() };
      },
      isEnabled: () => true,
      capturePublicationPolicy: async () => ({ witness: 'captured' }),
      isPublicationPolicyCurrent: () => current,
    });
    await expect(
      module.open({
        taskId: 'task-a',
        callerBinding: 'a'.repeat(24),
        authority,
      }),
    ).resolves.toEqual({ status: 'unavailable' });
  });

  test('cannot publish after revoke while the second policy check is pending', async () => {
    let releasePolicy!: (value: boolean) => void;
    let calls = 0;
    const module = createTaskBasisAppReadModule({
      read: async () => ({ status: 'found' as const, data: collection() }),
      isEnabled: () =>
        ++calls === 1
          ? true
          : new Promise<boolean>((resolve) => {
              releasePolicy = resolve;
            }),
    });
    const pending = module.open({
      taskId: 'task-a',
      callerBinding: 'a'.repeat(24),
      authority,
    });
    while (calls < 2) await Promise.resolve();
    module.revoke('task-a', 'a'.repeat(24));
    releasePolicy(true);
    await expect(pending).resolves.toEqual({ status: 'unavailable' });
  });

  test('cannot publish after TTL expires while the second policy check is pending', async () => {
    let at = 0;
    let releasePolicy!: (value: boolean) => void;
    let calls = 0;
    const module = createTaskBasisAppReadModule({
      read: async () => ({ status: 'found' as const, data: collection() }),
      isEnabled: () =>
        ++calls === 1
          ? true
          : new Promise<boolean>((resolve) => {
              releasePolicy = resolve;
            }),
      now: () => at,
    });
    const pending = module.open({
      taskId: 'task-a',
      callerBinding: 'a'.repeat(24),
      authority,
    });
    while (calls < 2) await Promise.resolve();
    at = 5 * 60_000 + 1;
    releasePolicy(true);
    await expect(pending).resolves.toEqual({ status: 'unavailable' });
  });
});
