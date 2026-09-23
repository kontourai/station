/**
 * IP literal parsing for the Browser pane's egress decisions (#90).
 *
 * Every address decision is made on PARSED bytes, never on string shape.
 * Chromium canonicalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, and
 * `0:0:0:0:0:ffff:7f00:1` or `::127.0.0.1` spell the same IPv4 address; a
 * string comparison that only unmaps the dotted form lets all of them past a
 * loopback check (review H1). Here any IPv4-mapped (`::ffff:0:0/96`) or
 * IPv4-compatible (`::/96`, except `::` and `::1`) IPv6 address is the IPv4
 * address it embeds, and the ranges are checked with `net.BlockList`.
 */
import { BlockList, isIP } from 'node:net';

export interface CanonicalIp {
  family: 4 | 6;
  /** Canonical text: dotted IPv4, or eight lower-case uncompressed groups. */
  address: string;
}

function stripDecorations(input: string): string {
  let value = input.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  return value;
}

function parseIpv6Bytes(value: string): number[] | undefined {
  let text = value;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    if (isIP(maybeV4) !== 4) return undefined;
    for (const part of maybeV4.split('.')) tail.push(Number(part));
    // Replace the dotted tail with two placeholder groups for counting.
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parseGroups = (part: string) =>
    part === '' ? [] : part.split(':').map((g) => Number.parseInt(g, 16));
  const head = parseGroups(halves[0] ?? '');
  const rest = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [
    ...head,
    ...new Array(halves.length === 2 ? missing : 0).fill(0),
    ...rest,
  ];
  if (
    groups.length !== 8 ||
    groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)
  )
    return undefined;
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** Parse any IP literal spelling; undefined when it is not an IP literal. */
export function canonicalIp(input: string): CanonicalIp | undefined {
  const value = stripDecorations(input);
  const kind = isIP(value);
  if (kind === 4) {
    return { family: 4, address: value.split('.').map(Number).join('.') };
  }
  if (kind !== 6) return undefined;
  const bytes = parseIpv6Bytes(value);
  if (!bytes) return undefined;
  const firstTenZero = bytes.slice(0, 10).every((b) => b === 0);
  const mapped = firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible =
    firstTenZero &&
    bytes[10] === 0 &&
    bytes[11] === 0 &&
    // `::` and `::1` are genuine IPv6 addresses, not embedded IPv4.
    !(bytes.slice(12, 15).every((b) => b === 0) && (bytes[15] ?? 0) <= 1);
  if (mapped || compatible) {
    return { family: 4, address: bytes.slice(12).join('.') };
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2)
    groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  return { family: 6, address: groups.join(':') };
}

function blockList(v4: readonly string[], v6: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of v4) {
    const [net, prefix] = cidr.split('/');
    list.addSubnet(net as string, Number(prefix), 'ipv4');
  }
  for (const cidr of v6) {
    const [net, prefix] = cidr.split('/');
    list.addSubnet(net as string, Number(prefix), 'ipv6');
  }
  return list;
}

/** Addresses that always reach THIS host (before interface addresses). */
export const LOOPBACK_RANGES = {
  v4: ['127.0.0.0/8', '0.0.0.0/8'],
  v6: ['::1/128', '::/128'],
} as const;

/**
 * Non-public destinations a Project admin's browser may not reach unless the
 * operator registered the exact target (D7). Pinned by test.
 */
export const NON_PUBLIC_RANGES = {
  v4: [
    '0.0.0.0/8', // "this network"; 0.0.0.0 connects locally
    '10.0.0.0/8', // RFC1918
    '100.64.0.0/10', // CGNAT, which includes the tailnet
    '127.0.0.0/8', // loopback
    '169.254.0.0/16', // link-local, including 169.254.169.254 metadata
    '172.16.0.0/12', // RFC1918
    '192.0.0.0/24', // IETF protocol assignments
    '192.168.0.0/16', // RFC1918
    '198.18.0.0/15', // benchmarking
    '224.0.0.0/4', // multicast
    '240.0.0.0/4', // reserved, including broadcast
  ],
  v6: [
    '::/128', // unspecified
    '::1/128', // loopback
    'fc00::/7', // unique local
    'fe80::/10', // link-local
    'ff00::/8', // multicast
  ],
} as const;

const loopbackList = blockList(LOOPBACK_RANGES.v4, LOOPBACK_RANGES.v6);
const nonPublicList = blockList(NON_PUBLIC_RANGES.v4, NON_PUBLIC_RANGES.v6);

function inList(list: BlockList, ip: CanonicalIp): boolean {
  return list.check(ip.address, ip.family === 4 ? 'ipv4' : 'ipv6');
}

export function isLoopbackIp(ip: CanonicalIp): boolean {
  return inList(loopbackList, ip);
}

export function isNonPublicIp(ip: CanonicalIp): boolean {
  return inList(nonPublicList, ip);
}

/** Same address, whatever the spelling. */
export function sameIp(a: CanonicalIp, b: CanonicalIp): boolean {
  return a.family === b.family && a.address === b.address;
}
