import type { AuthRef } from './datum-secret-reference.js';

/** A Station-local, opaque identifier for one durable secret reference. */
export type SecretBindingId = string;

export interface McpIntegrationEnvGrant {
  kind: 'mcp-integration-env';
  integrationId: string;
  envName: string;
}

/** Exact authority for spending one binding as one ACP provider header. */
export interface ACPProviderHeaderGrant {
  kind: 'acp-provider-header';
  connectionId: string;
  providerId: string;
  headerName: string;
}

export type SecretBindingGrant =
  | McpIntegrationEnvGrant
  | ACPProviderHeaderGrant;

/**
 * Who a credential belongs to (#3279). `instance` is the shared Station
 * credential every record created before #3279 reads as. A `principal`
 * credential is usable only for turns that run as that principal; the
 * `principal-project` form narrows it further to one Project. `principalId`
 * is an existing human `PrincipalRef.id` (see `./principal.ts`) produced by
 * Station's principal resolution, never a new id, a device or Station
 * instance identity, or a display name.
 */
export type CredentialOwner =
  | { kind: 'instance' }
  | { kind: 'principal'; principalId: string }
  | { kind: 'principal-project'; principalId: string; projectSlug: string };

/** Metadata only. A binding never persists a secret value. */
export interface SecretBinding {
  id: SecretBindingId;
  name: string;
  authRef: AuthRef;
  /**
   * Absent means `instance`: bindings created before #3279 keep their shared
   * behavior. A principal-owned binding is listed and resolved only for its
   * owner, and is never materialized into a shared integration child.
   */
  owner?: CredentialOwner;
  revision: number;
  grants: McpIntegrationEnvGrant[];
  /** Exact ACP header authorities; absent on bindings created before #944. */
  acpProviderHeaderGrants?: ACPProviderHeaderGrant[];
  createdAt: string;
  updatedAt: string;
  /** Terminal: revoked bindings cannot be reactivated or re-used. */
  revokedAt?: string;
}

export interface SecretBindingDocument {
  schemaVersion: 1;
  bindings: Record<SecretBindingId, SecretBinding>;
}

export interface SecretBindingAvailability {
  backend: 'env' | 'keychain' | 'op';
  available: boolean;
}

export interface SecretBindingView
  extends Omit<SecretBinding, 'authRef' | 'owner'> {
  authRef: AuthRef;
  /**
   * Stations with #3279 always fill this; legacy records read as `instance`.
   * Absent from an older Station's view, which also means `instance`.
   */
  owner?: CredentialOwner;
  availability: SecretBindingAvailability;
}
