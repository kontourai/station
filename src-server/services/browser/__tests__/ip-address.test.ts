import { describe, expect, test } from 'vitest';
import {
  canonicalIp,
  isLoopbackIp,
  isNonPublicIp,
  LOOPBACK_RANGES,
  NON_PUBLIC_RANGES,
} from '../ip-address.js';

describe('canonicalIp: every spelling of one address is one address', () => {
  test.each([
    // IPv4-mapped IPv6: dotted, Chromium's hex canonical form, fully expanded.
    ['::ffff:127.0.0.1', 4, '127.0.0.1'],
    ['[::ffff:7f00:1]', 4, '127.0.0.1'],
    ['::FFFF:7F00:0001', 4, '127.0.0.1'],
    ['0:0:0:0:0:ffff:7f00:1', 4, '127.0.0.1'],
    ['0000:0000:0000:0000:0000:ffff:7f00:0001', 4, '127.0.0.1'],
    ['::ffff:a9fe:a9fe', 4, '169.254.169.254'],
    ['::ffff:c0a8:0101', 4, '192.168.1.1'],
    // IPv4-compatible (deprecated) forms embed IPv4 too.
    ['::127.0.0.1', 4, '127.0.0.1'],
    ['::7f00:1', 4, '127.0.0.1'],
    // Genuine IPv6 stays IPv6.
    ['::1', 6, '0:0:0:0:0:0:0:1'],
    ['[::1]', 6, '0:0:0:0:0:0:0:1'],
    ['0:0:0:0:0:0:0:1', 6, '0:0:0:0:0:0:0:1'],
    ['::', 6, '0:0:0:0:0:0:0:0'],
    ['fe80::1%en0', 6, 'fe80:0:0:0:0:0:0:1'],
    ['2001:db8::1', 6, '2001:db8:0:0:0:0:0:1'],
    ['127.0.0.1', 4, '127.0.0.1'],
  ])('%s -> IPv%i %s', (input, family, address) => {
    expect(canonicalIp(input)).toEqual({ family, address });
  });

  test.each([
    ['localhost'],
    ['example.com'],
    ['1.2.3'],
    ['::ffff:1.2.3'],
    ['1::2::3'],
    [''],
  ])('%j is not an IP literal', (input) => {
    expect(canonicalIp(input)).toBeUndefined();
  });
});

describe('range membership after normalization', () => {
  test.each([
    ['[::ffff:7f00:1]', true],
    ['0:0:0:0:0:ffff:7f00:1', true],
    ['::127.0.0.1', true],
    ['127.9.9.9', true],
    ['::1', true],
    ['0.0.0.0', true],
    ['10.0.0.1', false],
  ])('loopback %s -> %s', (input, loopback) => {
    const ip = canonicalIp(input);
    expect(ip && isLoopbackIp(ip)).toBe(loopback);
  });

  test.each([
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.0.1', true],
    ['169.254.169.254', true],
    ['::ffff:a9fe:a9fe', true],
    ['100.64.0.1', true],
    ['100.127.255.255', true],
    ['100.128.0.1', false],
    ['fd00::1', true],
    ['fe80::1', true],
    ['ff02::1', true],
    ['224.0.0.1', true],
    ['0.1.2.3', true],
    ['8.8.8.8', false],
    // Round 2: translation/tunnel prefixes and site-local.
    ['64:ff9b::7f00:1', true],
    ['64:ff9b::808:808', true],
    ['2002:7f00:1::1', true],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', true],
    ['::ffff:0:7f00:1', true],
    ['fec0::1', true],
    ['2001:db8::1', false],
    ['2606:4700:4700::1111', false],
  ])('non-public %s -> %s', (input, nonPublic) => {
    const ip = canonicalIp(input);
    expect(ip && isNonPublicIp(ip)).toBe(nonPublic);
  });

  test('the pinned range lists', () => {
    expect(LOOPBACK_RANGES).toEqual({
      v4: ['127.0.0.0/8', '0.0.0.0/8'],
      v6: ['::1/128', '::/128'],
    });
    expect(NON_PUBLIC_RANGES).toEqual({
      v4: [
        '0.0.0.0/8',
        '10.0.0.0/8',
        '100.64.0.0/10',
        '127.0.0.0/8',
        '169.254.0.0/16',
        '172.16.0.0/12',
        '192.0.0.0/24',
        '192.168.0.0/16',
        '198.18.0.0/15',
        '224.0.0.0/4',
        '240.0.0.0/4',
      ],
      v6: [
        '::/128',
        '::1/128',
        '::ffff:0:0:0/96',
        '64:ff9b::/96',
        '2001::/32',
        '2002::/16',
        'fc00::/7',
        'fe80::/10',
        'fec0::/10',
        'ff00::/8',
      ],
    });
  });
});
