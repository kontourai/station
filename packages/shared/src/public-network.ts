import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
export interface DnsAddress {
  address: string;
  family: 4 | 6;
}
export function createPinnedLookup(selected: DnsAddress): typeof dnsLookup {
  return ((
    _hostname: string,
    options: unknown,
    callback: (...args: unknown[]) => void,
  ) => {
    const all =
      typeof options === 'object' &&
      options !== null &&
      'all' in options &&
      (options as { all?: boolean }).all === true;
    if (all) {
      callback(null, [{ address: selected.address, family: selected.family }]);
    } else {
      callback(null, selected.address, selected.family);
    }
  }) as typeof dnsLookup;
}

function ipv4Number(address: string): number {
  return (
    address
      .split('.')
      .reduce((value, octet) => value * 256 + Number(octet), 0) >>> 0
  );
}

function inV4Range(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

const deniedV4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function parseIpv6(rawAddress: string): bigint | null {
  const address = rawAddress.toLowerCase().split('%')[0];
  if (isIP(address) !== 6) return null;
  let normalized = address;
  const dottedTail = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const value = ipv4Number(dottedTail);
    normalized = `${normalized.slice(0, -dottedTail.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill('0'),
    ...right,
  ];
  if (groups.length !== 8) return null;
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group || '0'}`),
    0n,
  );
}

function ipv6Prefix(base: string, bits: number): [bigint, number] {
  const value = parseIpv6(base);
  if (value === null) throw new Error(`Invalid internal IPv6 prefix: ${base}`);
  return [value, bits];
}

function inV6Range(value: bigint, [base, bits]: [bigint, number]): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === base >> shift;
}

const globalV6 = ipv6Prefix('2000::', 3);
const deniedV6 = [
  ipv6Prefix('2001::', 32),
  ipv6Prefix('2001:2::', 48),
  ipv6Prefix('2001:10::', 28),
  ipv6Prefix('2001:20::', 28),
  ipv6Prefix('2001:db8::', 32),
  ipv6Prefix('2002::', 16),
];

export function isPublicIp(rawAddress: string): boolean {
  if (rawAddress.includes('%')) return false;
  const address = rawAddress.toLowerCase().split('%')[0];
  const family = isIP(address);
  if (family === 4)
    return !deniedV4.some(([base, bits]) => inV4Range(address, base, bits));
  const value = parseIpv6(address);
  if (value === null) return false;
  if (value >> 32n === 0xffffn) {
    const mapped = Number(value & 0xffffffffn);
    const ipv4 = `${mapped >>> 24}.${(mapped >>> 16) & 0xff}.${(mapped >>> 8) & 0xff}.${mapped & 0xff}`;
    return isPublicIp(ipv4);
  }
  return (
    inV6Range(value, globalV6) &&
    !deniedV6.some((prefix) => inV6Range(value, prefix))
  );
}

export async function resolvePublicAddress(
  hostname: string,
  dependencies: { lookup: (hostname: string) => Promise<DnsAddress[]> } = {
    lookup: (hostname) =>
      new Promise((resolve, reject) =>
        dnsLookup(
          hostname,
          { all: true, verbatim: true },
          (error, addresses) =>
            error ? reject(error) : resolve(addresses as DnsAddress[]),
        ),
      ),
  },
): Promise<DnsAddress> {
  const normalizedHostname =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  const literalFamily = isIP(normalizedHostname);
  const answers = literalFamily
    ? [{ address: normalizedHostname, family: literalFamily as 4 | 6 }]
    : await dependencies.lookup(normalizedHostname);
  if (
    !answers.length ||
    answers.some(
      ({ address, family }) =>
        isIP(address.toLowerCase().split('%')[0]) !== family ||
        !isPublicIp(address),
    )
  ) {
    throw new Error('disallowed_target');
  }
  return answers[0];
}
