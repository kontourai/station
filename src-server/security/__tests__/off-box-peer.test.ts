import { networkInterfaces } from 'node:os';
import { describe, expect, test } from 'vitest';
import { isDefinitelyOffBox } from '../off-box-peer.js';

/**
 * archive#1490. Every case here is written from the same angle: this predicate
 * is the ONLY thing standing between a caller who presented no credential and
 * a persistent Station credential, and it is asked its question in the
 * permissive direction — `true` grants. So the cases that matter are the ones
 * where a wrong `true` is silent.
 */
const HOST_INTERFACES = () => ({
  lo0: [
    { address: '127.0.0.1' },
    { address: '::1' },
    { address: 'fe80::1%lo0' },
  ],
  en0: [
    { address: '192.168.50.16' },
    { address: 'fe80::c1a:2b3c:4d5e:6f70%en0' },
  ],
  utun3: [{ address: '100.101.102.103' }],
});

const options = { networkInterfaces: HOST_INTERFACES };

describe('isDefinitelyOffBox', () => {
  test('grants only for an address this host does not hold', () => {
    // A phone on the same LAN contributes its OWN source address.
    expect(isDefinitelyOffBox('192.168.50.42', options)).toBe(true);
    // A tailnet peer, likewise.
    expect(isDefinitelyOffBox('100.64.7.9', options)).toBe(true);
    // A routable IPv6 peer.
    expect(isDefinitelyOffBox('2001:db8::1234', options)).toBe(true);
  });

  test('refuses loopback in every spelling the socket layer produces', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '[::1]',
    ]) {
      expect(isDefinitelyOffBox(address, options)).toBe(false);
    }
  });

  test('refuses link-local, including the loopback interface own address that classifyRuntimePeer calls remote', () => {
    // The proven instance: reachable under STATION_HOST=:: without a packet
    // leaving the machine, and `classifyRuntimePeer` answers `remote` for it.
    expect(isDefinitelyOffBox('fe80::1%lo0', options)).toBe(false);
    expect(isDefinitelyOffBox('fe80::1', options)).toBe(false);
    expect(isDefinitelyOffBox('febf::abcd', options)).toBe(false);
    expect(isDefinitelyOffBox('169.254.10.11', options)).toBe(false);
  });

  test('refuses every address this host currently holds, zone and spelling aside', () => {
    expect(isDefinitelyOffBox('192.168.50.16', options)).toBe(false);
    expect(isDefinitelyOffBox('100.101.102.103', options)).toBe(false);
    // Same address, different valid spelling on each side of the comparison.
    expect(
      isDefinitelyOffBox('2001:0db8:0000:0000:0000:0000:0000:0001', {
        networkInterfaces: () => ({ en1: [{ address: '2001:db8::1' }] }),
      }),
    ).toBe(false);
    expect(
      isDefinitelyOffBox('2001:db8::1', {
        networkInterfaces: () => ({
          en1: [{ address: '2001:0db8:0000:0000:0000:0000:0000:0001' }],
        }),
      }),
    ).toBe(false);
  });

  test('refuses every spelling of the IPv4-mapped family, which URL canonicalisation produces', () => {
    // `URL` emits RFC 5952 mapped-HEX for anything it does not receive as a
    // dotted quad, so a class predicate written for the dotted spelling alone
    // misses these. Each line below is 127.0.0.1 or an address this host
    // holds, wearing a different hat (archive#1490 delta review H1).
    for (const address of [
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:127.0.0.1',
      '::ffff:127.0.0.1',
      '::7f00:1',
      '[::ffff:7f00:1]',
    ]) {
      expect(isDefinitelyOffBox(address, options)).toBe(false);
    }
    // 192.168.50.16 — the injected en0 address — as mapped hex.
    expect(isDefinitelyOffBox('::ffff:c0a8:3210', options)).toBe(false);
    // The same treatment must not swallow a genuinely off-box peer.
    expect(isDefinitelyOffBox('::ffff:c633:642a', options)).toBe(true);
  });

  test('refuses the real host interface addresses in mapped-hex spelling too', () => {
    const own = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => entry.address);
    expect(own.length).toBeGreaterThan(0);
    for (const address of own) {
      const [a, b, c, d] = address.split('.').map(Number);
      const mapped = `::ffff:${((a << 8) | b).toString(16)}:${(
        (c << 8) | d
      ).toString(16)}`;
      expect(isDefinitelyOffBox(address)).toBe(false);
      expect(isDefinitelyOffBox(mapped)).toBe(false);
    }
  });

  test('refuses an IPv4 whose octets carry leading zeros, rather than guessing which host it means', () => {
    // `010.0.0.1` is 10.0.0.1 to one parser and 8.0.0.1 to another, and is a
    // different STRING from either in a set lookup — so it evaded the host
    // list entirely (archive#1490 delta review L3).
    expect(
      isDefinitelyOffBox('010.0.0.1', {
        networkInterfaces: () => ({ en1: [{ address: '10.0.0.1' }] }),
      }),
    ).toBe(false);
    expect(isDefinitelyOffBox('0192.168.50.16', options)).toBe(false);
    expect(isDefinitelyOffBox('::ffff:010.0.0.1', options)).toBe(false);
    // A host address the enumerator itself spells with leading zeros must not
    // become a hole either: it is unusable for comparison, so the peer that
    // matches it numerically is still refused on its own merits.
    expect(isDefinitelyOffBox('0.0.0.0', options)).toBe(false);
  });

  test('refuses the unspecified address, an unreadable peer, and anything it cannot parse', () => {
    for (const address of [
      '0.0.0.0',
      '::',
      undefined,
      '',
      '   ',
      'absent',
      'localhost',
      'station.example.test',
      '999.1.1.1',
      'not-an-address',
    ]) {
      expect(isDefinitelyOffBox(address, options)).toBe(false);
    }
  });

  test('re-enumerates interfaces on every call, so an address that appears later stops granting', () => {
    // A VPN or container bridge coming up after boot is the failure a cached
    // list produces, and it fails OPEN: the address reads as "not one of ours"
    // and grants.
    let current: Array<{ address: string }> = [];
    const enumerating = { networkInterfaces: () => ({ utun9: current }) };

    expect(isDefinitelyOffBox('10.20.30.40', enumerating)).toBe(true);
    current = [{ address: '10.20.30.40' }];
    expect(isDefinitelyOffBox('10.20.30.40', enumerating)).toBe(false);
  });

  test('reads the real host interfaces when none are injected', () => {
    const real = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .map((entry) => entry.address);
    expect(real.length).toBeGreaterThan(0);
    for (const address of real) {
      expect(isDefinitelyOffBox(address)).toBe(false);
    }
    // 192.0.2.0/24 is TEST-NET-1 and cannot be assigned to a real interface.
    expect(isDefinitelyOffBox('192.0.2.77')).toBe(true);
  });
});
