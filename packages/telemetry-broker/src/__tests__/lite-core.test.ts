import { expect, test } from 'vitest';
import { ipFamily, networkKey } from '../lite-core.js';

// The Node receiver accepts socket peers with an IPv6 zone ID (link-local
// peers report one); they key by prefix like any IPv6 address.
test('IPv6 addresses with a zone ID key by prefix, not as unavailable', () => {
  expect(networkKey('fe80::1%eth0', 64)).toBe('fe80:0:0:0::/64');
  expect(networkKey('fe80::1%eth0', 48)).toBe('fe80:0:0::/48');
  expect(networkKey('fe80::1%eth0', 64)).toBe(networkKey('fe80::1', 64));
  expect(ipFamily('fe80::1%eth0')).toBe(6);
  for (const invalid of ['fe80::1%', '%eth0', '1.2.3.4%eth0', 'fe80::1%eth0%x'])
    expect(networkKey(invalid, 64)).toBe('unavailable');
});
