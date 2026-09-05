import { parseProjectTaskRoomBrowserDiscovery } from '@kontourai/station-contracts/project-task-room-browser';
import { describe, expect, test, vi } from 'vitest';
import { parseProjectTaskRoomHistoryResponse } from '../../../../packages/sdk/src/client/project-task-rooms.js';
import {
  INTERACTIVE_WORKSPACE_TIMING_MODE,
  INTERACTIVE_WORKSPACE_TIMING_REQUEST_HEADER,
  INTERACTIVE_WORKSPACE_TIMING_RESPONSE_HEADER,
  parseInteractiveWorkspaceBatchTiming,
} from '../../../../src-shared/interactive-workspace-performance-timing.js';
import {
  createProjectTaskRoomRoutes,
  createProjectTaskRoomSseDeliveryQueue,
  settleProjectTaskRoomCadence,
  settleProjectTaskRoomTerminal,
} from '../project-task-rooms.js';

async function successfulData(response: Response): Promise<unknown> {
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected response envelope');
  const prototype = Object.getPrototypeOf(value);
  const success = Object.getOwnPropertyDescriptor(value, 'success');
  const data = Object.getOwnPropertyDescriptor(value, 'data');
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    success?.get ||
    success?.value !== true ||
    !data ||
    data.get ||
    data.set
  )
    throw new Error('expected successful response envelope');
  return data.value;
}

function cadenceHarness(input: {
  readonly cadenceCompleted: boolean;
  readonly rejectCadence?: boolean;
  readonly alive?: boolean;
  readonly rejectAlive?: boolean;
  readonly aborted?: boolean;
}) {
  const unsubscribe = vi.fn();
  const closeTerminal = vi.fn(async () => unsubscribe());
  const writePing = vi.fn(async () => {});
  const subscriptionAlive = vi.fn(async () => {
    if (input.rejectAlive) throw new Error('authority check failed');
    return input.alive ?? true;
  });
  const cadence = input.rejectCadence
    ? Promise.reject(new Error('cadence failed'))
    : Promise.resolve(input.cadenceCompleted);
  return {
    unsubscribe,
    closeTerminal,
    writePing,
    subscriptionAlive,
    settle: () =>
      settleProjectTaskRoomCadence({
        cadence,
        aborted: () => input.aborted === true,
        terminal: () => false,
        subscriptionAlive,
        closeTerminal,
        writePing,
      }),
  };
}

