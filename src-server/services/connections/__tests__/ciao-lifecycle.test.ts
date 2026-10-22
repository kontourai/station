// @vitest-environment node
import dgram from 'node:dgram';
import os from 'node:os';
import { getResponder, type Responder } from '@homebridge/ciao';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the installed, patched package. Only the OS interface inventory and
// UDP transport are replaced; probing, announcement and shutdown are Ciao's.
let failResponses = false;
let failBinding = false;
let stallResponses = false;
const sockets: dgram.Socket[] = [];
const responders = new Set<Responder>();
beforeEach(() => {
  vi.useFakeTimers();
  failResponses = false;
  failBinding = false;
  stallResponses = false;
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    lo0: [
      {
        address: '127.0.0.1',
        family: 'IPv4',
        internal: true,
        netmask: '255.0.0.0',
        cidr: '127.0.0.1/8',
        mac: '00:00:00:00:00:00',
      },
    ],
    'test-lan': [
      {
        address: '192.168.55.2',
        family: 'IPv4',
        internal: false,
        netmask: '255.255.255.0',
        cidr: '192.168.55.2/24',
        mac: '01:02:03:04:05:06',
      },
    ],
  });
  const createSocket = dgram.createSocket.bind(dgram);
  vi.spyOn(dgram, 'createSocket').mockImplementation((...options) => {
    const socket = createSocket(...options);
    sockets.push(socket);
    vi.spyOn(socket, 'bind').mockImplementation((...args) => {
      const callback = args.at(-1);
      queueMicrotask(() => {
        if (typeof callback === 'function') callback();
      });
      return socket;
    });
    vi.spyOn(socket, 'send').mockImplementation((message, ...args) => {
      const callback = args.at(-1);
      const response =
        Buffer.isBuffer(message) && (message.readUInt16BE(2) & 0x8000) !== 0;
      if (stallResponses && response) return;
      queueMicrotask(() => {
        if (typeof callback === 'function')
          callback(
            failResponses && response
              ? new Error('injected UDP send failure')
              : null,
          );
      });
    });
    vi.spyOn(socket, 'close').mockImplementation(() => {
      socket.emit('close');
      return socket;
    });
    vi.spyOn(socket, 'setRecvBufferSize').mockImplementation(() => {});
    vi.spyOn(socket, 'addMembership').mockImplementation(() => {
      if (failBinding) throw new Error('bind membership failed');
    });
    vi.spyOn(socket, 'setMulticastInterface').mockImplementation(() => {});
    vi.spyOn(socket, 'setMulticastTTL').mockReturnValue(255);
    vi.spyOn(socket, 'setTTL').mockReturnValue(255);
    vi.spyOn(socket, 'setMulticastLoopback').mockReturnValue(true);
    return socket;
  });
});
afterEach(async () => {
  for (const responder of responders) {
    const closing = responder.shutdown().catch(() => {});
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
  }
  responders.clear();
  sockets.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function service(name = 'Station lifecycle contract') {
  const responder = getResponder({
    interface: ['test-lan'],
    advertiseIpv6: false,
  });
  responders.add(responder);
  return {
    responder,
    service: responder.createService({
      name,
      type: 'station',
      port: 18441,
      restrictedAddresses: ['192.168.55.2'],
      disabledIpv6: true,
      txt: { v: '1', transport: 'http' },
    }),
  };
}

describe('pinned Ciao lifecycle contract at the UDP boundary', () => {
  it.each(['announcement', 'no-bound-socket'])(
    'rejects advertise for %s failure',
    async (kind) => {
      failResponses = kind === 'announcement';
      failBinding = kind === 'no-bound-socket';
      const instance = service();
      const outcome = instance.service.advertise().then(
        () => 'published',
        () => 'failed',
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(await outcome).toBe('failed');
      if (kind === 'announcement') expect(sockets[0].send).toHaveBeenCalled();
    },
  );
  it.each(['rejected', 'stalled'])(
    'closes UDP sockets for %s goodbye sends',
    async (kind) => {
      const instance = service();
      const published = instance.service.advertise();
      await vi.advanceTimersByTimeAsync(5000);
      await published;
      failResponses = kind === 'rejected';
      stallResponses = kind === 'stalled';
      responders.delete(instance.responder);
      const outcome = instance.responder.shutdown().then(
        () => 'closed',
        () => 'failed',
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(await outcome).toBe('failed');
      expect(sockets.length).toBeGreaterThan(0);
      for (const socket of sockets) expect(socket.close).toHaveBeenCalledOnce();
    },
  );
  it('withdraws only one service when two owners share a responder', async () => {
    const first = service('Station first');
    const second = service('Station second');
    expect(first.responder).toBe(second.responder);
    const advertised = Promise.all([
      first.service.advertise(),
      second.service.advertise(),
    ]);
    await vi.advanceTimersByTimeAsync(10000);
    await advertised;
    const withdrawn = first.service.destroy();
    await vi.advanceTimersByTimeAsync(500);
    await withdrawn;
    await first.responder.shutdown();
    expect([...second.responder.getAnnouncedServices()]).toEqual([
      second.service,
    ]);
    for (const socket of sockets) expect(socket.close).not.toHaveBeenCalled();
    const last = second.service.destroy();
    await vi.advanceTimersByTimeAsync(500);
    await last;
    responders.delete(second.responder);
    await second.responder.shutdown();
    for (const socket of sockets) expect(socket.close).toHaveBeenCalledOnce();
  });
  it('does not allocate sockets after shutdown beats asynchronous interface initialization', async () => {
    const instance = service();
    responders.delete(instance.responder);
    await instance.responder.shutdown();
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(0);
  });
});
