/**
 * Start-time migration to grandfathered install trust records (#2998).
 *
 * Every plugin installed before d1 is recorded at tier 2, the tier it runs at
 * today, with the digest of its selected installation now and the registry
 * signer its persisted receipt names (else unsigned). The candidate set is
 * the same enumeration `GET /api/plugins` uses (the inventory scan plus the
 * journal's selected installations), frozen at the first attempt.
 */
import type { Logger } from '../../utils/logger.js';
import type { PackageMcpAdmissionJournal } from './package-mcp-admission.js';
import {
  classifyPluginForTrustMigration,
  listPluginCatalogIdentities,
} from './plugin-catalog-installation.js';
import {
  migrateGrandfatheredPluginTrust,
  type PluginTrustMigrationClassificationResult,
  pluginTrustMigrationWitness,
} from './plugin-install-trust-store.js';
import { pluginsDirFor } from './plugin-permissions.js';

async function classify(
  projectHomeDir: string,
  journal: PackageMcpAdmissionJournal | undefined,
  pluginName: string,
): Promise<PluginTrustMigrationClassificationResult> {
  const found = await classifyPluginForTrustMigration(
    pluginsDirFor(projectHomeDir),
    pluginName,
    journal,
  );
  if (found.kind !== 'installed') return found;
  if (!found.installation || !journal)
    return { kind: 'installed', contentDigest: found.digest, signer: null };
  const trust = journal.registryAcquisition(found.installation);
  // Never guess a signer: an unreadable receipt is retried next start.
  if (trust.state === 'unavailable')
    return { kind: 'transient', digest: found.digest };
  return {
    kind: 'installed',
    contentDigest: found.digest,
    signer: trust.receipt?.signer
      ? {
          kind: 'ed25519',
          keyId: trust.receipt.signer.keyId,
          keyFingerprint: trust.receipt.signer.spkiFingerprint,
        }
      : null,
  };
}

/**
 * Runs one migration attempt. Never blocks start: records are not enforced
 * before d2, so a failure is logged and retried on the next start, and the
 * installer runs the same migration before its first effect.
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
  const journal = options.packageMcpJournal;
  const witness = pluginTrustMigrationWitness(journal);
  await migrateGrandfatheredPluginTrust({
    projectHomeDir: options.projectHomeDir,
    ...(witness ? { witness } : {}),
    candidates: async () =>
      listPluginCatalogIdentities(
        pluginsDirFor(options.projectHomeDir),
        journal,
      ),
    classify: (pluginName) =>
      classify(options.projectHomeDir, journal, pluginName),
    now: options.now ?? (() => new Date()),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
