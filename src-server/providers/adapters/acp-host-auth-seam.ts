/**
 * The adapter's one call into engine host-auth: install the reviewed
 * credential and secret responders a session's process may be answered
 * through, before its `initialize` (the engine asks for a token before
 * `initialize` returns).
 *
 * MERGE SEAM. The engine host-auth lane provides
 * `installEngineHostAuthResponders` in
 * `src-server/services/engine-host-auth/index.ts`. Until that lane is merged
 * this typed stub installs nothing, so every credential-shaped request is
 * refused as before. At merge, replace the stub body with:
 *
 *   export { installEngineHostAuthResponders } from
 *     '../../services/engine-host-auth/index.js';
 *
 * and keep {@link acpLaunchIsBuiltinDescriptor} unless that lane supplies
 * its own reading of the launch.
 */
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { listValidatedACPRegistryEntries } from '../../services/acp/acp-engine-descriptors.js';
import type { AcpInboundExtensionRegistry } from '../../services/acp/acp-inbound-extension-policy.js';

export interface EngineHostAuthLaunch {
  readonly connection: ACPConnectionConfig;
  /** The arguments the process is launched with. */
  readonly argv: readonly string[];
  /** Launched from a built-in descriptor, not a user, custom or plugin command. */
  readonly builtinDescriptor: boolean;
}

/** Typed no-op until the host-auth lane is merged (see the module header). */
export function installEngineHostAuthResponders(
  _registry: AcpInboundExtensionRegistry,
  _launch: EngineHostAuthLaunch,
): void {}

function sameArgs(a: readonly string[] | undefined, b: readonly string[]) {
  const left = a ?? [];
  return (
    left.length === b.length && left.every((arg, index) => arg === b[index])
  );
}

/**
 * Whether this connection runs exactly a built-in descriptor: a built-in
 * registry entry with the connection's id, command and arguments. A
 * user-edited command, a custom connection and a plugin descriptor are not.
 */
export function acpLaunchIsBuiltinDescriptor(
  connection: Pick<ACPConnectionConfig, 'id' | 'command' | 'args'>,
): boolean {
  return listValidatedACPRegistryEntries({ detect: false }).some(
    ({ entry, builtin }) =>
      builtin &&
      entry.id === connection.id &&
      entry.command === connection.command &&
      sameArgs(connection.args, entry.args ?? []),
  );
}
