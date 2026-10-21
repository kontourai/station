import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { PublisherTelemetryDeclaration } from '@kontourai/station-contracts/plugin-telemetry';
import type { PackageMcpAdmissionJournal } from './package-mcp-admission.js';
import {
  listPluginCatalogIdentities,
  readPluginCatalogInstallationAsync,
} from './plugin-catalog-installation.js';
import { captureLocalPluginInstallation } from './plugin-installation-local.js';
import type { RegistryAcquisitionReceipt } from './registry-acquisition.js';
import { registryReceiptMatchesAppliedPolicy } from './registry-acquisition.js';
import type { RegistryTrustPolicyAuthority } from './registry-trust-policy.js';

export function assertPluginTelemetryAdmission(
  declaration: PublisherTelemetryDeclaration,
  receipt: RegistryAcquisitionReceipt | undefined | null,
  publicRegistries: unknown = [],
): void {
  if (
    !receipt?.signer ||
    receipt.registryId !== declaration.publisher ||
    !Array.isArray(publicRegistries) ||
    !publicRegistries.some(
      (key) =>
        typeof key === 'string' &&
        `sha256:${createHash('sha256').update(key).digest('hex')}` ===
          receipt.registryKeyDigest,
    )
  )
    throw new Error(
      'Plugin telemetry requires installation from an explicitly public registry with a verified signature and matching publisher identity. Private, unsigned and unverified declarations are rejected.',
    );
}
export interface PluginTelemetryCatalogOptions {
  homeDir: string;
  journal: PackageMcpAdmissionJournal;
  trustPolicy: RegistryTrustPolicyAuthority;
}
/** Each observation binds current immutable code, selected generation and applied trust. */
export async function pluginTelemetryBindings(
  options: PluginTelemetryCatalogOptions,
  config: AppConfig,
) {
  const pluginsDir = join(options.homeDir, 'plugins');
  const admission = await options.trustPolicy.captureAdmission();
  const result = [];
  for (const plugin of listPluginCatalogIdentities(
    pluginsDir,
    options.journal,
  )) {
    const captured = captureLocalPluginInstallation(
      pluginsDir,
      options.journal,
      plugin,
    );
    if (!captured?.installation || !captured.isCurrent()) continue;
    const trust = options.journal.registryAcquisition(captured.installation);
    if (
      trust.state !== 'observed' ||
      !trust.receipt ||
      !registryReceiptMatchesAppliedPolicy(trust.receipt, admission.decision)
    )
      continue;
    const installed = await readPluginCatalogInstallationAsync(
      pluginsDir,
      plugin,
      options.journal,
    );
    if (!installed?.manifest.telemetry || installed.readiness.state !== 'ready')
      continue;
    try {
      assertPluginTelemetryAdmission(
        installed.manifest.telemetry,
        trust.receipt,
        config.publicTelemetryRegistries,
      );
    } catch {
      continue;
    }
    await admission.assertCurrent();
    result.push({
      plugin,
      generation: captured.installation.incarnation,
      receipt: trust.receipt,
      isSelected: () => captured.isCurrent() && admission.isApplied(),
      declaration: installed.manifest.telemetry,
      async isCurrent() {
        try {
          await admission.assertCurrent();
          return (
            captured.isCurrent() &&
            (await installed.artifact.isCurrentAsync()) &&
            admission.isApplied()
          );
        } catch {
          return false;
        }
      },
    });
  }
  return result;
}
