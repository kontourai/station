import { describe, expect, test } from 'vitest';
import {
  decideEgress,
  type EgressPolicy,
  type RegisteredLocalTarget,
} from '../egress-policy.js';
import { deriveStationListeners } from '../station-listeners.js';

const listeners = deriveStationListeners({
  serverPort: 4100,
  configuredOrigins: [],
});
const interfaces = ['192.168.1.20', '100.64.0.7', '203.0.113.5'];

function policy(
  reach: 'operator' | 'project',
  targets: RegisteredLocalTarget[] = [],
): EgressPolicy {
  return {
    listeners: () => listeners,
    interfaceAddresses: () => interfaces,
    reach:
      reach === 'operator'
        ? { kind: 'operator' }
        : { kind: 'project', localTargets: () => targets },
  };
}

describe('every profile: Station listeners, in every spelling', () => {
  test.each([
    '127.0.0.1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '::127.0.0.1',
    '::1',
    '0.0.0.0',
    '192.168.1.20',
    '100.64.0.7',
  ])('%s:4100 is refused for operator and project', (address) => {
    expect(decideEgress(address, 4100, policy('operator'))).toBe(
      'station-listener',
    );
    expect(decideEgress(address, 4100, policy('project'))).toBe(
      'station-listener',
    );
  });

  test('the proxy never forwards to its own port', () => {
    expect(decideEgress('127.0.0.1', 5555, policy('operator'), 5555)).toBe(
      'station-listener',
    );
  });

  test('a registered target on a Station port is still refused', () => {
    const p = policy('project', [{ host: '127.0.0.1', port: 4100 }]);
    expect(decideEgress('127.0.0.1', 4100, p)).toBe('station-listener');
  });
});

describe('operator reach (D7): everything else', () => {
  test.each([
    ['127.0.0.1', 5173],
    ['::ffff:7f00:1', 5173],
    ['10.0.0.9', 80],
    ['169.254.169.254', 80],
    ['93.184.216.34', 443],
  ])('%s:%i is allowed', (address, port) => {
    expect(decideEgress(address, port, policy('operator'))).toBeUndefined();
  });
});

describe('Project admin reach (D7): public plus registered targets', () => {
  test.each([
    ['127.0.0.1', 5173],
    ['::ffff:7f00:1', 5173],
    ['0:0:0:0:0:ffff:7f00:1', 5173],
    ['::1', 5173],
    ['10.0.0.9', 80],
    ['172.20.0.1', 80],
    ['192.168.1.1', 80],
    ['169.254.169.254', 80],
    ['::ffff:a9fe:a9fe', 80],
    ['100.100.100.100', 80],
    ['fd12::1', 80],
    ['fe80::1', 80],
    ['0.5.6.7', 80],
    ['224.0.0.251', 80],
    // This host's own public interface address is local, not "the internet".
    ['203.0.113.5', 8080],
  ])('%s:%i is refused', (address, port) => {
    expect(decideEgress(address, port, policy('project'))).toBe(
      'non-public-address',
    );
  });

  test.each([
    ['93.184.216.34', 443],
    ['2606:4700:4700::1111', 443],
  ])('public %s:%i is allowed', (address, port) => {
    expect(decideEgress(address, port, policy('project'))).toBeUndefined();
  });

  test('a registered loopback target admits exactly that port, any loopback spelling', () => {
    const p = policy('project', [{ host: 'localhost', port: 5173 }]);
    expect(decideEgress('127.0.0.1', 5173, p)).toBeUndefined();
    expect(decideEgress('::1', 5173, p)).toBeUndefined();
    expect(decideEgress('::ffff:7f00:1', 5173, p)).toBeUndefined();
    expect(decideEgress('127.0.0.1', 5174, p)).toBe('non-public-address');
    expect(decideEgress('192.168.1.1', 5173, p)).toBe('non-public-address');
  });

  test('a registered LAN target admits exactly that address and port', () => {
    const p = policy('project', [{ host: '192.168.1.50', port: 8080 }]);
    expect(decideEgress('192.168.1.50', 8080, p)).toBeUndefined();
    expect(decideEgress('::ffff:c0a8:0132', 8080, p)).toBeUndefined();
    expect(decideEgress('192.168.1.51', 8080, p)).toBe('non-public-address');
  });

  test('targets are read live: unregistering applies to the next decision', () => {
    const targets: RegisteredLocalTarget[] = [
      { host: 'localhost', port: 5173 },
    ];
    const p = policy('project', targets);
    expect(decideEgress('127.0.0.1', 5173, p)).toBeUndefined();
    targets.pop();
    expect(decideEgress('127.0.0.1', 5173, p)).toBe('non-public-address');
  });

  test('non-IP and out-of-range input is invalid', () => {
    expect(decideEgress('example.com', 80, policy('operator'))).toBe(
      'invalid-target',
    );
    expect(decideEgress('1.2.3.4', 0, policy('operator'))).toBe(
      'invalid-target',
    );
  });
});
