/**
 * Start-time migration to grandfathered install trust records (#2998).
 *
 * Every plugin installed before d1 is recorded at tier 2, the tier it runs at
 * today, with the digest of its selected installation now and the registry
 * signer its persisted receipt names (else unsigned). The enumeration is the
 * same one `GET /api/plugins` uses: the inventory scan plus the journal's
 * selected installations.
 */
import type { Logger } from '../../utils/logger.js';
import type { PackageMcpAdmissionJournal } from './package-mcp-admission.js';
import {
  listPluginCatalogIdentities,
  readPluginCatalogInstallationAsync,
} from './plugin-catalog-installation.js';
import {
  type GrandfatheredInstallation,
  migrateGrandfatheredPluginTrust,
} from './plugin-install-trust-store.js';
import { pluginsDirFor } from './plugin-permissions.js';

async function installationsBeforeD1(
  projectHomeDir: string,
  journal: PackageMcpAdmissionJournal | undefined,
): Promise<GrandfatheredInstallation[]> {
  const pluginsDir = pluginsDirFor(projectHomeDir);
  const installations: GrandfatheredInstallation[] = [];
  for (const pluginName of listPluginCatalogIdentities(pluginsDir, journal)) {
    let catalog: Awaited<ReturnType<typeof readPluginCatalogInstallationAsync>>;
    try {
      catalog = await readPluginCatalogInstallationAsync(
        pluginsDir,
        pluginName,
        journal,
      );
    } catch {
      catalog = null;
    }
    let signer: GrandfatheredInstallation['signer'] = null;
    if (catalog?.installation && journal) {
      const trust = journal.registryAcquisition(catalog.installation);
      // Never guess a signer: an unreadable receipt fails the whole
      // migration, which retries on the next start.
      if (trust.state === 'unavailable')
        throw new Error('Registry receipt unavailable during trust migration');
      if (trust.receipt?.signer)
        signer = {
          kind: 'ed25519',
          keyId: trust.receipt.signer.keyId,
          keyFingerprint: trust.receipt.signer.spkiFingerprint,
        };
    }
    installations.push({
      pluginName,
      contentDigest: catalog?.artifact.digest ?? null,
      signer,
    });
  }
  return installations;
}

/**
 * Runs the one-time migration. Never blocks start: records are not enforced
 * before d2, so a failure is logged and retried on the next start, and the
 * installer runs the same migration before its first decision.
 */
export async function migratePluginInstallTrustAtStartup(options: {
  projectHomeDir: string;
  packageMcpJournal?: PackageMcpAdmissionJournal;
  logger: Logger;
  now?: () => Date;
}): Promise<void> {
  try {
    await ensurePluginInstallTrustMigration(options);
  } catch (error) {
    options.logger.error(
      'Install trust migration failed; retrying next start',
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export async function ensurePluginInstallTrustMigration(options: {
  projectHomeDir: string;
  packageMcpJournal?: PackageMcpAdmissionJournal;
  logger?: Logger;
  now?: () => Date;
}): Promise<void> {
  await migrateGrandfatheredPluginTrust({
    projectHomeDir: options.projectHomeDir,
    installations: () =>
      installationsBeforeD1(options.projectHomeDir, options.packageMcpJournal),
    now: options.now ?? (() => new Date()),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