describe('project task room routes', () => {
  test('delivers an accepted document ahead of queued room projections', async () => {
    let releaseFirst!: (alive: boolean) => void;
    const firstAuthority = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    const subscriptionAlive = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(firstAuthority)
      .mockResolvedValue(true);
    const writes: string[] = [];
    const closeTerminal = vi.fn(async () => {});
    const delivery = createProjectTaskRoomSseDeliveryQueue({
      aborted: () => false,
      subscriptionAlive,
      closeTerminal,
      write: async (value) => {
        writes.push(String((value as { marker?: string }).marker));
      },
    });

    delivery.enqueue({ type: 'room', marker: 'room-active' } as never);
    delivery.enqueue({ type: 'room', marker: 'room-queued' } as never);
    delivery.enqueue({ type: 'document', marker: 'document' } as never);
    expect(subscriptionAlive).toHaveBeenCalledOnce();
    releaseFirst(true);
    await vi.waitFor(() => expect(writes).toHaveLength(3));

    expect(writes).toEqual(['room-active', 'document', 'room-queued']);
    expect(subscriptionAlive).toHaveBeenCalledTimes(3);
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  test('writes no priority document after its currentness check is revoked', async () => {
    const write = vi.fn(async () => {});
    const closeTerminal = vi.fn(async () => {});
    const delivery = createProjectTaskRoomSseDeliveryQueue({
      aborted: () => false,
      subscriptionAlive: async () => false,
      closeTerminal,
      write,
    });

    delivery.enqueue({ type: 'document', revision: 'revision-1' });
    await vi.waitFor(() => expect(closeTerminal).toHaveBeenCalledOnce());
    expect(write).not.toHaveBeenCalled();
    expect(delivery.terminal).toBe(true);
  });

  test('terminalizes an overflow while a prior delivery is still settling', async () => {
    let releaseAuthority!: (alive: boolean) => void;
    const authority = new Promise<boolean>((resolve) => {
      releaseAuthority = resolve;
    });
    const write = vi.fn(async () => {});
    const closeTerminal = vi.fn(async () => {});
    const delivery = createProjectTaskRoomSseDeliveryQueue({
      aborted: () => false,
      subscriptionAlive: vi
        .fn<() => Promise<boolean>>()
        .mockReturnValueOnce(authority)
        .mockResolvedValue(true),
      closeTerminal,
      write,
    });

    delivery.enqueue({ type: 'room' });
    for (let index = 0; index < 65; index += 1) {
      delivery.enqueue({ type: 'room', revision: `room-${index}` });
    }
    expect(delivery.terminal).toBe(true);
    releaseAuthority(true);
    await vi.waitFor(() => expect(closeTerminal).toHaveBeenCalledOnce());
    expect(write).not.toHaveBeenCalled();
  });

  test('finishes terminal ownership when both terminal write and close reject', async () => {
    const finish = vi.fn();
    await expect(
      settleProjectTaskRoomTerminal({
        writeTerminal: async () => {
          throw new Error('write failed');
        },
        close: async () => {
          throw new Error('close failed');
        },
        finish,
      }),
    ).rejects.toThrow('Task room terminal delivery failed');
    expect(finish).toHaveBeenCalledOnce();
  });

  test('keeps a successful cadence open with a ping', async () => {
    const fixture = cadenceHarness({ cadenceCompleted: true });
    await fixture.settle();
    expect(fixture.writePing).toHaveBeenCalledOnce();
    expect(fixture.subscriptionAlive).not.toHaveBeenCalled();
    expect(fixture.closeTerminal).not.toHaveBeenCalled();
    expect(fixture.unsubscribe).not.toHaveBeenCalled();
  });

  test('keeps an authorized incomplete cadence open without a ping or terminal', async () => {
    const fixture = cadenceHarness({ cadenceCompleted: false, alive: true });
    await fixture.settle();
    expect(fixture.subscriptionAlive).toHaveBeenCalledOnce();
    expect(fixture.writePing).not.toHaveBeenCalled();
    expect(fixture.closeTerminal).not.toHaveBeenCalled();
    expect(fixture.unsubscribe).not.toHaveBeenCalled();
  });

  test('terminalizes and cleans up an incomplete cadence after authorization revocation', async () => {
    const fixture = cadenceHarness({ cadenceCompleted: false, alive: false });
    await fixture.settle();
    expect(fixture.subscriptionAlive).toHaveBeenCalledOnce();
    expect(fixture.writePing).not.toHaveBeenCalled();
    expect(fixture.closeTerminal).toHaveBeenCalledOnce();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  });

  test('fails closed and cleans up when the cadence authorization recheck rejects', async () => {
    const fixture = cadenceHarness({
      cadenceCompleted: false,
      rejectAlive: true,
    });
    await fixture.settle();
    expect(fixture.subscriptionAlive).toHaveBeenCalledOnce();
    expect(fixture.writePing).not.toHaveBeenCalled();
    expect(fixture.closeTerminal).toHaveBeenCalledOnce();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  });

  test('does not write or clean up after an abort races cadence', async () => {
    const fixture = cadenceHarness({ cadenceCompleted: true, aborted: true });
    await fixture.settle();
    expect(fixture.subscriptionAlive).not.toHaveBeenCalled();
    expect(fixture.writePing).not.toHaveBeenCalled();
    expect(fixture.closeTerminal).not.toHaveBeenCalled();
    expect(fixture.unsubscribe).not.toHaveBeenCalled();
  });

  test('keeps an authorized stream open when cadence rejects', async () => {
    const fixture = cadenceHarness({
      cadenceCompleted: false,
      rejectCadence: true,
      alive: true,
    });
    await fixture.settle();
    expect(fixture.subscriptionAlive).toHaveBeenCalledOnce();
    expect(fixture.writePing).not.toHaveBeenCalled();
    expect(fixture.closeTerminal).not.toHaveBeenCalled();
    expect(fixture.unsubscribe).not.toHaveBeenCalled();
  });

  test('terminalizes and cleans up when rejected cadence finds revoked authority', async () => {
    const fixture = cadenceHarness({
      cadenceCompleted: false,
      rejectCadence: true,
      alive: false,
    });
    await fixture.settle();
    expect(fixture.subscriptionAlive).toHaveBeenCalledOnce();
    expect(fixture.writePing).not.toHaveBeenCalled();
    expect(fixture.closeTerminal).toHaveBeenCalledOnce();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  });

  test('fails closed and cleans up when rejected cadence also rejects authority settlement', async () => {
    const fixture = cadenceHarness({
      cadenceCompleted: false,
      rejectCadence: true,
      rejectAlive: true,
    });
    await fixture.settle();
    expect(fixture.subscriptionAlive).toHaveBeenCalledOnce();
    expect(fixture.writePing).not.toHaveBeenCalled();
    expect(fixture.closeTerminal).toHaveBeenCalledOnce();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  });

  test('feeds the actual browser history projection through the SDK parser', async () => {
    const app = createProjectTaskRoomRoutes({
      history: async () => ({
        kind: 'available',
        records: [
          {
            actor: { kind: 'agent', label: 'Agent' },
            sequence: 1,
            body: {
              kind: 'outcome-link',
              link: {
                kind: 'revision',
                stableId: 'revision-1',
                digest: 'c'.repeat(64),
              },
            },
            digests: {
              proposal: 'a'.repeat(64),
              checkpoint: 'b'.repeat(64),
            },
            integrity: 'L0',
          },
        ],
        checkpoint: {
          throughSeq: 1,
          checkpointDigest: 'b'.repeat(64),
          retainedAnchorSeq: 0,
          retainedAnchorDigest: 'd'.repeat(64),
        },
        hasMore: false,
        integrity: 'L0',
      }),
    } as any);
    const response = await app.request('/task-1/room/history');
    expect(
      parseProjectTaskRoomHistoryResponse(await successfulData(response)),
    ).toMatchObject({
      kind: 'available',
      checkpoint: { throughSeq: 1, retainedAnchorSeq: 0 },
      records: [
        {
          sequence: 1,
          body: {
            kind: 'outcome-link',
            link: { kind: 'revision', stableId: 'revision-1' },
          },
        },
      ],
    });
  });
  test.each([false, true])(
    'derives revision-link capability from resolver composition: %s',
    async (revisionLinksAvailable) => {
      const app = createProjectTaskRoomRoutes({
        discover: async () => ({
          kind: 'existing',
          scope: { projectId: 'project-1', taskId: 'task-1' },
          channelId: 'channel-1',
          assurance: 'L0',
          revisionLinksAvailable,
        }),
      } as any);
      const response = await app.request('/task-1/room');
      const discovery = parseProjectTaskRoomBrowserDiscovery(
        await successfulData(response),
      );
      expect(
        discovery?.kind === 'opened' || discovery?.kind === 'existing'
          ? discovery.capabilities.revisionLinks
          : undefined,
      ).toBe(revisionLinksAvailable);
    },
  );
  test('does not admit caller principal fields and maps hidden authority to not-found', async () => {
    const app = createProjectTaskRoomRoutes({
      discover: async () => ({ kind: 'not-found' }),
      history: async () => ({ kind: 'not-found' }),
      message: async () => ({ kind: 'not-found' }),
      close: async () => ({ kind: 'closed' }),
    } as any);
    expect((await app.request('/task-1/room')).status).toBe(404);
    expect(
      (
        await app.request('/task-1/room/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            proposalId: 'one',
            text: 'hello',
            operatorId: 'forged',
            deviceId: 'forged',
            grant: 'forged',
          }),
        })
      ).status,
    ).toBe(400);
  });

  test('maps conflict, capacity, malformed, and unavailable outcomes precisely', async () => {
    const app = createProjectTaskRoomRoutes({
      discover: async () => ({ kind: 'unavailable' }),
      history: async () => ({ kind: 'invalid-cursor' }),
      message: async ({ proposalId }: { proposalId: string }) =>
        proposalId === 'conflict'
          ? { kind: 'rejected', reason: 'idempotency-conflict' }
          : { kind: 'rejected', reason: 'capacity' },
      close: async () => ({ kind: 'closed' }),
    } as any);
    expect((await app.request('/task-1/room')).status).toBe(503);
    expect((await app.request('/task-1/room/history')).status).toBe(400);
    const post = (proposalId: string) =>
      app.request('/task-1/room/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposalId, text: 'hello' }),
      });
    expect((await post('conflict')).status).toBe(409);
    expect((await post('full')).status).toBe(413);
  });

  test('strictly decodes and forwards bounded history cursors and limits', async () => {
    const calls: unknown[] = [];
    const app = createProjectTaskRoomRoutes({
      history: async (input: unknown) => {
        calls.push(input);
        return {
          kind: 'available',
          records: [],
          hasMore: false,
          integrity: 'L0',
          checkpoint: {
            throughSeq: 0,
            checkpointDigest: 'a'.repeat(64),
            retainedAnchorSeq: 0,
            retainedAnchorDigest: 'b'.repeat(64),
          },
        };
      },
    } as any);
    const cursor = Buffer.from(
      JSON.stringify({
        schemaVersion: 'station.project-task-room-cursor/v1',
        channelId: 'room',
        epoch: 0,
        throughSeq: 1,
        checkpointDigest: 'a'.repeat(64),
        retainedAnchorSeq: 0,
        retainedAnchorDigest: 'b'.repeat(64),
        afterSeq: 0,
        afterEnvelopeDigest: null,
        afterCheckpointDigest: 'c'.repeat(64),
      }),
    ).toString('base64url');
    expect(
      (await app.request(`/task-1/room/history?cursor=${cursor}&limit=2`))
        .status,
    ).toBe(200);
    expect(calls[0]).toMatchObject({ limit: 2, cursor: { afterSeq: 0 } });
    expect((await app.request('/task-1/room/history?limit=00')).status).toBe(
      400,
    );
    expect(calls).toHaveLength(1);
  });

  test('settles an opaque edit receipt without accepting operations or an authority epoch', async () => {
    const calls: unknown[] = [];
    const app = createProjectTaskRoomRoutes({
      submitBatch: async (input: unknown) => {
        calls.push(input);
        return { kind: 'committed', text: 'hello', revision: 'one' };
      },
    } as any);
    const response = await app.request('/task-1/room/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intentId: 'plan-receipt',
        intentDigest: 'a'.repeat(64),
        operations: [{ forged: true }],
        epoch: 99,
      }),
    });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('emits content-free server timing only for the authenticated diagnostic request', async () => {
    const prior = process.env.STATION_PERFORMANCE_REFERENCE;
    process.env.STATION_PERFORMANCE_REFERENCE = '1';
    try {
      const app = createProjectTaskRoomRoutes({
        submitBatch: async (input: {
          onDurableSettlementForDiagnostic?: () => void;
        }) => {
          input.onDurableSettlementForDiagnostic?.();
          return {
            kind: 'committed',
            text: 'private body',
            revision: 'revision-1',
          };
        },
      } as any);
      const post = (diagnostic: boolean) =>
        app.request('/task-1/room/batches', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(diagnostic
              ? {
                  [INTERACTIVE_WORKSPACE_TIMING_REQUEST_HEADER]:
                    INTERACTIVE_WORKSPACE_TIMING_MODE,
                }
              : {}),
          },
          body: JSON.stringify({
            intentId: 'plan-receipt',
            intentDigest: 'a'.repeat(64),
          }),
        });
      const ordinary = await post(false);
      expect(
        ordinary.headers.get(INTERACTIVE_WORKSPACE_TIMING_RESPONSE_HEADER),
      ).toBeNull();
      const diagnostic = await post(true);
      const raw = diagnostic.headers.get(
        INTERACTIVE_WORKSPACE_TIMING_RESPONSE_HEADER,
      );
      expect(raw).not.toContain('private body');
      expect(parseInteractiveWorkspaceBatchTiming(raw)).toMatchObject({
        taskId: 'task-1',
        ingressEpochMs: expect.any(Number),
        acceptedEpochMs: expect.any(Number),
      });
    } finally {
      if (prior === undefined) delete process.env.STATION_PERFORMANCE_REFERENCE;
      else process.env.STATION_PERFORMANCE_REFERENCE = prior;
    }
  });

  test('projects live mutation receipts to the closed browser snapshot', async () => {
    const app = createProjectTaskRoomRoutes({
      live: async () => ({
        kind: 'available',
        generation: 'generation-1',
        viewerActorId: 'actor-viewer',
        result: { outcome: 'updated', receipt: { private: true } },
        snapshot: {
          outcome: 'available',
          snapshot: {
            schemaVersion: 'station.live-work-session/v6',
            scope: {
              projectId: 'project-1',
              taskId: 'task-1',
              surfaceId: 'private-document',
              sessionId: 'generation-1',
              channelId: 'private-channel',
            },
            state: 'active',
            participants: [],
            panes: [],
            typing: [],
            cursors: [],
          },
        },
      }),
    } as any);
    const response = await app.request('/task-1/room/live', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'typing', active: true }),
    });
    const data = await successfulData(response);
    expect(data).toMatchObject({
      kind: 'available',
      generation: 'generation-1',
      viewerActorId: 'actor-viewer',
      result: { outcome: 'updated' },
      snapshot: {
        generation: 'generation-1',
        viewerActorId: 'actor-viewer',
        scope: { projectId: 'project-1', taskId: 'task-1' },
        participants: [],
        panes: [],
        cursors: [],
      },
    });
    expect(JSON.stringify(data)).not.toMatch(
      /private-document|private-channel|receipt|typing/,
    );
  });

  test('reauthorizes immediately before writing an initial room snapshot', async () => {
    const unsubscribe = vi.fn();
    const subscriptionAlive = vi.fn(async () => false);
    const app = createProjectTaskRoomRoutes({
      subscribe: async () => ({
        kind: 'subscribed' as const,
        initial: {
          type: 'snapshot',
          generation: 'generation-1',
          viewerActorId: 'actor-viewer',
          live: { outcome: 'available', snapshot: {} },
          document: { kind: 'snapshot', text: 'must-not-disclose' },
        },
        activate: vi.fn(),
        unsubscribe,
      }),
      subscriptionAlive,
    } as any);
    const response = await app.request('/task-1/room/events');
    const body = await response.text();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subscriptionAlive).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(body).toContain('event: terminal');
    expect(body).not.toContain('must-not-disclose');
  });

  test('unsubscribes when the client aborts while initial authorization is blocked', async () => {
    const unsubscribe = vi.fn();
    const activate = vi.fn();
    let enterAlive: (() => void) | undefined;
    let releaseAlive: ((value: boolean) => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterAlive = resolve;
    });
    const alive = new Promise<boolean>((resolve) => {
      releaseAlive = resolve;
    });
    const app = createProjectTaskRoomRoutes({
      subscribe: async () => ({
        kind: 'subscribed' as const,
        initial: {
          type: 'snapshot',
          generation: 'generation-1',
          viewerActorId: 'actor-viewer',
          live: { outcome: 'available', snapshot: {} },
          document: { kind: 'snapshot', text: 'must-not-disclose' },
        },
        activate,
        unsubscribe,
      }),
      subscriptionAlive: async () => {
        enterAlive?.();
        return alive;
      },
    } as any);
    const controller = new AbortController();
    const response = app.request('/task-1/room/events', {
      signal: controller.signal,
    });
    await entered;
    controller.abort();
    releaseAlive?.(true);
    await Promise.resolve(response).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
  });
});
