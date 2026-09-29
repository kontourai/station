/**
 * Which plugin sources Station has staged without their git metadata
 * (#2719 follow-up).
 *
 * A folder an open install proposal names is copied with every `.git` entry
 * left out. Once that proposal resolves, nothing in the proposal store says
 * so any more (and resolved proposals are only retained up to a cap), so a
 * later reinstall of the same folder would read as the operator's own and
 * keep whatever `.git` the folder holds by then. This record is what keeps
 * it stripped: the install route writes the source's acquisition origin
 * here before it installs a source stripped, and preview and install strip
 * any source whose origin is recorded, whether or not a proposal still
 * names it.
 *
 * Keyed by `pluginAcquisitionOrigin` (owner + realpath of the source,
 * hashed), the identity the installer records on an installation, so
 * alternate spellings of one folder share a record and the file never holds
 * a host path. Legacy-format plugins have no installation record at all,
 * which is why this is its own file rather than a field on one.
 *
 * Entries are never removed: uninstalling the plugin does not make the
 * folder the operator's again. An operator who wants git updates installs
 * from the repository's remote URL, a different source.
 *
 * An unreadable record fails closed: preview and install refuse rather than
 * guess that a source was never staged stripped.
 */
import { join } from 'node:path';
import {
  acquireFileMutationLockAsync,
  type FileMutationLock,
} from '@kontourai/station-shared/lifecycle-events';
import { isRecord } from '../../utils/is-record.js';
import { JsonFileStore } from '../infra/json-store.js';
import { pluginAcquisitionOrigin } from './plugin-acquisition-origin.js';

export const PLUGIN_SOURCE_STAGING_FILE = 'plugin-source-staging.json';

interface PluginSourceStagingData {
  version: 1;
  /** Acquisition origins staged with every `.git` entry left out. */
  gitMetadataExcluded: string[];
}

const ORIGIN = /^[0-9a-f]{64}$/;

function validate(value: unknown): PluginSourceStagingData {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.gitMetadataExcluded) ||
    !value.gitMetadataExcluded.every(
      (origin) => typeof origin === 'string' && ORIGIN.test(origin),
    )
  )
    throw new Error('Invalid plugin source staging record');
  return {
    version: 1,
    gitMetadataExcluded: [...value.gitMetadataExcluded],
  };
}

class PluginSourceStagingUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `Plugin source staging is unreadable (${PLUGIN_SOURCE_STAGING_FILE} in the Station home), so Station cannot tell whether this source must be installed without its git metadata. Repair that file, then retry.`,
      { cause },
    );
    this.name = 'PluginSourceStagingUnavailableError';
  }
}

export class PluginSourceStaging {
  private readonly filePath: string;
  private readonly store: JsonFileStore<PluginSourceStagingData>;
  private readonly acquireMutationLock: FileMutationLock;

  constructor(
    private readonly projectHomeDir: string,
    options: { acquireMutationLock?: FileMutationLock } = {},
  ) {
    this.filePath = join(projectHomeDir, PLUGIN_SOURCE_STAGING_FILE);
    this.store = new JsonFileStore(
      this.filePath,
      { version: 1, gitMetadataExcluded: [] },
      { onCorruption: 'throw', durableAtomicWrite: true },
    );
    this.acquireMutationLock =
      options.acquireMutationLock ?? acquireFileMutationLockAsync;
  }

  private origin(source: string): string {
    return pluginAcquisitionOrigin({
      projectHomeDir: this.projectHomeDir,
      source,
    });
  }

  private read(): PluginSourceStagingData {
    try {
      return validate(this.store.read());
    } catch (error) {
      throw new PluginSourceStagingUnavailableError(error);
    }
  }

  /** Whether `source` was once installed without its git metadata. */
  excludesGitMetadata(source: string): boolean {
    return this.read().gitMetadataExcluded.includes(this.origin(source));
  }

  /** Records that `source` is installed without its git metadata, for good. */
  async recordGitMetadataExcluded(source: string): Promise<void> {
    const origin = this.origin(source);
    const release = await this.acquireMutationLock(`${this.filePath}.mutation`);
    try {
      const data = this.read();
      if (data.gitMetadataExcluded.includes(origin)) return;
      this.store.write(
        validate({
          version: 1,
          gitMetadataExcluded: [...data.gitMetadataExcluded, origin],
        }),
      );
    } finally {
      await release();
    }
  }
}
