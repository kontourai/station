/**
 * Install the reviewed engine-credential and engine-secret responders on one
 * engine process's inbound-extension registry, when its launch qualifies
 * (docs/decisions/engine-credential-provider.md).
 *
 * Called by every client that builds a registry for an engine process: the
 * ACP adapter's session client and the availability probe. Both build their
 * own registry and share it with nobody.
 *
 * A launch qualifies for a credential binding only when it is a built-in
 * descriptor launch whose argv carries the binding's delegation arguments.
 * Those facts are derived from the connection and the validated built-in
 * table by the function bootstrap gives the service
 * (`acp-engine-descriptors.ts` `engineLaunchFactsFor`; injected rather than
 * imported, because the descriptor registry's import graph reaches Station's
 * own principals). A caller can only narrow them (`builtinDescriptor:
 * false`), never assert them. The registry then checks the binding's
 * identity and the facts again.
 *
 * Secret responders are installed only beside a credential responder: the
 * engine-held secret store is for engines Station signs in itself.
 */
import {
  argvDelegatesTo,
  ENGINE_CREDENTIAL_DEFAULT_PROFILE,
} from '@kontourai/station-contracts/engine-credential-provider';
import {
  type AcpInboundExtensionRegistry,
  REVIEWED_ENGINE_CREDENTIAL_BINDINGS,
  REVIEWED_ENGINE_SECRET_BINDINGS,
} from '../acp/acp-inbound-extension-policy.js';
import { engineHostAuth } from './service.js';

export interface EngineHostAuthResponderLaunch {
  /** The connection the process runs. Its id is the credential scope. */
  readonly connection: {
    readonly id: string;
    readonly command: string;
    readonly args?: readonly string[];
    /**
     * Absent or `default`. Station keeps one sign-in per connection, under
     * the default profile (sign-in routes, status, probe and sessions alike);
     * any other profile installs nothing. A session start asking for one is
     * refused before launch by the ACP adapter.
     */
    readonly credentialProfileRef?: string;
  };
  /** Accepted for the caller's record; the derived argv is the one checked. */
  readonly argv?: readonly string[];
  /** `false` withholds every responder. `true` is never taken on trust. */
  readonly builtinDescriptor?: boolean;
}

export interface EngineHostAuthResponderInstall {
  /** Wire methods now answered by a reviewed credential responder. */
  readonly credentialMethods: readonly string[];
  /** Wire methods now answered by a reviewed secret responder. */
  readonly secretMethods: readonly string[];
}

const NONE: EngineHostAuthResponderInstall = Object.freeze({
  credentialMethods: Object.freeze([]),
  secretMethods: Object.freeze([]),
});

/**
 * Register the Kiro `_kiro/auth/getAccessToken` responder and the
 * `_kiro/secret/*` responders on `registry` when the launch qualifies.
 * Returns what it installed; installs nothing (and never throws) otherwise.
 */
export function installEngineHostAuthResponders(
  registry: AcpInboundExtensionRegistry,
  launch: EngineHostAuthResponderLaunch,
): EngineHostAuthResponderInstall {
  const service = engineHostAuth();
  if (!service || launch.builtinDescriptor === false) return NONE;
  let facts: { builtinDescriptor: boolean; argv: readonly string[] };
  try {
    facts = service.launchFactsFor(launch.connection);
  } catch {
    return NONE;
  }
  if (!facts.builtinDescriptor) return NONE;
  const profile = launch.connection.credentialProfileRef;
  if (profile && profile !== ENGINE_CREDENTIAL_DEFAULT_PROFILE) return NONE;
  const scope = {
    connectionId: launch.connection.id,
    credentialProfileRef: ENGINE_CREDENTIAL_DEFAULT_PROFILE,
  };
  const credentialMethods: string[] = [];
  for (const binding of REVIEWED_ENGINE_CREDENTIAL_BINDINGS) {
    if (binding.wire.protocol !== 'acp') continue;
    if (!argvDelegatesTo(facts.argv, binding.delegationArgv)) continue;
    try {
      registry.registerCredentialResponder(
        binding,
        service.issuerFor(scope),
        facts,
      );
      credentialMethods.push(binding.wire.method);
    } catch {
      // A scope the vault cannot key (an id with ":"), or a refusal by the
      // registry's own checks: the method stays unanswered (-32601).
    }
  }
  if (credentialMethods.length === 0) return NONE;
  const secretMethods: string[] = [];
  for (const binding of REVIEWED_ENGINE_SECRET_BINDINGS) {
    try {
      registry.registerSecretResponder(
        binding,
        service.secretStoreFor(scope, binding),
      );
      secretMethods.push(...Object.values(binding.methods));
    } catch {}
  }
  return { credentialMethods, secretMethods };
}
