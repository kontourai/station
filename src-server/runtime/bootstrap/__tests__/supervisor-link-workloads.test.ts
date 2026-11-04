// @vitest-environment node
/**
 * The core side of protocol 1.3 workloads, driven through a fake IPC process:
 * the capability handshake, request/reply, and the order of replies and
 * events.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  installListenerLink,
  type SupervisorChannelProcess,
  SupervisorLink,
  supervisorWorkloadChannel,
} from '../supervisor-link.js';

class FakeChannel extends EventEmitter {
  readonly env: NodeJS.ProcessEnv = { STATION_SUPERVISOR_IPC: '1' };
  connected = true;
  writable = true;
  readonly sent: Array<{ type: string } & Record<string, unknown>> = [];
  readonly exit = vi.fn((_code: number) => {});
  readonly send = vi.fn(
    (
      message: { type: string } & Record<string, unknown>,
      _handle?: unknown,
      _options?: undefined,
      callback?: (error: Error | null) => void,
    ) => {
      this.sent.push(message);
      callback?.(null);
      return this.writable;
    },
  );
}

async function promoted(capabilities?: string[]) {
  const channel = new FakeChannel();
  const link = new SupervisorLink({
    process: channel as unknown as SupervisorChannelProcess,
    log: () => {},
  });
  const parked = link.park();
  channel.emit('message', {
    type: 'promote',
    listeners: [],
    ...(capabilities ? { capabilities } : {}),
  });
  await parked;
  return { channel, link };
}

describe('supervisor workloads on the core link (protocol 1.3)', () => {
  it('announces workloads and uses them only when the supervisor grants them', async () => {
    const granted = await promoted(['workloads']);
    expect(granted.channel.sent[0]).toMatchObject({
      type: 'parked',
      capabilities: expect.arrayContaining(['workloads']),
    });
    expect(granted.link.workloads).toBe(true);
    installListenerLink(granted.link);
    expect(supervisorWorkloadChannel()).toBe(granted.link);

    // A 1.2 supervisor promotes without capabilities: terminals stay local.
    const older = await promoted();
    expect(older.link.workloads).toBe(false);
    installListenerLink(older.link);
    expect(supervisorWorkloadChannel()).toBeNull();
    await expect(
      older.link.requestWorkload({ op: 'list' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(older.channel.sent.map((m) => m.type)).not.toContain(
      'workload.request',
    );
    installListenerLink(null);
  });

  it.each([true, false])(
    'answers accepted requests when IPC is writable=%s, and preserves workload errors',
    async (writable) => {
      const { channel, link } = await promoted(['workloads']);
      channel.writable = writable;
      const listed = link.requestWorkload({ op: 'list' });
      const failed = link.requestWorkload({ op: 'attach', workloadId: 'gone' });
      const results = Promise.allSettled([listed, failed]);
      const [first, second] = channel.sent.filter(
        (m) => m.type === 'workload.request',
      );
      channel.emit('message', {
        type: 'workload.response',
        id: second?.id,
        ok: false,
        code: 'not-found',
        message: 'no such workload',
      });
      channel.emit('message', {
        type: 'workload.response',
        id: first?.id,
        ok: true,
        result: [],
      });
      await expect(results).resolves.toEqual([
        { status: 'fulfilled', value: [] },
        {
          status: 'rejected',
          reason: expect.objectContaining({ code: 'not-found' }),
        },
      ]);
      expect(
        channel.sent.filter((m) => m.type === 'workload.request'),
      ).toHaveLength(2);
    },
  );

  it.each([true, false])(
    'rejects an IPC send-callback failure with writable=%s',
    async (writable) => {
      const { channel, link } = await promoted(['workloads']);
      let flushed: ((error: Error | null) => void) | undefined;
      channel.send.mockImplementationOnce(
        (_message, _handle, _options, callback) => {
          flushed = callback;
          return writable;
        },
      );
      const settled = vi.fn();
      const pending = link.requestWorkload({ op: 'list' }).then(
        (result) => settled({ result }),
        (error: unknown) => settled({ error }),
      );
      try {
        expect(flushed).toBeTypeOf('function');
        const cause = new Error('IPC write failed');
        flushed?.(cause);
        await Promise.resolve();
        expect(settled).toHaveBeenCalledWith({
          error: expect.objectContaining({ code: 'unavailable', cause }),
        });
      } finally {
        channel.connected = false;
        channel.emit('disconnect');
        await pending;
      }
    },
  );

  it.each(['closed', 'throw'])(
    'refuses a workload request when the IPC channel is %s',
    async (failure) => {
      const { channel, link } = await promoted(['workloads']);
      if (failure === 'closed') channel.connected = false;
      else
        channel.send.mockImplementationOnce(() => {
          throw new Error('IPC send threw');
        });
      await expect(link.requestWorkload({ op: 'list' })).rejects.toMatchObject({
        code: 'unavailable',
      });
    },
  );

  it('delivers an event the supervisor sent after a reply only once the requester has seen that reply', async () => {
    const { channel, link } = await promoted(['workloads']);
    const heard: string[] = [];
    const attached = link.requestWorkload({ op: 'attach', workloadId: 'w1' });
    const subscribed = attached.then(() =>
      link.onWorkloadEvent((event) => heard.push(event.event)),
    );
    const request = channel.sent.find((m) => m.type === 'workload.request');
    // Node can deliver both in one turn: the reply, then the exit after it.
    channel.emit('message', {
      type: 'workload.response',
      id: request?.id,
      ok: true,
      result: { workloadId: 'w1', state: 'running' },
    });
    channel.emit('message', {
      type: 'workload.event',
      workloadId: 'w1',
      event: 'exit',
      exit: {
        exitCode: 0,
        signal: null,
        outputIncomplete: false,
        journalFailed: false,
      },
    });
    await subscribed;
    await vi.waitFor(() => expect(heard).toEqual(['exit']));
  });

  it('fails requests still waiting when the supervisor goes away', async () => {
    const { channel, link } = await promoted(['workloads']);
    const pending = link.requestWorkload({ op: 'list' });
    channel.connected = false;
    channel.emit('disconnect');
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
    expect(link.workloads).toBe(false);
  });
});
