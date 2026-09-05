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
