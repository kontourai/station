/**
 * #3483: catalog-supplied remote MCP servers connect only to addresses
 * Station has checked. Every connection Station makes for one (its own MCP
 * client, the OAuth proxy external engines use, and token refreshes outside
 * a transport) takes its `fetch` from here. See
 * docs/design/mcp-subregistry-curation.md#coverage-and-gaps.
 */

import type { ToolDef } from '@kontourai/station-contracts/tool';
import { setRemoteTransportFetchPolicy } from '@kontourai/station-shared/mcp';
import {
  type AddressPinnedFetchOptions,
  createAddressPinnedFetch,
} from '@kontourai/station-shared/remote-address-guard';
import { isCatalogSuppliedIntegration } from './integration-origin.js';

/** Test seams: a stub resolver and address rule; the environment for the opt-in. */
export type CatalogAddressOptions = Omit<
  AddressPinnedFetchOptions,
  'allowPrivateAddresses'
> & { env?: NodeJS.ProcessEnv };

/** The operator's opt-in to local and private network addresses for catalog servers. */
export function allowPrivateCatalogAddresses(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ['on', '1', 'true', 'yes'].includes(
    env.STATION_MCP_SUBREGISTRY_ALLOW_PRIVATE_ADDRESSES?.trim().toLowerCase() ??
      '',
  );
}

/**
 * An address-pinned fetch when a catalog supplied this remote server, else
 * `undefined` (the platform fetch). One fetch is one connection: it resolves
 * each hostname once.
 */
export function catalogServerFetch(
  home: string,
  def: Pick<ToolDef, 'id' | 'transport' | 'endpoint'>,
  options: CatalogAddressOptions = {},
): typeof globalThis.fetch | undefined {
  if (def.transport !== 'sse' && def.transport !== 'streamable-http')
    return undefined;
  if (!isCatalogSuppliedIntegration(home, def.id)) return undefined;
  return createAddressPinnedFetch({
    allowPrivateAddresses: allowPrivateCatalogAddresses(options.env),
    resolve: options.resolve,
    isRefusedAddress: options.isRefusedAddress,
  });
}

/** Station's MCP client transports use `catalogServerFetch`. */
export function installCatalogServerAddressPolicy(
  home: () => string,
  options: CatalogAddressOptions = {},
): () => void {
  const previous = setRemoteTransportFetchPolicy((def) =>
    catalogServerFetch(home(), def, options),
  );
  return () => {
    setRemoteTransportFetchPolicy(previous);
  };
}
