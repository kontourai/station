import { createHash } from 'node:crypto';
import {
  type DeploymentAuthenticationDescriptor,
  type DeploymentAuthenticationProvider,
  type DeploymentAuthenticationResult,
  type VerifiedAuthenticationSession,
} from '@kontourai/station-contracts/deployment-authentication';
import {
  humanPrincipal,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { raceWithSignal } from '../../utils/bounded-async.js';
import { createLogger } from '../../utils/logger.js';
import {
  readDeploymentAuthenticationDescriptor,
  readDeploymentAuthenticationResult,
} from './deployment-authentication-validation.js';
import { PrincipalUnresolvedError } from './principal-resolver.js';

const logger = createLogger({ name: 'deployment-authentication' });
export type ResolvedDeploymentAuthentication =
  | Exclude<DeploymentAuthenticationResult, { kind: 'authenticated' }>
  | {
      kind: 'authenticated';
      issuer: string;
      principal: PrincipalRef;
      session: VerifiedAuthenticationSession;
    };

/** Validates the adapter boundary and derives identities; never mints Station access credentials. */
export class DeploymentAuthenticationService {
  private readonly description: DeploymentAuthenticationDescriptor;
  private readonly requests = new WeakMap<
    Request,
    ResolvedDeploymentAuthentication
  >();
  private closing = false;
  private closePromise?: Promise<void>;

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
    return this.presentedCookies(request).length > 0;
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

  /** Carry only a previously verified result through the runtime's bounded-body replacement. */
  transferRequest(source: Request, replacement: Request): void {
    if (source.url !== replacement.url || source.method !== replacement.method)
      throw new Error(
        'Account authority cannot move to a different request target.',
      );
    const result = this.requests.get(source);
    if (result) this.requests.set(replacement, structuredClone(result));
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
    const result = await this.resolve(request);
    if (this.closing) return { kind: 'unavailable' };
    this.requests.set(request, structuredClone(result));
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
      const parsed = readDeploymentAuthenticationResult(result, this.now());
      if (parsed.kind === 'absent')
        return { kind: 'invalid', reason: 'invalid-credential' };
      if (parsed.kind !== 'authenticated') return parsed;
      const session = parsed.session;
      // Hash the unambiguous exact pair to keep PrincipalRef bounded without
      // exposing upstream identifiers. Display/contact changes do not merge people.
      const subject = createHash('sha256')
        .update(JSON.stringify([this.description.issuer, session.subject]))
        .digest('hex');
      return {
        kind: 'authenticated',
        issuer: this.description.issuer,
        principal: humanPrincipal('deployment', subject, session.displayName),
        session,
      };
    } catch {
      // Provider exceptions may contain credentials or callback query values.
      logger.error(
        'Deployment authentication provider failed to resolve a request.',
      );
      return { kind: 'unavailable' };
    }
  }
}
