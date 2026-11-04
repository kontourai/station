/**
 * #4521: the managed policy's capability switches, as every enforcement seam
 * reads them. `main()` installs the policy it loaded before anything a switch
 * governs is built; the OTel bootstrap, which runs before `main()`, reads the
 * same memoized load (`managed-policy-boot.ts`).
 *
 * Each switch only takes a capability away. A seam asks a predicate here and
 * refuses with {@link managedCapabilityDenial}, the one sentence clients show.
 */
import {
  MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
  type ManagedPolicyLimits,
  type ManagedPolicyRegistryLimits,
  type ManagedPolicySummary,
  managedPolicyDenial,
  managedRegistryLocationAllowed,
  managedTelemetryAllowed,
  managedWebhookAutomationsAllowed,
} from '@kontourai/station-contracts/managed-policy';
import type { LoadedManagedPolicy } from '@kontourai/station-shared/managed-policy';

let installed: ManagedPolicySummary | null = null;

/** Install the policy `main()` loaded (null: none). Tests reset with null. */
export function installManagedCapabilityLimits(
  policy: Pick<LoadedManagedPolicy, 'summary'> | null,
): void {
  installed = policy?.summary ?? null;
}

function limits(): ManagedPolicyLimits | undefined {
  return installed?.limits;
}

/** False when the policy sets `limits.telemetry: false`. */
export function telemetryAllowedByManagedPolicy(): boolean {
  return managedTelemetryAllowed(limits());
}

/** False when the policy sets `limits.webhookAutomations: false`. */
export function webhookAutomationsAllowedByManagedPolicy(): boolean {
  return managedWebhookAutomationsAllowed(limits());
}

/** The installed `limits.registries`, or undefined when it restricts nothing. */
export function managedRegistryLimits():
  | ManagedPolicyRegistryLimits
  | undefined {
  return limits()?.registries;
}

/** Whether `location` may supply plugins or skills under `limits.registries`. */
export function registryLocationAllowedByManagedPolicy(
  location: string | undefined,
  bundled = false,
): boolean {
  return managedRegistryLocationAllowed(
    managedRegistryLimits(),
    location,
    bundled,
  );
}

/** Whether registry plugin installs must carry a host-trusted signature. */
export function managedPolicyRequiresSignedPackages(): boolean {
  return managedRegistryLimits()?.unsignedPackages === false;
}

/**
 * "Acme's policy manages <subject>: it is turned off. For help, visit …".
 * `maxChars` bounds it for a length-limited field. Only meaningful
 * once a predicate here refused; without a policy it names no organization.
 */
export function managedCapabilityDenial(
  subject: string,
  maxChars?: number,
): string {
  if (!installed) return `A managed policy turns off ${subject}.`;
  const sentence = managedPolicyDenial(
    installed,
    `${subject}: it is turned off`,
  );
  // A support link may be 2048 characters; where a field is shorter, the
  // sentence names the organization and sends the user to their admin.
  return maxChars === undefined || sentence.length <= maxChars
    ? sentence
    : managedPolicyDenial(
        { ...installed, supportUrl: null },
        `${subject}: it is turned off`,
      );
}

/** The JSON body a route answers a managed refusal with (status 403). */
export function managedCapabilityRefusalBody(subject: string) {
  return {
    success: false as const,
    code: MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
    error: managedCapabilityDenial(subject),
    retryable: false as const,
  };
}
