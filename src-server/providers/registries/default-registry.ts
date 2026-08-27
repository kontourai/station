/**
 * The registry Station falls back to when no `registryUrl` is configured.
 *
 * Without this, a fresh install shows an empty Registry page: the manifest and
 * the provider both already existed, but `JsonManifestRegistryProvider` was only
 * constructed when `appConfig.registryUrl` was set, and nothing set it. So the
 * examples that exist to show people how Station works, and how to extend it,
 * were invisible unless someone found them in the repo and wired a URL by hand.
 *
 * The bundled manifest lists only dependency-free plugins, so installing one on
 * a first run never needs the network. The fuller catalog — including examples
 * that pull npm dependencies — stays at `examples/registry/manifest.json`, and
 * an operator can point `registryUrl` at it, at their own manifest, or at a
 * hosted URL.
 *
 * Resolution is relative to `process.cwd()`, which the CLI sets to the install
 * root; `src-server/domain/validator.ts` already reads `schemas/` the same way.
 * The file is optional by design — a checkout or image without it degrades to
 * today's behaviour (no registry) rather than failing to boot.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** Path of the bundled manifest, relative to the install root. */
export const DEFAULT_REGISTRY_MANIFEST_PATH = join(
  'examples',
  'registry',
  'default.json',
);

/**
 * Absolute path of the bundled default manifest, or `null` when it is not
 * present in this installation.
 */
export function resolveDefaultRegistryManifest(
  appRoot: string = process.cwd(),
): string | null {
  const candidate = resolve(appRoot, DEFAULT_REGISTRY_MANIFEST_PATH);
  return existsSync(candidate) ? candidate : null;
}

/**
 * The manifest source Station should use, given the configured value.
 *
 * A configured `registryUrl` always wins — including a relative path, which is
 * resolved against the install root so it behaves the same way the bundled
 * default does. Returns `null` when nothing is configured and no bundled
 * manifest is present, which callers treat as "register no registry provider".
 */
export function resolveRegistrySource(
  configuredUrl: string | undefined,
  appRoot: string = process.cwd(),
): { source: string; origin: 'configured' | 'bundled' } | null {
  const configured = configuredUrl?.trim();
  if (configured) {
    const isRemote = /^[a-z][a-z0-9+.-]*:\/\//i.test(configured);
    return {
      source:
        isRemote || isAbsolute(configured)
          ? configured
          : resolve(appRoot, configured),
      origin: 'configured',
    };
  }

  const bundled = resolveDefaultRegistryManifest(appRoot);
  return bundled ? { source: bundled, origin: 'bundled' } : null;
}
