import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { Logger } from '../../utils/logger.js';
import type {
  LazyOperatorPasskeyRegistry,
  OperatorSessionRecord,
} from './operator-passkey-registry.js';

export const OPERATOR_SESSION_COOKIE = '__Host-station-operator';
export const OPERATOR_SESSION_IDLE_MS = 15 * 60_000;
export const OPERATOR_SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;
const CHALLENGE_MS = 2 * 60_000;
const digest = (value: string) =>
  createHash('sha256').update(value).digest('base64url');

export class OperatorSignInError extends Error {
  constructor(
    readonly code:
      | 'operator_session_required'
      | 'sign_in_unavailable'
      | 'challenge_invalid'
      | 'verification_failed'
      | 'rate_limited',
  ) {
    super(code);
  }
}
interface Ceremony {
  binding: string;
  deviceId: string;
  epoch: string;
  expiresAt: number;
  challenge?: string;
}

/** Passkeys authenticate the person; the live pairing cookie binds the browser. */
export class OperatorSessionService {
  readonly #ceremonies = new Map<string, Ceremony>();
  readonly #budgets = new Map<string, { count: number; until: number }>();
  readonly #now: () => number;
  constructor(
    private readonly deps: {
      registry: LazyOperatorPasskeyRegistry;
      origin: string | null;
      /** Read live pairing state, including revocation; delegation grants never qualify. */
      identifyDevice(credential: string): { id: string; kind?: string } | null;
      /** Changes whenever the host rotates its operator credential or resets its home. */
      epoch(): string;
      available?(): boolean;
      now?: () => number;
      logger?: Logger;
    },
  ) {
    this.#now = deps.now ?? Date.now;
  }

  get signInUrl(): string | null {
    return this.deps.origin && this.deps.available?.() !== false
      ? `${this.deps.origin}/operator/sign-in`
      : null;
  }

