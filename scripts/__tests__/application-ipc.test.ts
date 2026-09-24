import type { ApplicationChannel } from '@kontourai/station-connect/application-channel';
import { describe, expect, test, vi } from 'vitest';
import {
  ApplicationIpc,
  bridgeApplicationChannels,
} from '../lib/application-ipc.js';

type Packet = Parameters<
  ConstructorParameters<typeof ApplicationIpc>[0]['send']
>[0];
function peers(accept: (channel: ApplicationChannel) => void) {
  const listeners: Array<((value: unknown) => void) | undefined> = [];
  const sent: Packet[][] = [[], []];
  const transport = (side: number) => ({
    send(packet: Packet, done: (error: Error | null) => void) {
      const copy = structuredClone(packet);
      sent[side]!.push(copy);
      queueMicrotask(() => {
        listeners[1 - side]?.(copy);
        done(null);
      });
      return true;
    },
    subscribe(listener: (value: unknown) => void) {
      listeners[side] = listener;
      return () => {
        listeners[side] = undefined;
      };
    },
  });
  const server = new ApplicationIpc(transport(1), accept);
  const client = new ApplicationIpc(transport(0));
  return {
    client,
    server,
    sent,
    inject: (value: unknown) => listeners[1]?.(value),
  };
}

describe('owned application IPC', () => {
  test('routes one channel and propagates cancellation without reopening a retired ID', async () => {
    const received = vi.fn();
    const closed = vi.fn();
    let remote!: ApplicationChannel;
    const h = peers((channel) => {
      remote = channel;
      channel.subscribe((message) => {
        received(message);
        channel.send('response');
      }, closed);
    });
    const channel = h.client.open();
    const response = vi.fn();
    channel.subscribe(response, vi.fn());
    channel.send('request');
    await vi.waitFor(() => expect(response).toHaveBeenCalledWith('response'));
    expect(received).toHaveBeenCalledTimes(1);
    channel.close();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(() => remote.send('late')).toThrow('refused');
    h.inject({
      version: 'station.lab-ipc/v1',
      kind: 'message',
      id: h.sent[0]![0]!.id,
      body: 'late request',
    });
    expect(received).toHaveBeenCalledTimes(1);
    h.client.close();
    h.server.close();
  });
  test('bounds open channels and oversized messages before putting them on IPC', async () => {
    const closed = vi.fn();
    const h = peers((channel) => {
      channel.subscribe(vi.fn(), closed);
    });
    const channels = Array.from({ length: 32 }, () => h.client.open());
    expect(() => h.client.open()).toThrow('admission refused');
    expect(() => channels[0]!.send('x'.repeat(48 * 1024 + 1))).toThrow(
      'message refused',
    );
    expect(h.sent[0]).toHaveLength(32);
    await Promise.resolve();
    h.client.close();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(32));
    h.server.close();
  });
  test('a malformed owned-pipe packet retires all current channels', async () => {
    const h = peers((channel) => {
      channel.subscribe(vi.fn(), vi.fn());
    });
    const channel = h.client.open();
    const closed = vi.fn();
    channel.subscribe(vi.fn(), closed);
    await Promise.resolve();
    h.inject({ version: 'foreign', kind: 'open', id: 'x' });
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(() => channel.send('not delivered')).toThrow();
    h.client.close();
    h.server.close();
  });
  test('a refused destination closes that channel while later admission can proceed', async () => {
    const accept = vi.fn((channel: ApplicationChannel) => {
      channel.subscribe((message) => channel.send(String(message)), vi.fn());
    });
    accept.mockImplementationOnce(() => {
      throw new Error('destination unavailable');
    });
    const h = peers(accept);
    const refused = h.client.open();
    const closed = vi.fn();
    refused.subscribe(vi.fn(), closed);
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    const next = h.client.open();
    const received = vi.fn();
    next.subscribe(received, vi.fn());
    next.send('permitted');
    await vi.waitFor(() =>
      expect(received).toHaveBeenCalledExactlyOnceWith('permitted'),
    );
    h.client.close();
    h.server.close();
  });
  test('failed IPC delivery settles locally without recursive cleanup', () => {
    const send = vi.fn(
      (_packet: Packet, done: (error: Error | null) => void) => {
        done(new Error('pipe closed'));
        return false;
      },
    );
    const ipc = new ApplicationIpc({ send, subscribe: () => () => {} });
    expect(() => ipc.open()).toThrow('capacity exhausted');
    expect(send.mock.calls.length).toBeLessThanOrEqual(2);
    expect(() => ipc.close()).not.toThrow();
  });
  test('a bridge forwards each direction and closes both sides with its owner', async () => {
    let leftRemote!: ApplicationChannel;
    let rightRemote!: ApplicationChannel;
    const receivedLeft = vi.fn();
    const receivedRight = vi.fn();
    const h = peers((channel) => {
      leftRemote = channel;
      channel.subscribe(receivedLeft, vi.fn());
    });
    const source = peers((channel) => {
      rightRemote = channel;
      channel.subscribe(receivedRight, vi.fn());
    });
    const left = h.client.open();
    const right = source.client.open();
    const closeLeft = vi.spyOn(left, 'close');
    const closeRight = vi.spyOn(right, 'close');
    const lifetime = new AbortController();
    const stop = bridgeApplicationChannels(left, right, lifetime.signal);
    await Promise.resolve();
    leftRemote.send('request');
    await vi.waitFor(() =>
      expect(receivedRight).toHaveBeenCalledExactlyOnceWith('request'),
    );
    rightRemote.send('response');
    await vi.waitFor(() =>
      expect(receivedLeft).toHaveBeenCalledExactlyOnceWith('response'),
    );
    lifetime.abort();
    stop();
    expect(closeLeft).toHaveBeenCalledTimes(1);
    expect(closeRight).toHaveBeenCalledTimes(1);
    h.client.close();
    h.server.close();
    source.client.close();
    source.server.close();
  });
});
