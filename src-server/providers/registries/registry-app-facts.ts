/**
 * Reads what a local plugin catalog entry is (#5479): its manifest and the
 * layout documents it names, turned into `RegistryAppFacts` by the contract's
 * derivation. Apps › Discover filters and describes entries by these facts.
 *
 * Only local packages are read. A remote package (a git or https source) is
 * never fetched while a catalog is listed, so its entry carries no facts.
 *
 * Every read is bounded and refuses a file over its bound instead of reading
 * part of it. A missing, unreadable, malformed or over-bound manifest or
 * layout leaves that entry without facts; it never fails the listing.
 *
 * Each listing re-reads the catalog index, so the facts are cached per
 * package and reused while the files they came from are unchanged: a listing
 * of an unchanged catalog costs an `lstat` and a `stat` per file read before.
 */
import { lstatSync, type Stats, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  deriveRegistryAppFacts,
  REGISTRY_APP_LIST_BOUND,
  type RegistryAppFacts,
} from '@kontourai/station-contracts/catalog';
import { PLUGIN_MANIFEST_MAX_BYTES } from '../../services/plugins/plugin-manifest-bounded-read.js';
import { parsePluginManifestDocumentWithFormat } from '../../services/plugins/plugin-manifest-loader.js';
import { errorMessage } from '../../utils/error-message.js';
import type { Logger } from '../../utils/logger.js';
import {
  canonicalPath,
  isCanonicalPathStrictlyWithin,
} from '../../utils/path-containment.js';
import { readBoundedFile, readConfinedFile } from './confined-local-read.js';

/** The bound the install-time layout read uses. */
const LAYOUT_MAX_BYTES = 256 * 1024;
/** Packages whose facts are remembered; the whole cache resets past it. */
const CACHE_BOUND = 512;

/** A local package, as the registry provider's source resolution proved it. */
interface LocalRegistryPackage {
  /** Symlink-free package directory inside the registry root. */
  physical: string;
  /** The package directory as the catalog spells it, below `folderRoot`. */
  location: string;
  /**
   * The folder of a source a person added. Its reads are confined below it
   * and refuse links (see `confined-local-read.ts`). Absent for Station's
   * bundled catalog and a configured manifest.
   */
  folderRoot?: string;
}

class AppFactsRefusal extends Error {}

function statSignature(stat: () => Stats): string {
  try {
    const info = stat();
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch {
    return 'missing';
  }
}

/**
 * The file as named and as read: a link inside the package is signed by
 * itself and by its target, so a change to either is a change.
 */
function fileSignature(path: string): string {
  return `${path}:${statSignature(() => lstatSync(path))}:${statSignature(() => statSync(path))}`;
}

export class RegistryAppFactsReader {
  private readonly cache = new Map<
    string,
    { files: string[]; signature: string; facts: RegistryAppFacts | undefined }
  >();

  constructor(private readonly logger?: Pick<Logger, 'warn'>) {}

  /** The entry's facts, or undefined when they cannot be read. */
  async read(
    entryId: string,
    pkg: LocalRegistryPackage,
  ): Promise<RegistryAppFacts | undefined> {
    const key = `${pkg.folderRoot ?? ''}\0${pkg.physical}`;
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.files.map(fileSignature).join('\n') === cached.signature
    )
      return cached.facts;

    const files: string[] = [];
    const signatures: string[] = [];
    // Signed before reading: a file that changes during or after the read no
    // longer matches, so the next listing reads it again.
    const readFile = async (relative: string, maxBytes: number) => {
      const path = resolve(pkg.physical, relative);
      files.push(path);
      signatures.push(fileSignature(path));
      return (await this.readPackageFile(pkg, relative, maxBytes)).toString(
        'utf8',
      );
    };
    let facts: RegistryAppFacts | undefined;
    try {
      const manifestPath = join(pkg.physical, 'plugin.json');
      const parsed = parsePluginManifestDocumentWithFormat(
        await readFile('plugin.json', PLUGIN_MANIFEST_MAX_BYTES),
        manifestPath,
      );
      if (parsed.stationExtension?.status === 'disabled')
        throw new AppFactsRefusal('its Station extension is disabled');
      const { manifest } = parsed;
      const layoutSources = [
        ...(manifest.layout ? [manifest.layout.source] : []),
        ...(manifest.layouts ?? []).map((layout) => layout.source),
      ];
      // The contract's bound, checked before any layout is read.
      if (layoutSources.length > REGISTRY_APP_LIST_BOUND)
        throw new AppFactsRefusal('it declares too many layouts');
      const layouts: unknown[] = [];
      for (const source of layoutSources)
        layouts.push(JSON.parse(await readFile(source, LAYOUT_MAX_BYTES)));
      const derived = deriveRegistryAppFacts({ manifest, layouts });
      if (!derived)
        throw new AppFactsRefusal(
          'a declaration is malformed or over its bound',
        );
      facts = derived;
    } catch (error) {
      this.logger?.warn('Registry entry listed without app facts', {
        entryId,
        error: errorMessage(error),
      });
      facts = undefined;
    }
    if (this.cache.size >= CACHE_BOUND) this.cache.clear();
    this.cache.set(key, {
      files,
      signature: signatures.join('\n'),
      facts,
    });
    return facts;
  }

  private async readPackageFile(
    pkg: LocalRegistryPackage,
    relative: string,
    maxBytes: number,
  ): Promise<Buffer> {
    const resolved = canonicalPath(resolve(pkg.physical, relative));
    if (!isCanonicalPathStrictlyWithin(canonicalPath(pkg.physical), resolved))
      throw new AppFactsRefusal('a file resolves outside its package');
    // A person's folder is walked below the root it was added as, which
    // refuses any link on the way (the root itself may be one).
    return pkg.folderRoot === undefined
      ? readBoundedFile(resolved, maxBytes)
      : readConfinedFile(
          pkg.folderRoot,
          resolve(pkg.location, relative),
          maxBytes,
        );
  }
}
