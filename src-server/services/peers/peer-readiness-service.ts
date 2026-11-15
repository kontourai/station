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
export const PEER_READINESS_TIMEOUT_MS = 2_500;
/** How long an `online` answer is reused before the peer is probed again. */
export const PEER_READINESS_ONLINE_TTL_MS = 10_000;
/** A failure is reused only to absorb a burst of reads, never for long. */
export const PEER_READINESS_FAILURE_TTL_MS = 2_000;
export const PEER_READINESS_CONCURRENCY = 4;

export interface PeerReadinessTarget {
  environmentId: string;
  /** Bare origin the peer is reached at (`https://host:port`). */
  apiBase: string;
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
    const key = `${peer.environmentId}\n${peer.apiBase}`;
    const cached = this.#cache.get(key);
    if (cached) {
      const online = cached.status === 'online';
      const age = this.#now() - cached.checkedAt;
      if (
        age < (online ? this.#onlineTtlMs : this.#failureTtlMs) &&
        (online || !options.revalidateFailures)
      )
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