  #device(credential: string | undefined): { id: string } {
    const device = credential ? this.deps.identifyDevice(credential) : null;
    if (!device?.id || device.kind === 'delegation')
      throw new OperatorSignInError('operator_session_required');
    return device;
  }

  renderNonce(credential: string): string {
    if (!this.signInUrl) throw new OperatorSignInError('sign_in_unavailable');
    const now = this.#now();
    for (const [key, item] of this.#ceremonies)
      if (item.expiresAt <= now) this.#ceremonies.delete(key);
    for (const [key, budget] of this.#budgets)
      if (budget.until <= now) this.#budgets.delete(key);
    const device = this.#device(credential);
    const key = digest(device.id);
    const budget = this.#budgets.get(key) ?? { count: 0, until: now + 60_000 };
    if (
      budget.count >= 5 ||
      this.#ceremonies.size >= 1000 ||
      this.#budgets.size >= 1000
    )
      throw new OperatorSignInError('rate_limited');
    budget.count++;
    this.#budgets.set(key, budget);
    const nonce = randomBytes(32).toString('base64url');
    this.#ceremonies.set(digest(nonce), {
      binding: digest(credential),
      deviceId: device.id,
      epoch: this.deps.epoch(),
      expiresAt: now + CHALLENGE_MS,
    });
    return nonce;
  }

  #consume(nonce: string, credential: string): Ceremony {
    const key = digest(nonce);
    const ceremony = this.#ceremonies.get(key);
    // Delete synchronously, before any asynchronous WebAuthn operation.
    this.#ceremonies.delete(key);
    if (
      !this.signInUrl ||
      !ceremony ||
      ceremony.expiresAt <= this.#now() ||
      ceremony.binding !== digest(credential) ||
      ceremony.deviceId !== this.#device(credential).id ||
      ceremony.epoch !== this.deps.epoch()
    )
      throw new OperatorSignInError('challenge_invalid');
    return ceremony;
  }

  consumeSignOutNonce(nonce: string, credential: string): void {
    this.#consume(nonce, credential);
  }

  async options(nonce: string, credential: string) {
    const ceremony = this.#consume(nonce, credential);
    const registry = this.deps.registry.existing();
    const ids = registry?.activeCredentialIds() ?? [];
    if (ids.length === 0) throw new OperatorSignInError('sign_in_unavailable');
    const options = await generateAuthenticationOptions({
      rpID: new URL(this.deps.origin!).hostname,
      userVerification: 'required',
      allowCredentials: ids.map(({ id }) => ({ id })),
      timeout: CHALLENGE_MS,
    });
    const ceremonyId = randomBytes(32).toString('base64url');
    this.#ceremonies.set(digest(ceremonyId), {
      ...ceremony,
      challenge: options.challenge,
    });
    return { options, ceremonyId };
  }

  async complete(
    ceremonyId: string,
    credential: string,
    response: AuthenticationResponseJSON,
  ) {
    const ceremony = this.#consume(ceremonyId, credential);
    if (!ceremony.challenge) throw new OperatorSignInError('challenge_invalid');
    const registry = this.deps.registry.existing();
    const stored = registry?.authenticationCredential(response.id);
    const origin = this.deps.origin!;
    if (
      !registry ||
      !stored ||
      stored.passkey.origin !== origin ||
      stored.passkey.rpId !== new URL(origin).hostname
    )
      throw new OperatorSignInError('verification_failed');
    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: origin,
        expectedRPID: new URL(origin).hostname,
        expectedType: 'webauthn.get',
        credential: stored.credential,
        requireUserVerification: true,
      });
    } catch {
      throw new OperatorSignInError('verification_failed');
    }
    // Re-resolve after verification: device revocation and rotation may race the await.
    if (
      !verified.verified ||
      !verified.authenticationInfo.userVerified ||
      ceremony.expiresAt <= this.#now() ||
      this.#device(credential).id !== ceremony.deviceId ||
      ceremony.epoch !== this.deps.epoch() ||
      !registry.recordAuthentication(
        stored.passkey.id,
        stored.credential.counter,
        verified.authenticationInfo.newCounter,
      )
    )
      throw new OperatorSignInError('verification_failed');
    const now = this.#now();
    const secret = registry.createSession({
      passkeyId: stored.passkey.id,
      boundDeviceId: ceremony.deviceId,
      epoch: ceremony.epoch,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + OPERATOR_SESSION_ABSOLUTE_MS,
    });
    this.deps.logger?.info('Operator signed in', {
      event: 'station.operator.sign_in',
      passkey: createHmac('sha256', this.deps.epoch())
        .update(stored.passkey.id)
        .digest('base64url'),
      device: createHmac('sha256', this.deps.epoch())
        .update(ceremony.deviceId)
        .digest('base64url'),
    });
    return { secret, session: this.resolve(secret, credential)! };
  }

  resolve(
    secret: string,
    credential: string | undefined,
    touch = false,
  ): OperatorSessionRecord | null {
    if (!this.signInUrl || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    const registry = this.deps.registry.existing();
    const session = registry?.session(secret);
    if (!registry || !session) return null;
    let device: { id: string };
    try {
      device = this.#device(credential);
    } catch {
      return null;
    }
    const passkey = registry.get(session.passkeyId);
    const now = this.#now();
    if (
      session.boundDeviceId !== device.id ||
      session.epoch !== this.deps.epoch() ||
      session.expiresAt <= now ||
      session.lastUsedAt + OPERATOR_SESSION_IDLE_MS <= now ||
      !passkey ||
      passkey.revokedAt !== null ||
      passkey.origin !== this.deps.origin
    ) {
      // A wrong browser must not be able to destroy the legitimate browser's session.
      if (session.boundDeviceId === device.id)
        registry.removeSession(session.sessionId);
      return null;
    }
    if (touch) registry.touchSession(session.sessionId, now);
    return touch ? { ...session, lastUsedAt: now } : session;
  }

  signOut(secret: string, credential: string): boolean {
    const session = this.resolve(secret, credential);
    if (!session) return false;
    this.deps.registry.existing()!.removeSession(session.sessionId);
    this.deps.logger?.info('Operator signed out', {
      event: 'station.operator.sign_out',
      device: createHmac('sha256', this.deps.epoch())
        .update(session.boundDeviceId)
        .digest('base64url'),
    });
    return true;
  }

  passkeys() {
    return this.deps.registry.existing()?.listActive() ?? [];
  }
}

/** Duplicate cookies fail closed instead of selecting an attacker-controlled value. */
export function parseOperatorSessionCookie(
  header: string | undefined,
): string | undefined {
  const values = (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${OPERATOR_SESSION_COOKIE}=`));
  return values.length === 1
    ? values[0].slice(OPERATOR_SESSION_COOKIE.length + 1)
    : undefined;
}

export function isOperatorSessionRead(method: string, path: string): boolean {
  return (
    method === 'GET' &&
    [
      '/api/pairing/devices',
      '/api/operator/session',
      '/api/operator/passkeys',
    ].includes(path)
  );
}
export function isOperatorSessionLeaf(method: string, path: string): boolean {
  return (
    isOperatorSessionRead(method, path) ||
    (method === 'POST' &&
      /^\/api\/pairing\/devices\/[^/]+\/scope$/.test(path)) ||
    (method === 'DELETE' &&
      /^\/api\/pairing\/devices\/[^/]+(?:\/record)?$/.test(path))
  );
}
