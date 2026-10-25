// UNWIRED(#4115): R3 ingress policy is composed only in isolated builds until R6.

import { isIP } from 'node:net';
import type { HttpBindings } from '@hono/node-server';
import type { Context } from 'hono';

export interface OutsideOAuthExposure {
  issuer: string;
  allowLoopbackHttp?: boolean;
  hosted: boolean;
  /** Only an isolated, authenticated ingress which strips/replaces caller headers may return this proof. */
  trustedTlsIngress?: (c: Context) => { peerKey?: string } | undefined;
}
export function validateOutsideExposure(input: OutsideOAuthExposure): URL {
  const issuer = new URL(input.issuer);
  if (
    input.hosted ||
    issuer.origin !== input.issuer ||
    issuer.username ||
    issuer.password ||
    (issuer.protocol !== 'https:' &&
      !(
        issuer.protocol === 'http:' &&
        input.allowLoopbackHttp &&
        ['127.0.0.1', '[::1]'].includes(issuer.hostname)
      ))
  )
    throw new Error(
      'Outside OAuth requires a canonical HTTPS issuer, or explicit literal-loopback HTTP; hosted mode is disabled',
    );
  return issuer;
}
function socketPeer(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const normalized = mapped?.[1] ?? value;
  if (!isIP(normalized)) return undefined;
  // URL serialization canonicalizes IPv6, including hexadecimal IPv4-mapped addresses.
  if (isIP(normalized) === 6) {
    const ipv6 = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
    const hexMapped = ipv6.match(/^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/i);
    if (hexMapped) {
      const high = Number.parseInt(hexMapped[1]!, 16),
        low = Number.parseInt(hexMapped[2]!, 16);
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return ipv6;
  }
  return normalized;
}
/** Uses the transport's raw header list: Fetch Headers may hide duplicate Host fields. */
export function outsideIngress(
  c: Context,
  config: OutsideOAuthExposure,
): { peerKey?: string } | undefined {
  const incoming = (c.env as Partial<HttpBindings> | undefined)?.incoming;
  if (!incoming?.rawHeaders) return undefined;
  if (
    new URL(c.req.url).pathname !== c.req.path ||
    (incoming.url && incoming.url.split('?')[0] !== c.req.path)
  )
    return undefined;
  const names: string[] = [],
    hosts: string[] = [],
    authorities: string[] = [];
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    const name = incoming.rawHeaders[i]!.toLowerCase();
    names.push(name);
    if (name === 'host') hosts.push(incoming.rawHeaders[i + 1]!);
    if (name === ':authority') authorities.push(incoming.rawHeaders[i + 1]!);
  }
  const issuer = new URL(config.issuer);
  if (
    hosts.length !== 1 ||
    hosts[0] !== issuer.host ||
    authorities.length > 1 ||
    (authorities.length === 1 && authorities[0] !== hosts[0])
  )
    return undefined;
  const peer = socketPeer(incoming.socket.remoteAddress);
  if (!peer) return undefined;
  if (issuer.protocol === 'http:') {
    if (
      !config.allowLoopbackHttp ||
      !['127.0.0.1', '::1'].includes(peer) ||
      names.some(
        (name) =>
          name.startsWith('x-station-proxy-') ||
          name === 'x-station-internal-token' ||
          name === 'x-station-ingress-identity' ||
          name === 'x-station-internal-tenant' ||
          name === 'forwarded' ||
          name.startsWith('x-forwarded-') ||
          name === 'x-real-ip' ||
          name.startsWith('tailscale-'),
      )
    )
      return undefined;
    return { peerKey: `direct:${peer}` };
  }
  const trusted = config.trustedTlsIngress?.(c);
  if (trusted) return trusted;
  if (
    !('encrypted' in incoming.socket) ||
    incoming.socket.encrypted !== true ||
    names.some(
      (name) =>
        name === 'forwarded' ||
        name.startsWith('x-forwarded-') ||
        name === 'x-real-ip' ||
        name.startsWith('tailscale-') ||
        name.startsWith('x-station-proxy-') ||
        name === 'x-station-internal-token' ||
        name === 'x-station-ingress-identity' ||
        name === 'x-station-internal-tenant',
    )
  )
    return undefined;
  return { peerKey: `direct:${peer}` };
}
