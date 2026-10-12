import { APPLICATION_SESSION_BASE_PATH } from '@kontourai/station-contracts/application-session';
import { DEPLOYMENT_AUTHENTICATION_BASE_PATH } from '@kontourai/station-contracts/deployment-authentication';
import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import {
  RELAY_ENROLLMENT_ACTIVATE_PATH,
  RELAY_ENROLLMENT_BEGIN_PATH,
  RELAY_ENROLLMENT_FINALIZE_PATH,
  RELAY_ENROLLMENT_LOGIN_PATH,
} from '@kontourai/station-contracts/relay-enrollment';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';

/** Trusted process composition only. This is not an authentication provider. */
export interface VirtualApplication {
  readonly signal: AbortSignal;
  fetch(request: Request): Promise<Response>;
}

type Application = { fetch(request: Request): Response | Promise<Response> };

/** Verified by the admitted Pion peer, then copied only onto VAI's fresh Request. */
export interface VerifiedPionApplicationRequestFacts {
  readonly stationId: string;
  readonly connectionEnrollmentId: string;
  readonly routingGeneration: number;
  readonly connectionId: string;
  readonly stationOrigin: string;
  readonly browserOrigin: string;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}
export type ReadPionApplicationRequestFacts = (
  request: Request,
) => VerifiedPionApplicationRequestFacts | undefined;

/** Native authority is supplied by the admitted Pion peer, never an HTTP Origin. */
export interface VerifiedNativePionApplicationRequestFacts {
  /** Exact broker offer nonce, captured before any await; never client-reported. */
  readonly peerNonce: string;
  readonly stationId: string;
  readonly connectionEnrollmentId: string;
  readonly routingGeneration: number;
  readonly connectionId: string;
  readonly stationOrigin: string;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}
export type ReadNativePionApplicationRequestFacts = (
  request: Request,
) => VerifiedNativePionApplicationRequestFacts | undefined;
export interface VerifiedNativeVirtualApplicationRequestFacts
  extends VerifiedNativePionApplicationRequestFacts {
  readonly requestOrigin: string;
}
const verifiedNativeVirtualRequests = new WeakMap<
  Request,
  VerifiedNativeVirtualApplicationRequestFacts
>();

export function readVerifiedNativeVirtualApplicationRequest(
  request: Request,
): VerifiedNativeVirtualApplicationRequestFacts | undefined {
  const facts = verifiedNativeVirtualRequests.get(request);
  if (
    !facts ||
    request.signal.aborted ||
    facts.signal.aborted ||
    !facts.isCurrent() ||
    request.headers.has('origin') ||
    new URL(request.url).origin !== facts.requestOrigin
  )
    return undefined;
  return facts;
}

/**
 * Carry one already admitted native peer across the runtime's bounded-body
 * Request replacement. This is only called by that trusted middleware after
 * it copies the exact request body; a changed target or header never inherits
 * the private provenance marker.
 */
export function transferVerifiedNativeVirtualApplicationRequest(
  source: Request,
  replacement: Request,
): boolean {
  const facts = readVerifiedNativeVirtualApplicationRequest(source);
  if (
    !facts ||
    source === replacement ||
    source.url !== replacement.url ||
    source.method !== replacement.method ||
    JSON.stringify([...source.headers]) !==
      JSON.stringify([...replacement.headers]) ||
    replacement.signal.aborted
  )
    return false;
  verifiedNativeVirtualRequests.set(
    replacement,
    Object.freeze({
      ...facts,
      isCurrent: () =>
        !replacement.signal.aborted &&
        facts.isCurrent() &&
        new URL(replacement.url).origin === facts.requestOrigin,
    }),
  );
  return readVerifiedNativeVirtualApplicationRequest(replacement) !== undefined;
}

export interface VerifiedVirtualApplicationRequestFacts
  extends VerifiedPionApplicationRequestFacts {
  readonly requestOrigin: string;
  readonly clientOrigin: string;
}

const verifiedVirtualRequests = new WeakMap<
  Request,
  VerifiedVirtualApplicationRequestFacts
>();

