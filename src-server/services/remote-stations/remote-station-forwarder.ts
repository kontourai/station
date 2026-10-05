/**
 * #2377 slice C2b: the one seam through which DELEGATION DISPATCH reaches
 * another Station (a saved SSH Environment or a directly reachable peer):
 * every dispatch-family request (delegate, message, continue, respond,
 * interrupt, list, observe, options) to another Station starts from a target
 * minted here and is bounded by it. It is not the only reader of the outbound
 * peer-credential store: session analytics, remote message search,
 * home-authority room binding and the fleet probe read it in-process too,
 * each for its own server-side peer call.
 *
 * It is built only by runtime composition (`runtime-routes.ts`, and the
 * runtime's own server-driven turns) from the in-process SSH service and
 * the outbound peer-credential store, and handed to the dispatch code
 * (`station-control-delegation.ts`) next to the orchestration service. A
 * station-control tool never receives one: it sends its target to this
 * Station's own route, which applies the caller's scope (slice C2a) and then
 * resolves the remote hop here. So no tool process holds a peer bearer, and
 * no HTTP route hands one out.
 *
 * The interface is deliberately one call. `resolve` answers the reachable
 * address of a saved Environment and the headers this Station presents
 * there, and the bound on each request (`requestOptions.timeoutMs`); every
 * remote request the dispatch code makes starts from a target this seam
 * minted (`isRemoteStationTarget`). Later remote work (#2875,
 * provider-neutral workspace preparation) resolves through the same call.
 */
import type { PeerCredentialStore } from '../peers/peer-credential-store.js';
import type {
  SshEnvironmentService,
  SshEnvironmentView,
} from '../ssh/ssh-environment-service.js';

/** A reachable other Station, as this Station addresses it. */
export interface RemoteStationTarget {
  /** `ssh`: over a verified SSH tunnel. `peer`: directly, with a bearer. */
  readonly kind: 'ssh' | 'peer';
  /** A loopback tunnel origin (`ssh`) or the peer's pinned origin. */
  readonly apiBase: string;
  readonly environmentId: string;
  readonly environmentName: string;
  /** `ssh` only: the project path the SSH profile verified. */
  readonly projectPath?: string;
  /** `ssh` only: the remote home the SSH profile verified. */
  readonly remoteHome?: string;
  /**
   * How every request to this target is made. `headers`: the outbound peer
   * bearer when one is provisioned for the Environment (always, for `peer`;
   * empty for an SSH tunnel without one). `timeoutMs`: the route-owned
   * bound on each request, fixed when the forwarder was built. The SDK
   * fetchers read it as their per-call deadline and this module's
   * `fetchRemoteStation` as its own, so no request to another Station goes
   * out unbounded.
   */
  readonly requestOptions: {
    readonly headers: Record<string, string>;
    readonly timeoutMs: number;
  };
}

export interface RemoteStationForwarder {
  /**
   * Resolve a saved Environment to a reachable target. An SSH profile wins
   * over a peer credential for the same Environment; a peer credential is
   * used only when no SSH profile names it at all. Throws a caller-safe
   * error when neither can be reached; never returns a target for this
   * Station itself (the caller answers that one).
   */
  resolve(
    environmentId: string,
    requestedProjectPath?: string,
  ): Promise<RemoteStationTarget>;
}

/**
 * The bound on ONE request this Station makes to another Station on a
 * caller's behalf. The route owns it: a station-control tool's own call to
 * this Station carries no timeout, so a slow peer is reported by the route
 * (as the dispatch error, `isError` at the tool) and the tool never aborts
 * first. It sits under the shortest MCP client tool-call limit we know of
 * (60 s), so the route's answer arrives before a client gives up.
 * `STATION_REMOTE_REQUEST_TIMEOUT_MS` overrides it (1..600000; anything else
 * is refused, not clamped).
 */
export const REMOTE_STATION_REQUEST_TIMEOUT_MS = 30_000;
const REMOTE_STATION_REQUEST_TIMEOUT_ENV = 'STATION_REMOTE_REQUEST_TIMEOUT_MS';
const MAX_REMOTE_STATION_REQUEST_TIMEOUT_MS = 600_000;

