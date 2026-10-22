/**
 * API keys a person gives Station for one engine connection (the descriptor's
 * `credentialEnvVars`, e.g. FACTORY_API_KEY). Values live only in the engine
 * credential store (`<home>/security/engine-credentials.json`, 0600, its own
 * document), never in `acp.json` or a descriptor's `launchEnv`, are never
 * logged and never served back: reads expose names only. They reach exactly
 * one place, the environment of that connection's own engine processes.
 */

import { ToolServerCredentialStore } from '../plugins/tool-server-credential-store.js';
import { registryAuthFor } from './acp-engine-descriptors.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Generous for any vendor key; refuses pasted files. */
const ENGINE_CREDENTIAL_VALUE_MAX = 8192;

/** One bucket per connection; the document holds nothing else. */
function bucket(connectionId: string): string {
  return `acp:${connectionId}`;
}

export class EngineCredentialRefusedError extends Error {}

/** C0 controls and DEL, except tab and line breaks: some engines take a JSON session. */
function hasDisallowedControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code <= 0x1f || code === 0x7f) && ![0x09, 0x0a, 0x0d].includes(code))
      return true;
  }
  return false;
}

export class EngineCredentials {
  readonly #homeDir: string;
  #opened: ToolServerCredentialStore | null = null;

  constructor(homeDir: string) {
    this.#homeDir = homeDir;
  }

  /** Opened on first use, so a home whose security folder is unsafe fails a sign-in, never startup. */
  get #store(): ToolServerCredentialStore {
    this.#opened ??= new ToolServerCredentialStore(this.#homeDir, 'engine');
    return this.#opened;
  }

  /** The configured names among `allowed`; never values. */
  configuredNames(connectionId: string, allowed: readonly string[]): string[] {
    const env = this.envFor(connectionId, allowed);
    return allowed.filter((name) => env[name] !== undefined);
  }

  /**
   * The values to add to this connection's engine environment. Only names in
   * `allowed` (the engine's descriptor list) are returned, so a value stored
   * under a name the descriptor later drops stops reaching the engine.
   */
  envFor(
    connectionId: string,
    allowed: readonly string[],
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of allowed) {
      try {
        // Only names the store holds; `get` throws for the rest.
        env[name] = this.#store.get(bucket(connectionId), name);
      } catch {
        // Missing (or an unreadable store): the engine launches without it.
      }
    }
    return env;
  }

  async set(
    connectionId: string,
    name: string,
    value: string,
    allowed: readonly string[],
  ): Promise<void> {
    if (!ENV_NAME.test(name) || !allowed.includes(name))
      throw new EngineCredentialRefusedError(
        'This engine does not take that credential.',
      );
    const trimmed = value.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > ENGINE_CREDENTIAL_VALUE_MAX ||
      hasDisallowedControl(trimmed)
    )
      throw new EngineCredentialRefusedError(
        'Enter the key as text, without control characters.',
      );
    await this.#store.upsert(bucket(connectionId), name, trimmed);
  }

  async remove(connectionId: string, name: string): Promise<void> {
    if (!ENV_NAME.test(name)) return;
    await this.#store.remove(bucket(connectionId), name);
  }

  /** Drops every value held for a connection (it was removed). */
  async removeConnection(connectionId: string): Promise<void> {
    await this.#store.removeServer(bucket(connectionId));
  }
}

let registered: EngineCredentials | null = null;

/** Bootstrap installs the instance's store; tests install their own. */
export function registerEngineCredentials(store: EngineCredentials | null) {
  registered = store;
}

export function engineCredentials(): EngineCredentials | null {
  return registered;
}

/**
 * The credential variables to add to one connection's engine processes:
 * names its built-in descriptor lists, values the person stored for this
 * connection. Undefined when there are none.
 */
export function engineCredentialEnvFor(connection: {
  id: string;
  command: string;
}): Record<string, string> | undefined {
  const store = registered;
  if (!store) return undefined;
  const names = registryAuthFor(connection)?.auth.credentialEnvVars ?? [];
  if (names.length === 0) return undefined;
  const env = store.envFor(connection.id, names);
  return Object.keys(env).length > 0 ? env : undefined;
}
