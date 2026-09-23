/**
 * An installation's acquisition origin: which owner acquired it from where.
 *
 * Acquisition-owner scoped continuity, not a signature or publisher claim.
 * `PluginInstallationService.install` refuses a replacement whose origin
 * differs from the selected installation's, so a data scope bound to one
 * source is never inherited by code from another.
 *
 * The source is canonicalized with the native realpath when it exists, so
 * alternate local spellings of one folder share an identity. The result is
 * a hash: the installation record never holds the path itself.
 *
 * #2323 S4 recomputes this for each Project folder to find the installed
 * plugin that folder is the source of. Both callers use this one function,
 * so the match cannot drift from what the installer recorded.
 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';

export function pluginAcquisitionOrigin(input: {
  projectHomeDir: string;
  source: string;
  registryId?: string;
  registryKey?: string;
}): string {
  const source = existsSync(input.source)
    ? realpathSync.native(input.source)
    : input.source;
  return createHash('sha256')
    .update(
      JSON.stringify({
        owner: realpathSync.native(input.projectHomeDir),
        registryId: input.registryId ?? null,
        registryKey: input.registryKey ?? null,
        source,
      }),
    )
    .digest('hex');
}