export function remoteStationRequestTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[REMOTE_STATION_REQUEST_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return REMOTE_STATION_REQUEST_TIMEOUT_MS;
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_REMOTE_STATION_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `${REMOTE_STATION_REQUEST_TIMEOUT_ENV} must be an integer from 1 to ${MAX_REMOTE_STATION_REQUEST_TIMEOUT_MS}`,
    );
  }
  return value;
}

/** Another Station did not answer one request within the route's bound. */
export class RemoteStationTimeoutError extends Error {
  /**
   * @param mutation whether the request could have changed state there (a
   * write whose answer never finished arriving): then the outcome is unknown,
   * not failed, and the message says the change may still have been applied.
   */
  constructor(
    readonly timeoutMs: number,
    readonly mutation = false,
  ) {
    const seconds = Math.ceil(timeoutMs / 1000);
    super(
      `The selected Station did not answer within ${seconds} second${seconds === 1 ? '' : 's'}${
        mutation ? '; the change may still have been applied' : ''
      }`,
    );
    this.name = 'RemoteStationTimeoutError';
  }
}

/**
 * In-process only: names a `Response` that came from another Station through
 * {@link fetchRemoteStation}. It never reaches a client; the runtime's
 * envelope marker middleware (`installStationEnvelopeMarker`) removes it.
 */
export const RELAYED_RESPONSE_HEADER = 'x-station-relayed-response';

/**
 * `fetch` for a request to another Station, bounded by the target's
 * `timeoutMs`, headers and body alike. A timeout is reported as
 * `RemoteStationTimeoutError`; any other failure is rethrown.
 */
export async function fetchRemoteStation(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const method = (init.method ?? 'GET').toUpperCase();
  const mutation = method !== 'GET' && method !== 'HEAD';
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    if (timeout.aborted)
      throw new RemoteStationTimeoutError(timeoutMs, mutation);
    throw error;
  }
  // Read the body under the same bound, so a peer that sends headers and
  // then stalls is reported the same way.
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (timeout.aborted)
      throw new RemoteStationTimeoutError(timeoutMs, mutation);
    throw error;
  }
  const nullBody = [101, 204, 205, 304].includes(response.status);
  // #2842: whatever the other Station sent, this response is a relay. The
  // runtime's envelope marker middleware reads this header and never puts
  // this Station's marker on it (and removes the peer's), so a route that
  // returned this response as it is could not present a peer's answer as
  // this Station's own. Set last, so a peer cannot unset it.
  const headers = new Headers(response.headers);
  headers.set(RELAYED_RESPONSE_HEADER, '1');
  return new Response(nullBody ? null : text, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const minted = new WeakSet<object>();

/** True only for a target this seam produced. */
export function isRemoteStationTarget(
  value: unknown,
): value is RemoteStationTarget {
  return typeof value === 'object' && value !== null && minted.has(value);
}

function mint(target: RemoteStationTarget): RemoteStationTarget {
  const frozen = Object.freeze({ ...target });
  minted.add(frozen);
  return frozen;
}

/** No SSH profile names the Environment at all (the only peer fallback). */
const SSH_ENVIRONMENT_NOT_FOUND_MESSAGE =
  'The selected environment is not a saved, verified SSH environment';

function requireLoopbackTunnel(value: string | undefined): string {
  if (!value) {
    throw new Error('SSH environment did not provide a verified tunnel');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('SSH environment returned an invalid tunnel');
  }
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('SSH environment returned a non-loopback tunnel');
  }
  return parsed.origin;
}

export interface RemoteStationForwarderDependencies {
  readonly ssh: Pick<SshEnvironmentService, 'list' | 'connect'>;
  readonly peers: Pick<PeerCredentialStore, 'get'>;
  /** Where a failed credential read is reported (it never fails the hop). */
  readonly warn?: (message: string) => void;
  /** Where `STATION_REMOTE_REQUEST_TIMEOUT_MS` is read (default: the process). */
  readonly env?: NodeJS.ProcessEnv;
}

