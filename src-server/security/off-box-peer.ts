/**
 * station#1490: "is this peer PROVABLY not this machine?"
 *
 * Deliberately not {@link classifyRuntimePeer}. That function answers a
 * different question — "is this definitely LOCAL?" — for the authentication
 * boundary, where `remote` is the SAFE verdict (a remote caller must present a
 * credential). Pairing approval inverts the stakes: there, `remote` is the
 * PERMISSIVE verdict, so reusing it would make its `else` branch a grant and
 * would silently turn every future unrecognised address family into approval
 * authority. It already did: `fe80::1%lo0` — the loopback interface's own
 * link-local address, reachable under `STATION_HOST=::` without a packet
 * leaving the machine — classifies `remote`.
 *
 * So this is an ALLOW-list stated positively. It grants only for an address
 * that parses, is not loopback, is not link-local, is not unspecified, and is
 * not one this host is currently holding on any interface. Anything else —
 * including anything it cannot parse — is refused.
 *
 * What it establishes, precisely: the packet came from some other network
 * stack. That is weaker than "another machine" and the difference is the
 * disclosed residue (`docs/security/remote-access-threat-model.md`): a
 * container, VM, or other netns on this same box has its own address and is
 * off-box by this definition, as is any second machine the adversary holds,
 * as is a NAT hairpin whose source is rewritten to something this host does
 * not hold.
 */
import { networkInterfaces } from 'node:os';
import { normalizeSocketAddress } from './runtime-request-security.js';

export interface OffBoxPeerOptions {
  /**
   * Interface enumerator, injectable for tests. Called ON EVERY EVALUATION on
   * purpose: a cached list fails OPEN. An interface that appears after boot —
   * a VPN coming up, a container bridge, a Wi-Fi network joined later — would
   * otherwise stay absent from the list, and every address on it would read as
   * "not one of ours" and grant. Pairing requests are rate-limited and rare;
   * this syscall is not on any hot path.
   */
  readonly networkInterfaces?: () => NodeJS.Dict<
    Array<{ readonly address: string }> | undefined
  >;
}

/**
 * Strict dotted-quad, with no leading zeros in any octet.
 *
 * The leading-zero rule is not pedantry: `010.0.0.1` and `10.0.0.1` are the
 * same host to some resolvers and different strings to a set lookup, and
 * `010` reads as octal `8` to others. An address whose meaning depends on who
 * is parsing it cannot be compared against this host's interface list, so it
 * is refused as unrecognised rather than resolved to a guess. Node's socket
 * layer never produces one; only the attested-peer header can.
 */
function isValidIpv4(address: string): boolean {
  const octets = address.split('.');
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255,
    )
  );
}

/**
 * IPv4 embedded in an IPv6 literal, as dotted quad, or `undefined`.
 *
 * `URL` canonicalises `0:0:0:0:0:ffff:127.0.0.1` to the mapped-HEX form
 * `::ffff:7f00:1`, which is the same address as `127.0.0.1` and matches none
 * of the class predicates below — the defect this exists to remove
 * (station#1490 delta review H1). Both the `::ffff:` mapped form and the
 * deprecated `::`-prefixed v4-compatible form are unwrapped, because refusing
 * an address the host actually holds is the safe direction and no real peer
 * arrives wearing either spelling.
 */
function embeddedIpv4(peer: string): string | undefined {
  const match = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(peer);
  if (!match) return undefined;
  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * One comparable spelling for an address, or `undefined` when it is not an
 * address this function is willing to reason about.
 *
 * String equality alone is not enough: `fe80:0:0:0:0:0:0:1` and `fe80::1` are
 * the same address written two ways, and an interface list that spells it the
 * second way must still match a peer that arrives as the first. `URL` is the
 * canonicaliser already in the runtime — it applies RFC 5952 compression — and
 * its rejection of a malformed address is exactly the "unrecognised" case this
 * module refuses.
 */
function canonicalAddress(value: string | undefined): string | undefined {
  const normalized = normalizeSocketAddress(value);
  if (!normalized) return undefined;
  if (isValidIpv4(normalized)) return normalized;
  if (normalized.includes('.')) return undefined;
  if (!normalized.includes(':')) return undefined;
  let canonical: string;
  try {
    const { hostname } = new URL(`http://[${normalized}]`);
    canonical = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  } catch {
    return undefined;
  }
  // AFTER the URL pass, not before: `normalizeSocketAddress` unwraps only the
  // dotted-quad spelling of a mapped address, and `URL` then re-emits the
  // remaining ones as mapped hex. Unwrapping here is what makes one address
  // have one spelling no matter which of the four ways it arrived.
  const embedded = embeddedIpv4(canonical);
  if (embedded) return isValidIpv4(embedded) ? embedded : undefined;
  return canonical;
}

function isLoopback(peer: string): boolean {
  return peer === '::1' || (peer.startsWith('127.') && isValidIpv4(peer));
}

function isLinkLocal(peer: string): boolean {
  // IPv4 169.254.0.0/16 and IPv6 fe80::/10 (fe80 through febf). Both are
  // scoped to a single link and are reachable on this host's own interfaces —
  // including `lo0`, which is how the proven `fe80::1%lo0` self-dial arises.
  return /^169\.254\./.test(peer) || /^fe[89ab][0-9a-f]:/.test(peer);
}

function isUnspecified(peer: string): boolean {
  return peer === '0.0.0.0' || peer === '::';
}

/** Every address this host currently holds, in canonical form. */
function hostAddresses(options: OffBoxPeerOptions): ReadonlySet<string> {
  const enumerate = options.networkInterfaces ?? networkInterfaces;
  const addresses = new Set<string>();
  for (const entries of Object.values(enumerate())) {
    for (const entry of entries ?? []) {
      const canonical = canonicalAddress(entry.address);
      if (canonical) addresses.add(canonical);
    }
  }
  return addresses;
}

/**
 * Whether `address` provably belongs to a network stack that is not this
 * host's. Fail-closed: `false` for loopback, link-local, unspecified, any
 * address this host currently holds, an unreadable peer, and anything
 * unparseable.
 */
export function isDefinitelyOffBox(
  address: string | undefined,
  options: OffBoxPeerOptions = {},
): boolean {
  const peer = canonicalAddress(address);
  if (!peer) return false;
  if (isLoopback(peer) || isLinkLocal(peer) || isUnspecified(peer)) {
    return false;
  }
  return !hostAddresses(options).has(peer);
}
