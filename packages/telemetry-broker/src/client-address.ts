import { BlockList, isIP } from 'node:net';

function addressBits(address: string, family: number): bigint {
  if (family === 4)
    return address.split('.').reduce((n, byte) => (n << 8n) | BigInt(byte), 0n);
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const start = left ? left.split(':') : [];
  const end = right ? right.split(':') : [];
  const words =
    right === undefined
      ? start
      : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end];
  return words.reduce((n, word) => (n << 16n) | BigInt(`0x${word}`), 0n);
}

/** Trust the connector's socket address, never an address claimed by a header. */
export function clientAddressPolicy(
  trustedProxy: string | undefined = undefined,
  header = 'cf-connecting-ip',
) {
  if (header !== 'cf-connecting-ip')
    throw new Error('Invalid telemetry client IP header configuration');
  const trusted = new BlockList();
  if (trustedProxy !== undefined) {
    const entries = trustedProxy.split(',');
    if (entries.length > 128 || trustedProxy.length > 8192)
      throw new Error('Invalid telemetry trusted proxy CIDR configuration');
    for (const entry of entries) {
      const parts = entry.split('/');
      const family = isIP(parts[0]);
      const prefix = Number(parts[1]);
      if (
        parts.length !== 2 ||
        entry !== entry.trim() ||
        !family ||
        parts[0].includes('%') ||
        !/^(0|[1-9]\d*)$/.test(parts[1]) ||
        prefix < (family === 4 ? 24 : 64) ||
        prefix > (family === 4 ? 32 : 128) ||
        (addressBits(parts[0], family) &
          ((1n << BigInt((family === 4 ? 32 : 128) - prefix)) - 1n)) !==
          0n
      )
        throw new Error(
          'Invalid telemetry trusted proxy CIDR: use canonical networks without whitespace, IPv4 /24–/32 or IPv6 /64–/128',
        );
      trusted.addSubnet(parts[0], prefix, family === 4 ? 'ipv4' : 'ipv6');
    }
  }
  const isTrustedPeer = (peer: string): boolean => {
    const family = isIP(peer);
    return !!family && trusted.check(peer, family === 4 ? 'ipv4' : 'ipv6');
  };
  let invalidClientIpHeaders = 0;
  return {
    isTrustedPeer,
    resolve(peer: string, value: string | undefined): string {
      if (!isTrustedPeer(peer) || value === undefined) return peer;
      if (isIP(value) && !value.includes('%')) return value;
      invalidClientIpHeaders = Math.min(
        Number.MAX_SAFE_INTEGER,
        invalidClientIpHeaders + 1,
      );
      return peer;
    },
    diagnostics: () => ({ invalidClientIpHeaders }),
  };
}