/** Read-only authority seam for internal relay-enrollment routes. */
export function readVerifiedVirtualApplicationRequest(
  request: Request,
): VerifiedVirtualApplicationRequestFacts | undefined {
  const facts = verifiedVirtualRequests.get(request);
  if (
    !facts ||
    request.signal.aborted ||
    facts.signal.aborted ||
    !facts.isCurrent() ||
    request.headers.get('origin') !== facts.clientOrigin ||
    new URL(request.url).origin !== facts.requestOrigin
  )
    return undefined;
  return facts;
}
const methods = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);
const forbiddenHeaders = new Set([
  'cookie',
  'cookie2',
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'forwarded',
  'via',
  'content-length',
  'x-real-ip',
]);
function forbiddenHeader(name: string): boolean {
  return (
    forbiddenHeaders.has(name) ||
    name.startsWith('x-forwarded-') ||
    name.startsWith('x-station-internal-') ||
    name.startsWith('x-station-proxy-') ||
    name === 'x-station-ingress-identity' ||
    name.startsWith('tailscale-')
  );
}
/**
 * The ingress's own refusal. It is written outside the Hono app, so the
 * runtime's marker middleware never sees it; it carries the marker itself,
 * because it is this Station's answer (#2842).
 */
function refusal(status: number, code: string) {
  return Response.json(
    { error: { code } },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE,
      },
    },
  );
}

/**
 * A virtual connection earns no socket, proxy or cookie authority. The ordinary
 * application middleware still verifies Device, account and resource grants.
 * One owner fences admission and response delivery when its runtime retires.
 */
