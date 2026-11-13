/**
 * The store behind a reviewed engine-secret binding (`_kiro/secret/*`), for
 * one engine process and one connection and credential profile.
 *
 * - Keys must match the binding's pattern; values are capped at its
 *   `maxValueChars`. The responder already refuses both, and the store
 *   refuses them again so no other caller can bypass the policy.
 * - Only the binding's `persistedKinds` reach the vault
 *   (`engine-secret:<connectionId>:<profile>`); the rest (an OAuth verifier,
 *   a discovery document) stay in this object's memory and die with it,
 *   as the engine's own in-memory store would.
 * - A delete removes only the revision this process last read or wrote, so
 *   a process clearing a grant it found stale cannot erase a fresh one a
 *   sibling process stored since (kirocrew `acp/kas_secret_storage.py`). A
 *   key this process never touched is deleted outright.
 * - Requests for one key are serialized; values never reach a log or an
 *   error message.
 */
import type { EngineCredentialScope } from '@kontourai/station-contracts/engine-credential-provider';
import { ENGINE_CREDENTIAL_DEFAULT_PROFILE } from '@kontourai/station-contracts/engine-credential-provider';
import {
  type EngineSecretStorageBinding,
  isPersistedEngineSecretKey,
} from '@kontourai/station-contracts/engine-secret-storage';
import type { EngineSecretStore } from '../acp/acp-inbound-extension-policy.js';
import type { EngineHostAuthVault } from './vault.js';

class EngineSecretRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineSecretRefusedError';
  }
}

/** `null`: this process read the key and found nothing, or deleted it. */
type Seen = string | null;

export class VaultEngineSecretStore implements EngineSecretStore {
  readonly scope: EngineCredentialScope;
  readonly #memory = new Map<string, string>();
  readonly #seen = new Map<string, Seen>();
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(
    scope: EngineCredentialScope,
    private readonly binding: EngineSecretStorageBinding,
    private readonly vault: EngineHostAuthVault,
  ) {
    this.scope = {
      connectionId: scope.connectionId,
      credentialProfileRef:
        scope.credentialProfileRef || ENGINE_CREDENTIAL_DEFAULT_PROFILE,
    };
  }

  #check(key: string): boolean {
    if (typeof key !== 'string' || !this.binding.keyPattern.test(key))
      throw new EngineSecretRefusedError('Key outside the allowed namespace');
    return isPersistedEngineSecretKey(this.binding, key);
  }

  #serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.#locks.set(key, settled);
    void settled.then(() => {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    });
    return next;
  }

  get(key: string): Promise<string | undefined> {
    const persisted = this.#check(key);
    if (!persisted) return Promise.resolve(this.#memory.get(key));
    return this.#serial(key, async () => {
      const value = this.vault.readSecret(this.scope, key);
      this.#seen.set(key, value ?? null);
      return value;
    });
  }

  store(key: string, value: string): Promise<void> {
    const persisted = this.#check(key);
    if (typeof value !== 'string' || value.length > this.binding.maxValueChars)
      throw new EngineSecretRefusedError('Value exceeds the size limit');
    if (!persisted) {
      this.#memory.set(key, value);
      return Promise.resolve();
    }
    if (value.length === 0)
      // The vault keeps no empty values; an empty store is a delete of what
      // this process holds.
      return this.delete(key);
    return this.#serial(key, async () => {
      await this.vault.writeSecret(this.scope, key, value);
      this.#seen.set(key, value);
    });
  }

  delete(key: string): Promise<void> {
    const persisted = this.#check(key);
    this.#memory.delete(key);
    if (!persisted) return Promise.resolve();
    return this.#serial(key, async () => {
      if (!this.#seen.has(key)) {
        await this.vault.removeSecret(this.scope, key);
      } else {
        const revision = this.#seen.get(key);
        if (revision !== null && revision !== undefined)
          await this.vault.removeSecretIf(this.scope, key, revision);
      }
      // Holding no copy now, a repeat delete is a no-op until the next read
      // or write.
      this.#seen.set(key, null);
    });
  }
}
