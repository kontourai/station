/**
 * #3483: the address rules for remote MCP servers a catalog supplied, and a
 * fetch that connects only to addresses it has checked.
 *
 * A catalog names an endpoint Station connects to on the person's behalf. A
 * hostname check alone can be undone by DNS: the name can resolve to a
 * public address when checked and to this host or its network when the
 * socket opens. `createAddressPinnedFetch` resolves each hostname once,
 * checks every address it gets, and then connects only to those addresses.
 * The URL, TLS server name and `Host` header keep the hostname.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

/**
 * Loopback, private, link-local, shared, reserved and multicast ranges. A
 * catalog cannot point Station at this host or its network unless the
 * operator opts in.
 */
const PRIVATE_RANGES = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const)
    list.addSubnet(network, prefix, 'ipv4');
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const)
    list.addSubnet(network, prefix, 'ipv6');
  return list;
})();

/** Whether an IP address is local or on a private network. */
export function isPrivateNetworkAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
  if (mapped) return PRIVATE_RANGES.check(mapped, 'ipv4');
  const family = isIP(host);
  if (family === 4) return PRIVATE_RANGES.check(host, 'ipv4');
  if (family === 6) {
    // `::ffff:7f00:1` is the hex spelling of an IPv4-mapped address.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (hex) {
      const high = Number.parseInt(hex[1], 16);
      const low = Number.parseInt(hex[2], 16);
      return PRIVATE_RANGES.check(
        `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
        'ipv4',
      );
    }
    return PRIVATE_RANGES.check(host, 'ipv6');
  }
  // Not an address: nothing to check here.
  return false;
}

/** Whether a URL's host is a local name or a private network address. */
export function isPrivateNetworkHost(url: string): boolean {
  // `localhost.` and `printer.local.` name the same hosts as without the
  // root dot, so repeated and terminal dots are dropped before any rule.
  const host = new URL(url).hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  )
    return true;
  return isPrivateNetworkAddress(host);
}

/** A remote endpoint resolved to an address Station may not connect to. */
export class RemoteAddressRefusedError extends Error {
  readonly code = 'remote_address_refused';
  constructor(hostname: string) {
    super(
      `Refused to connect to '${hostname}': it resolves to a local or private network address.`,
    );
    this.name = 'RemoteAddressRefusedError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type AddressResolver = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;

const systemResolver: AddressResolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

export interface AddressPinnedFetchOptions {
  /** The operator allows local and private network addresses. */
  allowPrivateAddresses: boolean;
  /** Resolves a hostname; the system resolver by default. */
  resolve?: AddressResolver;
  /** Which addresses are refused; the private ranges above by default. */
  isRefusedAddress?: (address: string) => boolean;
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * A `fetch` that resolves each hostname once for its lifetime, refuses the
 * whole name when any answer is refused, and opens sockets only to the
 * answers it checked. A later, different DNS answer is never used.
 * Redirects are not followed: `redirect: 'manual'` returns the response,
 * anything else rejects, so a redirect target is checked as a new request.
 */
export function createAddressPinnedFetch(
  options: AddressPinnedFetchOptions,
): typeof globalThis.fetch {
  const resolve = options.resolve ?? systemResolver;
  const refused = options.isRefusedAddress ?? isPrivateNetworkAddress;
  const checked = new Map<string, Promise<readonly ResolvedAddress[]>>();
  const addressesFor = (hostname: string) => {
    let pending = checked.get(hostname);
    if (pending) return pending;
    pending = (async () => {
      const literal = hostname.replace(/^\[|\]$/g, '');
      const family = isIP(literal);
      const answers = family
        ? [{ address: literal, family }]
        : [...(await resolve(hostname))];
      if (answers.length === 0) throw new RemoteAddressRefusedError(hostname);
      if (
        !options.allowPrivateAddresses &&
        answers.some((answer) => refused(answer.address))
      )
        throw new RemoteAddressRefusedError(hostname);
      return answers.map(({ address, family }) => ({ address, family }));
    })();
    checked.set(hostname, pending);
    // A failed lookup may be retried; a refusal is kept.
    pending.catch((error: unknown) => {
      if (!(error instanceof RemoteAddressRefusedError))
        checked.delete(hostname);
    });
    return pending;
  };

  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new TypeError(`Unsupported protocol ${url.protocol}`);
    if (url.username || url.password)
      throw new TypeError('Credentials in URLs are not sent');
    const addresses = await addressesFor(url.hostname);
    const body =
      request.body === null
        ? undefined
        : Buffer.from(await request.arrayBuffer());
    request.signal.throwIfAborted();
    const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) {
        (callback as (error: null, addresses: ResolvedAddress[]) => void)(
          null,
          addresses.map((entry) => ({ ...entry })),
        );
        return;
      }
      const wanted = lookupOptions.family;
      const first =
        addresses.find((entry) => !wanted || entry.family === wanted) ??
        addresses[0];
      callback(null, first.address, first.family);
    };
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<Response>((settle, reject) => {
      const outgoing = send(
        url,
        {
          method: request.method,
          headers,
          lookup: pinned,
          // No pooled socket from another name or an earlier answer.
          agent: false,
          signal: request.signal,
        },
        (incoming) => {
          const status = incoming.statusCode ?? 502;
          if (status >= 300 && status < 400 && request.redirect !== 'manual') {
            incoming.resume();
            reject(new TypeError('Redirects are not followed'));
            return;
          }
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value))
              for (const item of value) responseHeaders.append(name, item);
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          const empty =
            NULL_BODY_STATUSES.has(status) || request.method === 'HEAD';
          if (empty) incoming.resume();
          settle(
            new Response(
              empty
                ? null
                : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
              {
                status,
                statusText: incoming.statusMessage,
                headers: responseHeaders,
              },
            ),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  };
}
