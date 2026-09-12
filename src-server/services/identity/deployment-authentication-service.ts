import { createHash } from 'node:crypto';
import {
  DEPLOYMENT_AUTHENTICATION_VERSION,
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

const logger = createLogger({ name: 'deployment-authentication' });
const operations = new Set([
  'begin-login',
  'callback',
  'register',
  'verify-contact',
  'request-recovery',
  'complete-recovery',
  'change-password',
  'refresh-session',
  'logout',
  'revoke-session',
]);
const invalidReasons = new Set([
  'invalid-credential',
  'expired',
  'revoked',
  'conflicting-identity',
]);

export type ResolvedDeploymentAuthentication =
  | Exclude<DeploymentAuthenticationResult, { kind: 'authenticated' }>
  | {
      kind: 'authenticated';
      issuer: string;
      principal: PrincipalRef;
      session: VerifiedAuthenticationSession;
    };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    value.trim() !== '' &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  );
}

function fields(
  value: Record<string, unknown>,
  names: readonly string[],
): boolean {
  return Object.keys(value).every((key) => names.includes(key));
}

function timestamp(value: unknown): number {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
    ? Date.parse(value)
    : Number.NaN;
}

function readSession(
  value: unknown,
  now: number,
): VerifiedAuthenticationSession | undefined {
  if (
    !record(value) ||
    !fields(value, [
      'subject',
      'displayName',
      'sessionId',
      'authenticatedAt',
      'expiresAt',
      'contacts',
    ]) ||
    !text(value.subject, 2048) ||
    !text(value.displayName, 256) ||
    !text(value.sessionId, 512) ||
    !Array.isArray(value.contacts) ||
    value.contacts.length > 16
  )
    return undefined;
  const authenticatedAt = timestamp(value.authenticatedAt);
  const expiresAt = timestamp(value.expiresAt);
  if (
    !Number.isFinite(authenticatedAt) ||
    !Number.isFinite(expiresAt) ||
    authenticatedAt > now ||
    expiresAt <= authenticatedAt
  )
    return undefined;
  for (const contact of value.contacts) {
    if (
      !record(contact) ||
      !fields(contact, ['kind', 'value', 'verifiedAt']) ||
      contact.kind !== 'email' ||
      !text(contact.value, 320) ||
      !/^[^\s@]+@[^\s@]+$/.test(contact.value) ||
      !Number.isFinite(timestamp(contact.verifiedAt)) ||
      timestamp(contact.verifiedAt) > now
    )
      return undefined;
  }
  return structuredClone(value) as unknown as VerifiedAuthenticationSession;
}

function providerDescription(
  provider: DeploymentAuthenticationProvider,
): DeploymentAuthenticationDescriptor {
  if (
    provider.version !== DEPLOYMENT_AUTHENTICATION_VERSION ||
    !text(provider.issuer, 2048) ||
    !text(provider.displayName, 256) ||
    typeof provider.authenticate !== 'function' ||
    typeof provider.handle !== 'function' ||
    !Array.isArray(provider.endpoints) ||
    provider.endpoints.length > 32 ||
    !Array.isArray(provider.sessionCookies) ||
    provider.sessionCookies.length < 1 ||
    provider.sessionCookies.length > 4 ||
    provider.sessionCookies.some(
      (name) =>
        typeof name !== 'string' ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(name) ||
        ['station-device', '__Host-station-device'].includes(name),
    ) ||
    new Set(provider.sessionCookies).size !== provider.sessionCookies.length
  ) {
    throw new Error('Unsupported deployment authentication provider contract.');
  }
  const issuer = new URL(provider.issuer);
  if (
    issuer.username ||
    issuer.password ||
    issuer.hash ||
    issuer.search ||
    provider.issuer !== provider.issuer.trim()
  ) {
    throw new Error(
      'Deployment authentication issuer must be an exact non-secret authority URI.',
    );
  }
  const endpoints = structuredClone(provider.endpoints);
  const used = new Set<string>();
  for (const endpoint of endpoints) {
    if (
      !record(endpoint) ||
      !fields(endpoint, ['path', 'methods', 'operation']) ||
      !text(endpoint.path, 256) ||
      endpoint.path === '/session' ||
      !/^\/[a-z0-9][a-z0-9/_-]*$/.test(endpoint.path) ||
      endpoint.path.includes('//') ||
      typeof endpoint.operation !== 'string' ||
      !operations.has(endpoint.operation) ||
      !Array.isArray(endpoint.methods) ||
      !endpoint.methods.length
    ) {
      throw new Error('Invalid deployment authentication endpoint.');
    }
    for (const method of endpoint.methods) {
      const key = `${method} ${endpoint.path}`;
      if ((method !== 'GET' && method !== 'POST') || used.has(key))
        throw new Error('Invalid deployment authentication endpoint method.');
      used.add(key);
    }
  }
  if (
    !endpoints.some(
      (endpoint) =>
        endpoint.operation === 'logout' && endpoint.methods.includes('POST'),
    )
  ) {
    throw new Error(
      'Deployment authentication requires an explicit logout operation.',
    );
  }
  return {
    version: DEPLOYMENT_AUTHENTICATION_VERSION,
    issuer: provider.issuer,
    displayName: provider.displayName,
    endpoints,
    sessionCookies: [...provider.sessionCookies],
  };
}

/** Validates the adapter boundary and derives identities; never mints Station access credentials. */
export class DeploymentAuthenticationService {
  private readonly description: ReturnType<typeof providerDescription>;
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
    this.description = providerDescription(provider);
  }

  describe(): ReturnType<typeof providerDescription> {
    return structuredClone(this.description);
  }

  current(request: Request): ResolvedDeploymentAuthentication | undefined {
    if (this.closing) return { kind: 'unavailable' };
    const result = this.requests.get(request);
    if (
      result?.kind === 'authenticated' &&
      timestamp(result.session.expiresAt) <= this.now()
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
      const presented = (request.headers.get('cookie') ?? '')
        .split(';')
        .filter((entry) =>
          this.description.sessionCookies.includes(
            entry.trim().split('=')[0]!.trim(),
          ),
        );
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
      if (request.signal.aborted || !record(result))
        return { kind: 'unavailable' };
      if (result.kind === 'absent' && fields(result, ['kind']))
        return { kind: 'invalid', reason: 'invalid-credential' };
      if (result.kind === 'unavailable' && fields(result, ['kind']))
        return { kind: 'unavailable' };
      if (
        result.kind === 'invalid' &&
        fields(result, ['kind', 'reason']) &&
        typeof result.reason === 'string' &&
        invalidReasons.has(result.reason)
      ) {
        return {
          kind: 'invalid',
          reason: result.reason as Extract<
            DeploymentAuthenticationResult,
            { kind: 'invalid' }
          >['reason'],
        };
      }
      if (
        result.kind !== 'authenticated' ||
        !fields(result, ['kind', 'session'])
      )
        return { kind: 'unavailable' };
      const now = this.now();
      const session = readSession(result.session, now);
      if (!session) return { kind: 'unavailable' };
      if (timestamp(session.expiresAt) <= now)
        return { kind: 'invalid', reason: 'expired' };
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
