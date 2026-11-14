/**
 * Remote task engine credentials live only in Station's engine host-auth
 * vault (docs/decisions/engine-credential-provider.md), one bucket per
 * connection: `engine-secret:<connectionId>:default`, key
 * {@link REMOTE_TASK_CREDENTIAL_KEY}. Connection ids carry the
 * `remote-task-` prefix, so no ACP connection (whose engine-held secrets share
 * the family) can name one of these buckets.
 *
 * Nothing here returns a credential to a route. {@link withCredential} hands
 * the value to the service's request builder for one call, and a route can
 * only learn whether one is set.
 */
import { ENGINE_CREDENTIAL_DEFAULT_PROFILE } from '@kontourai/station-contracts/engine-credential-provider';
import type { EngineHostAuthVault } from '../engine-host-auth/vault.js';

export const REMOTE_TASK_CREDENTIAL_KEY = 'remote-task.api-token';
/** Longer than any vendor token Station knows; refuses pasted documents. */
const CREDENTIAL_MAX_CHARS = 4096;

export const REMOTE_TASK_CONNECTION_ID = /^remote-task-[a-z0-9]{12,32}$/;

function scope(connectionId: string) {
  if (!REMOTE_TASK_CONNECTION_ID.test(connectionId))
    throw new Error('Not a remote task connection id.');
  return {
    connectionId,
    credentialProfileRef: ENGINE_CREDENTIAL_DEFAULT_PROFILE,
  };
}

/** A problem with a credential a person entered; null when acceptable. */
export function remoteTaskCredentialProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'The token must be text.';
  const trimmed = value.trim();
  if (!trimmed) return 'The token is empty.';
  if (trimmed.length > CREDENTIAL_MAX_CHARS) return 'The token is too long.';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the check itself.
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed))
    return 'The token must not contain spaces or control characters.';
  return null;
}

export class RemoteTaskCredentials {
  readonly #resolveVault: () => EngineHostAuthVault | null;

  /**
   * `resolveVault` answers the engine host-auth service's own vault, read at
   * each call; null (not composed yet) reads as no credential.
   */
  constructor(resolveVault: () => EngineHostAuthVault | null) {
    this.#resolveVault = resolveVault;
  }

  get #vault(): EngineHostAuthVault {
    const vault = this.#resolveVault();
    if (!vault)
      throw new Error('The engine credential vault is not available.');
    return vault;
  }

  has(connectionId: string): boolean {
    const vault = this.#resolveVault();
    return (
      !!vault &&
      vault.readSecret(scope(connectionId), REMOTE_TASK_CREDENTIAL_KEY) !==
        undefined
    );
  }

  async set(connectionId: string, value: string): Promise<void> {
    const problem = remoteTaskCredentialProblem(value);
    if (problem) throw new Error(problem);
    await this.#vault.writeSecret(
      scope(connectionId),
      REMOTE_TASK_CREDENTIAL_KEY,
      value.trim(),
    );
  }

  async clear(connectionId: string): Promise<void> {
    await this.#vault.removeSecret(
      scope(connectionId),
      REMOTE_TASK_CREDENTIAL_KEY,
    );
  }

  /** Every secret held for the connection, for a connection being removed. */
  async removeConnection(connectionId: string): Promise<void> {
    scope(connectionId);
    await this.#vault.removeConnection(connectionId);
  }

  /**
   * Runs `work` with the connection's own credential, or returns undefined
   * when none is set. The value never outlives the call.
   */
  async withCredential<T>(
    connectionId: string,
    work: (credential: string) => Promise<T>,
  ): Promise<{ value: T } | undefined> {
    const credential = this.#resolveVault()?.readSecret(
      scope(connectionId),
      REMOTE_TASK_CREDENTIAL_KEY,
    );
    if (credential === undefined) return undefined;
    return { value: await work(credential) };
  }
}