export function createRemoteStationForwarder(
  deps: RemoteStationForwarderDependencies,
): RemoteStationForwarder {
  // Read once, here: an invalid override fails the composition that builds
  // the forwarder (startup), with its own message, instead of surfacing
  // later as a generic dispatch failure.
  const timeoutMs = remoteStationRequestTimeoutMs(deps.env);
  const peerHeaders = (
    environmentId: string,
  ): { headers: Record<string, string> } | undefined => {
    const peer = deps.peers.get(environmentId);
    return peer
      ? { headers: { Authorization: `Bearer ${peer.credential}` } }
      : undefined;
  };

  const connectSsh = async (
    environmentId: string,
    requestedProjectPath: string | undefined,
  ): Promise<RemoteStationTarget> => {
    const saved = deps.ssh
      .list()
      .find(
        (environment) => environment.profile.environmentId === environmentId,
      );
    if (!saved) throw new Error(SSH_ENVIRONMENT_NOT_FOUND_MESSAGE);
    if (!saved.profile.verifiedProjectPath) {
      // Deliberately not the not-found message: a present but unverified
      // profile reports its own failure and never falls through to a peer.
      throw new Error(
        'The selected SSH environment is not yet verified; verify it before delegating work',
      );
    }
    if (
      requestedProjectPath &&
      requestedProjectPath !== saved.profile.verifiedProjectPath
    ) {
      throw new Error(
        'The requested project path does not match the verified SSH environment binding',
      );
    }
    let view: SshEnvironmentView;
    try {
      view = await deps.ssh.connect(saved.profile.id);
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message
          ? error.message
          : 'The selected SSH environment could not be connected',
      );
    }
    if (
      view.profile.environmentId !== environmentId ||
      view.profile.verifiedProjectPath !== saved.profile.verifiedProjectPath
    ) {
      throw new Error(
        'The SSH environment binding changed while connecting; select it again',
      );
    }
    if (view.state.phase !== 'connected') {
      throw new Error(
        ('action' in view.state && view.state.action) ||
          `The selected SSH environment is not ready (${view.state.phase})`,
      );
    }
    // The outbound peer credential, when one is provisioned for this
    // Environment, rides the tunnel too, so the remote runtime enforces its
    // scope. A failed read keeps the tunnel usable (its protected calls then
    // fail with the remote's 401) and is reported, never silent.
    let requestOptions: { headers: Record<string, string> } | undefined;
    try {
      requestOptions = peerHeaders(environmentId);
    } catch (error) {
      deps.warn?.(
        `[remote-station-forwarder] peer credential lookup failed for environmentId=${environmentId}; ` +
          `the SSH-tunneled target carries no credential: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
    const localUrl =
      'localUrl' in view.state ? (view.state.localUrl as string) : undefined;
    return mint({
      kind: 'ssh',
      apiBase: requireLoopbackTunnel(localUrl),
      environmentId,
      environmentName: view.profile.name,
      projectPath: view.profile.verifiedProjectPath ?? undefined,
      ...(view.profile.remoteHome
        ? { remoteHome: view.profile.remoteHome }
        : {}),
      requestOptions: { headers: requestOptions?.headers ?? {}, timeoutMs },
    });
  };

  return {
    async resolve(environmentId, requestedProjectPath) {
      try {
        return await connectSsh(environmentId, requestedProjectPath);
      } catch (error) {
        // A peer is reached only when no SSH profile names the Environment
        // at all; every other SSH failure is reported as it is.
        if (
          !(error instanceof Error) ||
          error.message !== SSH_ENVIRONMENT_NOT_FOUND_MESSAGE
        )
          throw error;
        let peer: ReturnType<
          RemoteStationForwarderDependencies['peers']['get']
        >;
        try {
          peer = deps.peers.get(environmentId);
        } catch {
          throw new Error('The selected peer environment is unavailable');
        }
        if (!peer) throw error;
        return mint({
          kind: 'peer',
          apiBase: peer.apiBase,
          environmentId,
          environmentName: peer.label || peer.apiBase,
          requestOptions: {
            headers: { Authorization: `Bearer ${peer.credential}` },
            timeoutMs,
          },
        });
      }
    },
  };
}
