import { createHash } from 'node:crypto';
import {
  APPLICATION_SESSION_HEADER,
  APPLICATION_SESSION_PROOF_HEADER,
} from '@kontourai/station-contracts/application-session';
import {
  type DeploymentAuthenticationDescriptor,
  type DeploymentAuthenticationProvider,
  type DeploymentAuthenticationResult,
  type PendingEnrollmentSessionResult,
  type VerifiedAuthenticationSession,
} from '@kontourai/station-contracts/deployment-authentication';
import {
  humanPrincipal,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import {
  awaitSettlementWithin,
  raceWithSignal,
} from '../../utils/bounded-async.js';
import { createLogger } from '../../utils/logger.js';
import {
  readDeploymentAuthenticationDescriptor,
  readDeploymentAuthenticationResult,
  readPendingEnrollmentSessionResult,
} from './deployment-authentication-validation.js';
import { PrincipalUnresolvedError } from './principal-resolver.js';

const logger = createLogger({ name: 'deployment-authentication' });
const RELAY_ENROLLMENT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export function deploymentAccountPrincipal(
  issuer: string,
  subject: string,
  displayName: string,
): PrincipalRef {
  const boundedSubject = createHash('sha256')
    .update(JSON.stringify([issuer, subject]))
    .digest('hex');
  return humanPrincipal('deployment', boundedSubject, displayName);
}

export type ResolvedDeploymentAuthentication =
  | Exclude<DeploymentAuthenticationResult, { kind: 'authenticated' }>
  | {
      kind: 'authenticated';
      issuer: string;
      principal: PrincipalRef;
      session: VerifiedAuthenticationSession;
    };

export interface ApplicationSessionResolver {
  authenticate(request: Request): Promise<ResolvedDeploymentAuthentication>;
  transferRequest(source: Request, replacement: Request): void;
  revoke(request: Request): Promise<void>;
}

/** Validates the adapter boundary and derives identities; never mints Station access credentials. */
export class DeploymentAuthenticationService {
  private readonly description: DeploymentAuthenticationDescriptor;
  private readonly requests = new WeakMap<
    Request,
    ResolvedDeploymentAuthentication
  >();
  private readonly admissions = new WeakMap<Request, PrincipalRef>();
  private closing = false;
  private closePromise?: Promise<void>;
  private continuation?: ApplicationSessionResolver;
  private started = false;

  constructor(
    private readonly provider: DeploymentAuthenticationProvider,
    private readonly now: () => number = Date.now,
  ) {
    this.description = readDeploymentAuthenticationDescriptor(provider);
  }

  describe(): DeploymentAuthenticationDescriptor {
    return structuredClone(this.description);
  }

  hasCredential(request: Request): boolean {
    return (
      this.presentedCookies(request).length > 0 || this.hasContinuation(request)
    );
  }

  private hasContinuation(request: Request): boolean {
    return (
      request.headers.has(APPLICATION_SESSION_HEADER) ||
      request.headers.has(APPLICATION_SESSION_PROOF_HEADER)
    );
  }
  installContinuationResolver(resolver: ApplicationSessionResolver): void {
    if (this.started || this.closing || this.continuation)
      throw new Error(
        'Application sessions must be composed once before request admission.',
      );
    this.continuation = resolver;
  }
  sessionReferenceCapabilities() {
    return {
      verify:
        typeof this.provider.sessionReferences?.verify === 'function' &&
        typeof this.provider.sessionReferences?.revoke === 'function',
      login: typeof this.provider.sessionReferences?.login === 'function',
    };
  }

  pendingEnrollmentCapabilities(): { available: boolean } {
    const pending = this.provider.sessionReferences?.pendingEnrollment;
    return {
      available:
        this.sessionReferenceCapabilities().verify &&
        this.description.login?.kind === 'username-password' &&
        typeof pending?.create === 'function' &&
        typeof pending.verify === 'function' &&
        typeof pending.promote === 'function' &&
        typeof pending.discard === 'function',
    };
  }

  /** Candidate-only provider login; never publishes ordinary request identity. */
  async createPendingEnrollment(
    enrollmentId: string,
    request: Request,
  ): Promise<PendingEnrollmentSessionResult> {
    const pending = this.provider.sessionReferences?.pendingEnrollment;
    if (
      this.closing ||
      !RELAY_ENROLLMENT_ID_PATTERN.test(enrollmentId) ||
      !this.pendingEnrollmentCapabilities().available ||
      !pending
    )
      return { kind: 'unavailable' };
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(10_000),
    ]);
    try {
      const headers = new Headers(request.headers);
      // Provider-owned password verification must not adopt or forward any
      // browser/Device/continuation cookie. Only public request context such
      // as Origin and Content-Type may reach the provider hook.
      headers.delete('Cookie');
      headers.delete('Cookie2');
      headers.delete('Authorization');
      headers.delete(APPLICATION_SESSION_HEADER);
      headers.delete(APPLICATION_SESSION_PROOF_HEADER);
      headers.delete('Content-Length');
      const bounded = new Request(request, { headers, signal });
      const result = await raceWithSignal(
        pending.create(enrollmentId, bounded),
        signal,
      );
      if (this.closing || signal.aborted) return { kind: 'unavailable' };
      return readPendingEnrollmentSessionResult(
        result,
        enrollmentId,
        this.now(),
      );
    } catch {
      return { kind: 'unavailable' };
    }
  }

  /** Recheck an exact still-pending session; this never falls back to generic verify. */
  async verifyPendingEnrollment(
    enrollmentId: string,
    sessionId: string,
    callerSignal: AbortSignal,
  ): Promise<PendingEnrollmentSessionResult> {
    const pending = this.provider.sessionReferences?.pendingEnrollment;
    if (
      this.closing ||
      !RELAY_ENROLLMENT_ID_PATTERN.test(enrollmentId) ||
      !sessionId.trim() ||
      !this.pendingEnrollmentCapabilities().available ||
      !pending
    )
      return { kind: 'unavailable' };
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)]);
    try {
      const result = await raceWithSignal(
        pending.verify(enrollmentId, sessionId, signal),
        signal,
      );
      if (this.closing || signal.aborted) return { kind: 'unavailable' };
      const checked = readPendingEnrollmentSessionResult(
        result,
        enrollmentId,
        this.now(),
      );
      return checked.kind === 'pending' &&
        checked.session.sessionId !== sessionId
        ? { kind: 'invalid', reason: 'conflicting-identity' }
        : checked;
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async promotePendingEnrollment(
    enrollmentId: string,
    sessionId: string,
    callerSignal: AbortSignal,
  ): Promise<void> {
    const pending = this.provider.sessionReferences?.pendingEnrollment;
    if (
      this.closing ||
      !RELAY_ENROLLMENT_ID_PATTERN.test(enrollmentId) ||
      !sessionId.trim() ||
      !this.pendingEnrollmentCapabilities().available ||
      !pending
    )
      throw new Error('Pending enrollment promotion is unavailable.');
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)]);
    const operation = Promise.resolve().then(() =>
      pending.promote(enrollmentId, sessionId, signal),
    );
    if (!(await awaitSettlementWithin(operation, 10_000)))
      throw new Error('Pending enrollment promotion is unconfirmed.');
    await operation;
  }

  async discardPendingEnrollment(
    enrollmentId: string,
    sessionId: string | undefined,
    callerSignal: AbortSignal,
  ): Promise<void> {
    const pending = this.provider.sessionReferences?.pendingEnrollment;
    if (
      this.closing ||
      !RELAY_ENROLLMENT_ID_PATTERN.test(enrollmentId) ||
      (sessionId !== undefined && !sessionId.trim()) ||
      !this.pendingEnrollmentCapabilities().available ||
      !pending
    )
      throw new Error('Pending enrollment cleanup is unavailable.');
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)]);
    const operation = Promise.resolve().then(() =>
      pending.discard(enrollmentId, sessionId, signal),
    );
    if (!(await awaitSettlementWithin(operation, 10_000)))
      throw new Error('Pending enrollment cleanup is unconfirmed.');
    await operation;
  }

  async verifySessionReference(
    sessionId: string,
    callerSignal: AbortSignal,
  ): Promise<ResolvedDeploymentAuthentication> {
    if (this.closing || !this.provider.sessionReferences?.verify)
      return { kind: 'unavailable' };
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)]);
    try {
      const result = this.resolveResult(
        await raceWithSignal(
          this.provider.sessionReferences.verify(sessionId, signal),
          signal,
        ),
      );
      if (this.closing || signal.aborted) return { kind: 'unavailable' };
      if (
        result.kind === 'authenticated' &&
        result.session.sessionId !== sessionId
      )
        return { kind: 'invalid', reason: 'conflicting-identity' };
      return result;
    } catch {
      return { kind: 'unavailable' };
    }
  }
  async revokeSessionReference(
    sessionId: string,
    callerSignal: AbortSignal,
  ): Promise<void> {
    if (this.closing || !this.provider.sessionReferences?.revoke)
      throw new Error('Account session revocation is unavailable.');
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)]);
    const operation = Promise.resolve().then(() =>
      this.provider.sessionReferences!.revoke(sessionId, signal),
    );
    if (!(await awaitSettlementWithin(operation, 10_000)))
      throw new Error('Account session revocation is unconfirmed.');
    await operation;
  }
  async loginVirtualSession(
    request: Request,
  ): Promise<ResolvedDeploymentAuthentication> {
    if (this.closing || !this.provider.sessionReferences?.login)
      return { kind: 'unavailable' };
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(10_000),
    ]);
    try {
      const bounded = new Request(request, { signal });
      const result = this.resolveResult(
        await raceWithSignal(
          this.provider.sessionReferences.login(bounded),
          signal,
        ),
      );
      return this.closing || signal.aborted ? { kind: 'unavailable' } : result;
    } catch {
      return { kind: 'unavailable' };
    }
  }

  private presentedCookies(request: Request): string[] {
    return (request.headers.get('cookie') ?? '')
      .split(';')
      .filter((entry) =>
        this.description.sessionCookies.includes(
          entry.trim().split('=')[0]!.trim(),
        ),
      );
  }

  current(request: Request): ResolvedDeploymentAuthentication | undefined {
    if (this.closing || request.signal.aborted) return { kind: 'unavailable' };
    const result = this.requests.get(request);
    if (
      result?.kind === 'authenticated' &&
      Date.parse(result.session.expiresAt) <= this.now()
    ) {
      return { kind: 'invalid', reason: 'expired' };
    }
    return result ? structuredClone(result) : undefined;
  }
  /** Historical request admission, used only to require a fresh check before response delivery. */
  admittedPrincipalSnapshot(request: Request): PrincipalRef | undefined {
    const principal = this.admissions.get(request);
    return principal ? structuredClone(principal) : undefined;
  }

  /** Carry only a previously verified result through the runtime's bounded-body replacement. */
  transferRequest(source: Request, replacement: Request): void {
    if (source.url !== replacement.url || source.method !== replacement.method)
      throw new Error(
        'Account authority cannot move to a different request target.',
      );
    const result = this.requests.get(source);
    if (result) this.requests.set(replacement, structuredClone(result));
    const admitted = this.admissions.get(source);
    if (admitted) this.admissions.set(replacement, structuredClone(admitted));
    this.continuation?.transferRequest(source, replacement);
  }

  /** Reconcile separately verified people at the one account identity owner. */
  resolvePrincipal(
    request: Request,
    corroborating: readonly PrincipalRef[] = [],
  ): PrincipalRef | undefined {
    const account = this.current(request);
    if (!account || account.kind === 'absent') return undefined;
    if (account.kind !== 'authenticated')
      throw new PrincipalUnresolvedError(
        'Account authentication is no longer valid.',
      );
    if (
      corroborating.some((principal) => principal.id !== account.principal.id)
    )
      throw new PrincipalUnresolvedError(
        'Account authentication conflicts with the verified person.',
      );
    return account.principal;
  }

  async handle(request: Request, relativePath: string): Promise<Response> {
    if (this.closing)
      return Response.json(
        { error: { code: 'authentication_unavailable' } },
        { status: 503 },
      );
    if (
      !this.description.endpoints.some(
        (endpoint) =>
          endpoint.path === relativePath &&
          endpoint.methods.some((method) => method === request.method),
      )
    ) {
      return Response.json(
        { error: { code: 'authentication_operation_unsupported' } },
        { status: 404 },
      );
    }
    try {
      if (
        this.hasContinuation(request) &&
        this.description.endpoints.some(
          (endpoint) =>
            endpoint.path === relativePath && endpoint.operation === 'logout',
        )
      ) {
        if (!this.continuation)
          throw new Error('Application sessions are unavailable.');
        await this.continuation.revoke(request);
        return Response.json(
          { success: true },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(10_000),
      ]);
      const bounded = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        signal,
        ...(request.method === 'GET' || request.method === 'HEAD'
          ? {}
          : { body: request.body, duplex: 'half' as const }),
      });
      const response = await raceWithSignal(
        this.provider.handle(bounded),
        signal,
      );
      if (this.closing || signal.aborted)
        throw new Error('Authentication operation retired.');
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, headers });
    } catch {
      logger.error('Deployment authentication operation is unavailable.');
      return Response.json(
        { error: { code: 'authentication_unavailable' } },
        { status: 503 },
      );
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.closePromise ??= Promise.resolve()
      .then(() => this.provider.close?.())
      .catch((error) => {
        this.closePromise = undefined;
        throw error;
      });
    await this.closePromise;
  }

  async authenticate(
    request: Request,
  ): Promise<ResolvedDeploymentAuthentication> {
    if (this.closing) return { kind: 'unavailable' };
    this.started = true;
    let result: ResolvedDeploymentAuthentication;
    if (this.hasContinuation(request)) {
      result = this.continuation
        ? await this.continuation.authenticate(request)
        : { kind: 'invalid', reason: 'invalid-credential' };
      if (this.presentedCookies(request).length) {
        const cookie = await this.resolve(request);
        if (cookie.kind !== 'authenticated') result = cookie;
        else if (
          result.kind === 'authenticated' &&
          cookie.principal.id !== result.principal.id
        )
          result = { kind: 'invalid', reason: 'conflicting-identity' };
      }
    } else result = await this.resolve(request);
    if (this.closing) return { kind: 'unavailable' };
    this.requests.set(request, structuredClone(result));
    if (result.kind === 'authenticated' && !this.admissions.has(request))
      this.admissions.set(request, structuredClone(result.principal));
    return result;
  }

  private async resolve(
    request: Request,
  ): Promise<ResolvedDeploymentAuthentication> {
    try {
      if (request.signal.aborted) return { kind: 'unavailable' };
      const presented = this.presentedCookies(request);
      if (!presented.length) return { kind: 'absent' };
      if (
        presented.length !== 1 ||
        !presented[0]!.split('=').slice(1).join('=').trim()
      )
        return { kind: 'invalid', reason: 'invalid-credential' };
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(10_000),
      ]);
      if (signal.aborted) return { kind: 'unavailable' };
      const result: unknown = await raceWithSignal(
        this.provider.authenticate({
          url: request.url,
          method: request.method,
          headers: new Headers(request.headers),
          signal,
        }),
        signal,
      );
      if (request.signal.aborted) return { kind: 'unavailable' };
      return this.resolveResult(result);
    } catch {
      // Provider exceptions may contain credentials or callback query values.
      logger.error(
        'Deployment authentication provider failed to resolve a request.',
      );
      return { kind: 'unavailable' };
    }
  }

  private resolveResult(result: unknown): ResolvedDeploymentAuthentication {
    const parsed = readDeploymentAuthenticationResult(result, this.now());
    if (parsed.kind === 'absent')
      return { kind: 'invalid', reason: 'invalid-credential' };
    if (parsed.kind !== 'authenticated') return parsed;
    const session = parsed.session;
    // Hash the unambiguous exact pair to keep PrincipalRef bounded without
    // exposing upstream identifiers. Display/contact changes do not merge people.
    return {
      kind: 'authenticated',
      issuer: this.description.issuer,
      principal: deploymentAccountPrincipal(
        this.description.issuer,
        session.subject,
        session.displayName,
      ),
      session,
    };
  }
}
