import {
  CLIENT_PROTOCOL_HEADER,
  classifyStationHandshakeAnswer,
  type PeerStationReadiness,
  PUBLIC_STATION_HANDSHAKE_PATH,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';

/** The handshake is a few hundred bytes; anything far larger is not one. */
const MAX_HANDSHAKE_BYTES = 16_384;
const PEER_READINESS_TIMEOUT_MS = 2_500;
/** How long an `online` answer is reused before the peer is probed again. */
const PEER_READINESS_ONLINE_TTL_MS = 10_000;
/** A failure is reused only to absorb a burst of reads, never for long. */
const PEER_READINESS_FAILURE_TTL_MS = 2_000;
const PEER_READINESS_CONCURRENCY = 4;

export interface PeerReadinessTarget {
  environmentId: string;
  /** Bare origin the peer is reached at (`https://host:port`). */
  apiBase: string;
}

function keyOf(peer: PeerReadinessTarget): string {
  return `${peer.environmentId}\n${peer.apiBase}`;
}

export interface PeerReadinessServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  onlineTtlMs?: number;
  failureTtlMs?: number;
  concurrency?: number;
}

/**
 * Probes paired peer Stations' unauthenticated public handshake and reports
 * each as `online`, `recovering`, `unconfirmed` (including an identity
 * mismatch) or `unreachable`. No credential is sent: the handshake is public,
 * and a readiness read must never present a peer bearer.
 *
 * Answers are cached per (environmentId, apiBase) — `online` briefly, a
 * failure only long enough to absorb a burst — and concurrent probes of the
 * same peer share one request.
 *
 * Reads that list peers never wait on the network: `snapshot` answers from
 * the last observation and refreshes stale ones in the background, so the
 * store stays current on the cadence the peer list is read (pickers re-read
 * it while open). Only dispatch (`probe` with `revalidateFailures`) waits,
 * because refusing work must rest on a fresh observation.
 */
export class PeerReadinessService {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #onlineTtlMs: number;
  readonly #failureTtlMs: number;
  readonly #concurrency: number;
  readonly #cache = new Map<string, PeerStationReadiness>();
  readonly #inFlight = new Map<string, Promise<PeerStationReadiness>>();

  constructor(options: PeerReadinessServiceOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? PEER_READINESS_TIMEOUT_MS;
    this.#onlineTtlMs = options.onlineTtlMs ?? PEER_READINESS_ONLINE_TTL_MS;
    this.#failureTtlMs = options.failureTtlMs ?? PEER_READINESS_FAILURE_TTL_MS;
    this.#concurrency = Math.max(
      1,
      options.concurrency ?? PEER_READINESS_CONCURRENCY,
    );
  }

  /**
   * One peer's readiness. `revalidateFailures` (the dispatch path) accepts a
   * cached `online` answer but always re-probes a cached failure, so work is
   * refused only on a fresh observation.
   */
  probe(
    peer: PeerReadinessTarget,
    options: { revalidateFailures?: boolean } = {},
  ): Promise<PeerStationReadiness> {
    const key = keyOf(peer);
    const cached = this.#cache.get(key);
    if (cached) {
      const online = cached.status === 'online';
      const age = this.#now() - cached.checkedAt;
      if (age < this.#ttl(cached) && (online || !options.revalidateFailures))
        return Promise.resolve(cached);
    }
    const pending = this.#inFlight.get(key);
    if (pending) return pending;
    const probe = this.#probeOnce(peer)
      .then((readiness) => {
        this.#cache.set(key, readiness);
        return readiness;
      })
      .finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, probe);
    return probe;
  }

  /**
   * Each peer's last observed readiness, at once: `undefined` for a peer not
   * yet probed. Peers whose answer is past its TTL (or never probed) are
   * refreshed in the background, at most `concurrency` at a time, so the next
   * read sees the result. Entries for peers no longer listed are dropped.
   */
  snapshot(
    peers: readonly PeerReadinessTarget[],
  ): Array<PeerStationReadiness | undefined> {
    const keys = new Set(peers.map(keyOf));
    for (const key of this.#cache.keys())
      if (!keys.has(key)) this.#cache.delete(key);
    const now = this.#now();
    const stale: PeerReadinessTarget[] = [];
    const observed = peers.map((peer) => {
      const cached = this.#cache.get(keyOf(peer));
      if (!cached || now - cached.checkedAt >= this.#ttl(cached))
        stale.push(peer);
      return cached;
    });
    if (stale.length) void this.probeAll(stale);
    return observed;
  }

  #ttl(readiness: PeerStationReadiness): number {
    return readiness.status === 'online'
      ? this.#onlineTtlMs
      : this.#failureTtlMs;
  }

  /** Every peer's readiness, at most `concurrency` probes at a time. */
  async probeAll(
    peers: readonly PeerReadinessTarget[],
  ): Promise<PeerStationReadiness[]> {
    const results: PeerStationReadiness[] = new Array(peers.length);
    let next = 0;
    const worker = async () => {
      while (next < peers.length) {
        const index = next++;
        results[index] = await this.probe(peers[index]!);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#concurrency, peers.length) }, worker),
    );
    return results;
  }

  async #probeOnce(peer: PeerReadinessTarget): Promise<PeerStationReadiness> {
    const checkedAt = this.#now();
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(
        `${peer.apiBase}${PUBLIC_STATION_HANDSHAKE_PATH}`,
        {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: {
            Accept: 'application/json',
            [CLIENT_PROTOCOL_HEADER]: String(STATION_COMPAT_PROTOCOL_VERSION),
          },
        },
      );
    } catch {
      return { status: 'unreachable', checkedAt };
    }
    let body: unknown;
    if (response.body) {
      const read = await readBoundedRequestBody(response, MAX_HANDSHAKE_BYTES);
      // A body that could not be read to the end is no answer at all; one
      // that is too large answered, but not as a Station.
      if (read.status === 'invalid')
        return { status: 'unreachable', checkedAt };
      if (read.status === 'too-large')
        await response.body.cancel().catch(() => {});
      if (read.status === 'ok') {
        try {
          body = JSON.parse(read.body);
        } catch {
          body = undefined;
        }
      }
    }
    return {
      ...classifyStationHandshakeAnswer({
        httpStatus: response.status,
        body,
        expectedEnvironmentId: peer.environmentId,
      }),
      checkedAt,
    };
  }
}
