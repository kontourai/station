import type { ToolDef } from '@kontourai/station-contracts/tool';
import { toolServerOAuthResourceIdentity } from '../services/plugins/tool-server-oauth.js';

/**
 * Invariants for a remote integration's OAuth client, checked against the
 * on-disk definition under the integration's mutation lock. Every writer
 * (routes, the MCP service, registry installs and imports, secret-binding
 * bind/unbind) reaches `writeIntegrationConfigLocked`, so no path can skip
 * them (GHSA-6qxp-vccf-f47h).
 *
 * - A pre-registered client names the issuer it belongs to; the provider
 *   never uses it with another authorization server.
 * - A bound client secret pins the issuer and the endpoint, so the secret
 *   cannot be redirected to another token endpoint. Unbinding is the explicit
 *   step that releases them; dropping the reference is always allowed.
 * - A write never introduces a reference to a different binding, and no
 *   definition is created already bound: only the bind operation, which
 *   changes nothing else, adds one.
 */
export function assertIntegrationOAuthClientWritable(
  current: ToolDef | undefined,
  next: ToolDef,
): void {
  const client = next.oauthClient;
  if (client?.clientId && !client.issuer)
    throw new Error(
      "A pre-registered OAuth client needs its authorization server's issuer.",
    );
  const nextRef = client?.clientSecretRef;
  if (!nextRef) return;
  const currentRef = current?.oauthClient?.clientSecretRef;
  if (!current || (currentRef !== undefined && currentRef !== nextRef))
    throw new Error(
      'Secret bindings can be changed only through the operator binding API.',
    );
  if (!client?.issuer)
    throw new Error(
      "Declare the client's authorization server before binding its secret.",
    );
  if (current.oauthClient?.issuer !== client.issuer)
    throw new Error(
      "Unbind the OAuth client secret before changing the client's authorization server.",
    );
  if (
    toolServerOAuthResourceIdentity(current) !==
    toolServerOAuthResourceIdentity(next)
  )
    throw new Error(
      'Unbind the OAuth client secret before changing the integration endpoint.',
    );
}

/**
 * A definition from outside Station (a registry, catalog or import) never
 * authors a secret-binding reference; only the binding routes do.
 */
export function withoutBindingReferences(def: ToolDef): ToolDef {
  const { secretEnvRefs: _env, oauthClient, ...rest } = def;
  if (!oauthClient) return rest;
  const { clientSecretRef: _secret, ...client } = oauthClient;
  return Object.keys(client).length > 0
    ? { ...rest, oauthClient: client }
    : rest;
}
