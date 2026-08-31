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

/** Metadata only. A binding never persists a secret value. */
export interface SecretBinding {
  id: SecretBindingId;
  name: string;
  authRef: AuthRef;
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

export interface SecretBindingView extends Omit<SecretBinding, 'authRef'> {
  authRef: AuthRef;
  availability: SecretBindingAvailability;
}