export class VirtualApplicationIngress {
  private readonly lifetime = new AbortController();
  private application?: Application;
  private active = false;
  private readonly pending = new Set<AbortController>();
  constructor(
    private readonly origin: string,
    private readonly readPionFacts?: ReadPionApplicationRequestFacts,
    private readonly readNativePionFacts?: ReadNativePionApplicationRequestFacts,
  ) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
      throw new Error(
        'Virtual application requires a canonical Station origin',
      );
  }
  bind(application: Application): void {
    if (this.application || this.lifetime.signal.aborted)
      throw new Error('Virtual application already bound or retired');
    this.application = application;
  }
  activate(): VirtualApplication {
    if (!this.application || this.lifetime.signal.aborted || this.active)
      throw new Error('Virtual application cannot activate');
    this.active = true;
    return Object.freeze({
      signal: this.lifetime.signal,
      fetch: (request: Request) => this.dispatch(request),
    });
  }
  stop(): void {
    this.active = false;
    this.lifetime.abort(new Error('Station application retired'));
    for (const controller of this.pending)
      controller.abort(this.lifetime.signal.reason);
  }
  private async dispatch(input: Request): Promise<Response> {
    if (!this.active || !this.application)
      return refusal(503, 'application_unavailable');
    const url = new URL(input.url);
    if (url.origin !== this.origin || url.username || url.password || url.hash)
      return refusal(400, 'virtual_target_invalid');
    if (!methods.has(input.method))
      return refusal(405, 'virtual_method_unsupported');
    // Cookie login/exchange belongs to HTTPS. Relay-only login must use the
    // provider-supported, proof-bound continuation endpoints instead.
    if (
      (url.pathname === DEPLOYMENT_AUTHENTICATION_BASE_PATH ||
        url.pathname.startsWith(`${DEPLOYMENT_AUTHENTICATION_BASE_PATH}/`)) &&
      url.pathname !== APPLICATION_SESSION_BASE_PATH &&
      !url.pathname.startsWith(`${APPLICATION_SESSION_BASE_PATH}/`) &&
      !(
        input.method === 'GET' &&
        [
          DEPLOYMENT_AUTHENTICATION_BASE_PATH,
          `${DEPLOYMENT_AUTHENTICATION_BASE_PATH}/session`,
        ].includes(url.pathname)
      ) &&
      !(
        input.method === 'POST' &&
        url.pathname ===
          `${DEPLOYMENT_AUTHENTICATION_BASE_PATH}/accept-invitation`
      ) &&
      !(
        input.method === 'POST' &&
        [
          RELAY_ENROLLMENT_BEGIN_PATH,
          RELAY_ENROLLMENT_LOGIN_PATH,
          RELAY_ENROLLMENT_FINALIZE_PATH,
          RELAY_ENROLLMENT_ACTIVATE_PATH,
        ].includes(
          url.pathname as
            | typeof RELAY_ENROLLMENT_BEGIN_PATH
            | typeof RELAY_ENROLLMENT_LOGIN_PATH
            | typeof RELAY_ENROLLMENT_FINALIZE_PATH
            | typeof RELAY_ENROLLMENT_ACTIVATE_PATH,
        )
      )
    )
      return refusal(400, 'virtual_cookie_operation_unsupported');
    for (const [name] of input.headers)
      if (forbiddenHeader(name))
        return refusal(400, 'virtual_header_forbidden');
    const pionFacts = this.readPionFacts?.(input);
    const nativeFacts = this.readNativePionFacts?.(input);
    if (pionFacts && nativeFacts)
      return refusal(403, 'virtual_pion_provenance_invalid');
    if (
      pionFacts &&
      (!pionFacts.isCurrent() ||
        pionFacts.signal.aborted ||
        pionFacts.stationOrigin !== this.origin ||
        url.origin !== pionFacts.stationOrigin ||
        input.headers.get('origin') !== pionFacts.browserOrigin)
    )
      return refusal(403, 'virtual_pion_provenance_invalid');
    if (
      nativeFacts &&
      (!nativeFacts.isCurrent() ||
        nativeFacts.signal.aborted ||
        nativeFacts.stationOrigin !== this.origin ||
        url.origin !== nativeFacts.stationOrigin ||
        input.headers.has('origin') ||
        nativeFacts.surface.kind !== 'station-native')
    )
      return refusal(403, 'virtual_pion_provenance_invalid');
    if (this.pending.size >= 32)
      return refusal(429, 'virtual_capacity_exhausted');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      input.signal,
      controller.signal,
      ...(pionFacts ? [pionFacts.signal] : []),
      ...(nativeFacts ? [nativeFacts.signal] : []),
    ]);
    signal.throwIfAborted();
    this.pending.add(controller);
    let handlerStarted = false;
    let handlerSettled = false;
    const release = () => {
      if (!handlerStarted || handlerSettled) this.pending.delete(controller);
    };
    let response: Response;
    try {
      // New identity, no inherited WeakMap authorization and no fabricated env.
      const request = new Request(input.url, {
        method: input.method,
        headers: new Headers(input.headers),
        body: input.body,
        signal,
        redirect: 'error',
        credentials: 'omit',
        ...(input.body ? { duplex: 'half' as const } : {}),
      });
      if (pionFacts) {
        const facts = Object.freeze({
          ...pionFacts,
          signal,
          requestOrigin: this.origin,
          clientOrigin: pionFacts.browserOrigin,
          isCurrent: () =>
            !signal.aborted &&
            pionFacts.isCurrent() &&
            new URL(request.url).origin === pionFacts.stationOrigin,
        });
        verifiedVirtualRequests.set(request, facts);
      }
      if (nativeFacts) {
        verifiedNativeVirtualRequests.set(
          request,
          Object.freeze({
            ...nativeFacts,
            surface: Object.freeze({ ...nativeFacts.surface }),
            signal,
            requestOrigin: this.origin,
            isCurrent: () =>
              !signal.aborted &&
              nativeFacts.isCurrent() &&
              new URL(request.url).origin === nativeFacts.stationOrigin,
          }),
        );
      }
      handlerStarted = true;
      response = await this.awaitResponse(this.application, request, () => {
        handlerSettled = true;
        if (signal.aborted) release();
      });
      signal.throwIfAborted();
      if (
        response.headers.has('set-cookie') ||
        response.headers.has('set-cookie2')
      ) {
        void response.body?.cancel().catch(() => {});
        release();
        return refusal(502, 'virtual_cookie_response_unsupported');
      }
      if (!response.body) {
        release();
        return response;
      }
      return this.guardResponse(response, signal, release);
    } catch (error) {
      release();
      throw error;
    }
  }
  private awaitResponse(
    application: Application,
    request: Request,
    settled: () => void,
  ): Promise<Response> {
    const signal = request.signal;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return application.fetch(request);
        })
        .then(
          (response) => {
            settled();
            signal.removeEventListener('abort', abort);
            if (signal.aborted) {
              void response.body?.cancel(signal.reason).catch(() => {});
              reject(signal.reason);
            } else resolve(response);
          },
          (error) => {
            settled();
            signal.removeEventListener('abort', abort);
            reject(error);
          },
        );
      if (signal.aborted) abort();
    });
  }
  private guardResponse(
    response: Response,
    signal: AbortSignal,
    release: () => void,
  ) {
    const reader = response.body!.getReader();
    let finished = false;
    let output: ReadableStreamDefaultController<Uint8Array>;
    const finish = () => {
      if (finished) return false;
      finished = true;
      signal.removeEventListener('abort', abort);
      release();
      return true;
    };
    const abort = () => {
      if (!finish()) return;
      output.error(signal.reason);
      // Cancellation failures cannot deliver retired response data.
      void reader.cancel(signal.reason).catch(() => {});
    };
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          output = controller;
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        },
        async pull(controller) {
          try {
            const result = await reader.read();
            if (finished) return;
            signal.throwIfAborted();
            if (result.done) {
              finish();
              controller.close();
            } else controller.enqueue(result.value);
          } catch (error) {
            if (finish()) controller.error(error);
          }
        },
        async cancel(reason) {
          if (finish()) await reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  }
}
