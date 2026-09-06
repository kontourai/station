/** Candidate configuration; only an applied configuration decision grants policy authority. */
export interface RegistryTrustConfiguration {
  profiles: Array<{
    registryKey: string;
    signatures: 'optional' | 'required';
    trustedEd25519Keys: Record<string, string>;
  }>;
}

/** Bounded durable identity: no PEM keys or package-provided policy values. */
export interface RegistryTrustPolicyIdentity {
  configured: boolean;
  fingerprint: string;
  profiles: Array<{
    registryKey: string;
    signatures: 'optional' | 'required';
    trustedKeys: Array<{ keyId: string; spkiFingerprint: string }>;
  }>;
}

export interface AppliedRegistryTrustPolicy {
  scope: string;
  epoch: string;
  identity: RegistryTrustPolicyIdentity;
}

/** Published Agent Plugins schema targeted by a registry source-tree claim. */
export const AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' as const;
export interface RegistryPackageSignature {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  readonly value: string;
}
/** Untrusted registry assertion until verified against a host-selected key. */
export interface RegistryPackageClaim {
  readonly packageSchema: typeof AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL;
  readonly registryId: string;
  readonly registryKey: string;
  readonly pluginName: string;
  readonly packageVersion: string;
  readonly source: string;
  readonly packageDigest: string;
  readonly signature?: RegistryPackageSignature;
}
