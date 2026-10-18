import { BlockList, isIP } from 'node:net';

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
      const parts = entry.trim().split('/');
      const family = isIP(parts[0]);
      const prefix = Number(parts[1]);
      if (
        parts.length !== 2 ||
        !family ||
        parts[0].includes('%') ||
        !/^(0|[1-9]\d*)$/.test(parts[1]) ||
        prefix > (family === 4 ? 32 : 128)
      )
        throw new Error('Invalid telemetry trusted proxy CIDR configuration');
      trusted.addSubnet(parts[0], prefix, family === 4 ? 'ipv4' : 'ipv6');
    }
  }
  let invalidClientIpHeaders = 0;
  return {
    resolve(peer: string, value: string | undefined): string {
      const family = isIP(peer);
      if (
        !family ||
        !trusted.check(peer, family === 4 ? 'ipv4' : 'ipv6') ||
        value === undefined
      )
        return peer;
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
