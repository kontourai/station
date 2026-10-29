// @vitest-environment node
import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, test } from 'vitest';
import {
  createStationRoutesResolver,
  listenerStationRoutes,
} from '../station-routes.js';

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: null,
  };
}

const INTERFACES = {
  lo: [ipv4('127.0.0.1', true)],
  wlan0: [ipv4('192.168.50.16')],
  tailscale0: [ipv4('100.77.142.114')],
  docker0: [ipv4('203.0.113.4')],
};

describe('listenerStationRoutes', () => {
  test('a wildcard listener reports its LAN and Tailscale addresses on its port', () => {
    expect(
      listenerStationRoutes(
        { address: '0.0.0.0', family: 'IPv4', port: 3774 },
        INTERFACES,
      ),
    ).toEqual([
      { kind: 'lan', url: 'http://192.168.50.16:3774' },
      { kind: 'tailscale', url: 'http://100.77.142.114:3774' },
    ]);
  });

  test('a listener bound to one address reports only that address', () => {
    expect(
      listenerStationRoutes(
        { address: '100.77.142.114', family: 'IPv4', port: 3774 },
        INTERFACES,
      ),
    ).toEqual([{ kind: 'tailscale', url: 'http://100.77.142.114:3774' }]);
  });

  test('a loopback-only or absent listener reports nothing', () => {
    expect(
      listenerStationRoutes(
        { address: '127.0.0.1', family: 'IPv4', port: 3774 },
        INTERFACES,
      ),
    ).toEqual([]);
    expect(listenerStationRoutes(undefined, INTERFACES)).toEqual([]);
  });
});

describe('createStationRoutesResolver', () => {
  test('adds the MagicDNS name, Tailscale Serve origins and the Station identity', async () => {
    const resolve = createStationRoutesResolver({
      boundAddress: () => ({ address: '0.0.0.0', family: 'IPv4', port: 3774 }),
      networkInterfaces: () => INTERFACES,
      servedOrigins: async () => ['https://kontour.python-smelt.ts.net'],
      magicDnsHost: async () => 'kontour.python-smelt.ts.net',
      environmentId: async () => 'env-home',
    });
    expect(await resolve()).toEqual({
      environmentId: 'env-home',
      routes: [
        { kind: 'lan', url: 'http://192.168.50.16:3774' },
        { kind: 'tailscale', url: 'http://100.77.142.114:3774' },
        { kind: 'tailscale', url: 'http://kontour.python-smelt.ts.net:3774' },
        {
          kind: 'tailscale-https',
          url: 'https://kontour.python-smelt.ts.net',
        },
      ],
    });
  });

  test('a failed Tailscale lookup still reports the listener routes', async () => {
    const resolve = createStationRoutesResolver({
      boundAddress: () => ({ address: '0.0.0.0', family: 'IPv4', port: 3774 }),
      networkInterfaces: () => ({ wlan0: [ipv4('192.168.50.16')] }),
      servedOrigins: async () => {
        throw new Error('tailscale unavailable');
      },
      magicDnsHost: async () => {
        throw new Error('tailscale unavailable');
      },
      environmentId: async () => 'env-home',
    });
    expect((await resolve()).routes).toEqual([
      { kind: 'lan', url: 'http://192.168.50.16:3774' },
    ]);
  });

  test('names a Tailscale listener only when it accepts on the Tailscale address', async () => {
    const resolve = createStationRoutesResolver({
      boundAddress: () => ({
        address: '192.168.50.16',
        family: 'IPv4',
        port: 3774,
      }),
      networkInterfaces: () => INTERFACES,
      servedOrigins: async () => undefined,
      magicDnsHost: async () => 'kontour.python-smelt.ts.net',
      environmentId: async () => 'env-home',
    });
    expect((await resolve()).routes).toEqual([
      { kind: 'lan', url: 'http://192.168.50.16:3774' },
    ]);
  });
});
