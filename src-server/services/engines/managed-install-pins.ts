/**
 * The managed installs Station knows how to perform. Each is a reviewed pin:
 * changing a version or a digest is a code change.
 *
 * `kiro-kas`: Kiro's agent service (`@kiro/agent`) with the Node build it
 * runs on, for the "Kiro (KAS, no CLI)" engine. The manifest shape, file
 * naming and layout follow kirocrew `acp/kas_bundle.py`; the version and
 * digest are kirocrew `acp/kas_pin.py`'s. The digest was re-checked against
 * the published manifest on 2026-11-13 (one GET of manifest.json).
 */
import type {
  EngineInstallManifest,
  ManagedInstallArtifact,
  ManagedInstallPin,
  ManagedInstallPlatform,
  ManagedRuntimeBuild,
} from '@kontourai/station-contracts/managed-engine-install';
import { MANAGED_INSTALL_PLATFORMS } from '@kontourai/station-contracts/managed-engine-install';
import {
  type ManagedInstallDefinition,
  ManagedInstallError,
} from './managed-install.js';

export const KAS_INSTALL_ID = 'kiro-kas';
const KAS_PIN_VERSION = '0.66.104';
const KAS_PIN_MANIFEST_URL = `https://kas.crew.kiro.dev/kas/${KAS_PIN_VERSION}/manifest.json`;
export const KAS_PIN_MANIFEST_SHA256 =
  '263d3d1e59c2d32987d2a09cb066f650b6455cc9de94473693bd0a07aec151f4';

/** The engine's stdio ACP server inside the package (kas_bundle.py `_ACP_SERVER_REL`). */
const KAS_ACP_SERVER = 'dist/server/acp-server.js';

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
/** A bare object name beside the manifest: no separator, no traversal. */
const FILE_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;
/** An npm package name, scoped or not, without traversal. */
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export const KAS_PIN: ManagedInstallPin = Object.freeze({
  installId: KAS_INSTALL_ID,
  version: KAS_PIN_VERSION,
  manifestUrl: KAS_PIN_MANIFEST_URL,
  manifestSha256: KAS_PIN_MANIFEST_SHA256,
  // The engine matrix the pinned manifest publishes; a Mac uses the
  // universal engine build with its own architecture's Node.
  platforms: Object.freeze([
    'linux-x64',
    'linux-arm64',
    'darwin-universal',
    'win32-x64',
  ] as ManagedInstallPlatform[]),
});

function refuse(message: string): never {
  throw new ManagedInstallError('manifest-digest-mismatch', message);
}

function isPlatform(key: string): key is ManagedInstallPlatform {
  return (MANAGED_INSTALL_PLATFORMS as readonly string[]).includes(key);
}

function artifactOf(
  value: unknown,
  manifestUrl: string,
  what: string,
): ManagedInstallArtifact & { file: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    refuse(`manifest ${what}: expected an object`);
  const { file, sha256, size } = value as Record<string, unknown>;
  if (typeof file !== 'string' || !FILE_NAME.test(file))
    refuse(`manifest ${what}: 'file' must be a bare object name`);
  if (typeof sha256 !== 'string' || !SHA256.test(sha256.toLowerCase()))
    refuse(`manifest ${what}: 'sha256' must be 64 hex digits`);
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0)
    refuse(`manifest ${what}: 'size' must be a positive byte count`);
  return {
    file,
    url: new URL(file, manifestUrl).toString(),
    sha256: sha256.toLowerCase(),
    size,
  };
}

/**
 * Read the KAS bundle manifest (kas_bundle.py `parse_manifest`):
 *
 * ```json
 * { "version": "0.66.104", "package": "@kiro/agent",
 *   "platforms": { "<engine platform>": { "file", "sha256", "size" } },
 *   "node": { "version": "22.23.3",
 *             "builds": { "<os>-<arch>": { "file", "sha256", "size" } } } }
 * ```
 *
 * A `node` that is a string (`"electron-builtin"`) describes a build meant to
 * run inside Kiro's Electron; it becomes a runtime build named that, which
 * the installer refuses with `runtime-refused`.
 */
export function parseKasManifest(
  document: unknown,
  manifestUrl: string,
): EngineInstallManifest {
  if (!document || typeof document !== 'object' || Array.isArray(document))
    refuse('manifest: expected a JSON object');
  const data = document as Record<string, unknown>;
  const version = data.version;
  if (typeof version !== 'string' || !VERSION.test(version))
    refuse('manifest: bad version');
  const pkg = data.package ?? '@kiro/agent';
  if (typeof pkg !== 'string' || !PACKAGE.test(pkg))
    refuse('manifest: bad package');
  const platforms = data.platforms;
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms))
    refuse('manifest: platforms must be an object');
  const artifacts: Partial<
    Record<ManagedInstallPlatform, ManagedInstallArtifact>
  > = {};
  for (const [key, value] of Object.entries(platforms)) {
    // A platform this Station has no name for is skipped, not refused: the
    // manifest may publish builds for hosts Station does not run on.
    if (!isPlatform(key)) continue;
    const { url, sha256, size } = artifactOf(
      value,
      manifestUrl,
      `platforms[${key}]`,
    );
    artifacts[key] = { url, sha256, size };
  }
  const node = data.node;
  let runtimeBuilds: ManagedRuntimeBuild[];
  if (typeof node === 'string') {
    runtimeBuilds = [
      {
        runtime: node,
        version: node,
        platform: 'linux-x64',
        url: manifestUrl,
        sha256: '0'.repeat(64),
        size: 1,
      },
    ];
  } else {
    if (!node || typeof node !== 'object' || Array.isArray(node))
      refuse("manifest: 'node' must be an object with 'version' and 'builds'");
    const { version: nodeVersion, builds } = node as Record<string, unknown>;
    if (typeof nodeVersion !== 'string' || !VERSION.test(nodeVersion))
      refuse('manifest: bad node version');
    if (!builds || typeof builds !== 'object' || Array.isArray(builds))
      refuse('manifest: node.builds must be an object');
    runtimeBuilds = [];
    for (const [key, value] of Object.entries(builds)) {
      if (!isPlatform(key)) continue;
      const { url, sha256, size } = artifactOf(
        value,
        manifestUrl,
        `node.builds[${key}]`,
      );
      runtimeBuilds.push({
        runtime: 'node',
        version: nodeVersion,
        platform: key,
        url,
        sha256,
        size,
      });
    }
  }
  return {
    installId: KAS_INSTALL_ID,
    version,
    artifacts,
    entry: `node_modules/${pkg}/${KAS_ACP_SERVER}`,
    runtimeBuilds,
  };
}

export const KAS_INSTALL_DEFINITION: ManagedInstallDefinition = Object.freeze({
  pin: KAS_PIN,
  displayName: 'Kiro (KAS, no CLI)',
  parseManifest: parseKasManifest,
});

export const MANAGED_INSTALL_DEFINITIONS: readonly ManagedInstallDefinition[] =
  Object.freeze([KAS_INSTALL_DEFINITION]);
