import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const THIRD_PARTY_LICENSES_FILE = 'third-party-licenses.json';

interface ThirdPartyPackage {
  name: string;
  version: string;
  license: string;
  repository?: string;
  /** The package's own LICENSE/COPYING/NOTICE text, when it ships one. */
  text?: string;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/** `…/node_modules/@scope/name/lib/x.js` → `…/node_modules/@scope/name`. */
export function packageRootOf(moduleId: string): string | undefined {
  const id = moduleId.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  const marker = '/node_modules/';
  const at = id.lastIndexOf(marker);
  if (at < 0) return undefined;
  const rest = id.slice(at + marker.length).split('/');
  const segments = rest[0]?.startsWith('@') ? 2 : 1;
  if (rest.length <= segments || rest[0] === '.pnpm') return undefined;
  return id.slice(0, at + marker.length) + rest.slice(0, segments).join('/');
}

function licenseOf(manifest: Record<string, unknown>): string {
  const { license, licenses } = manifest;
  if (typeof license === 'string' && license.trim()) return license.trim();
  if (license && typeof license === 'object') {
    const type = (license as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((entry) => (entry as { type?: unknown })?.type)
      .filter((type): type is string => typeof type === 'string');
    if (types.length) return types.join(' OR ');
  }
  return 'UNKNOWN';
}

function repositoryOf(manifest: Record<string, unknown>): string | undefined {
  const { repository, homepage } = manifest;
  const raw =
    typeof repository === 'string'
      ? repository
      : typeof (repository as { url?: unknown })?.url === 'string'
        ? (repository as { url: string }).url
        : typeof homepage === 'string'
          ? homepage
          : undefined;
  if (!raw) return undefined;
  const url = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '');
  if (/^https?:\/\//.test(url)) return url;
  // npm shorthand `owner/repo` means GitHub.
  return /^[\w.-]+\/[\w.-]+$/.test(url)
    ? `https://github.com/${url}`
    : undefined;
}

function readThirdPartyPackage(root: string): ThirdPartyPackage | undefined {
  const manifestPath = path.join(root, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
    string,
    unknown
  >;
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string')
    return undefined;
  const texts = readdirSync(root)
    .filter((name) => LICENSE_FILE.test(name))
    .sort()
    .map((name) => readFileSync(path.join(root, name), 'utf8').trim())
    .filter(Boolean);
  const repository = repositoryOf(manifest);
  return {
    name: manifest.name,
    version: manifest.version,
    license: licenseOf(manifest),
    ...(repository ? { repository } : {}),
    ...(texts.length ? { text: texts.join('\n\n') } : {}),
  };
}

/** Every package whose code is in the bundle, de-duplicated by name@version. */
function collectThirdPartyPackages(
  moduleIds: Iterable<string>,
  read: (root: string) => ThirdPartyPackage | undefined = readThirdPartyPackage,
): ThirdPartyPackage[] {
  const roots = new Set<string>();
  for (const id of moduleIds) {
    const root = packageRootOf(id);
    if (root) roots.add(root);
  }
  const packages = new Map<string, ThirdPartyPackage>();
  for (const root of roots) {
    const entry = read(root);
    if (entry) packages.set(`${entry.name}@${entry.version}`, entry);
  }
  return [...packages.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/**
 * Emits the notices for the npm packages that actually ship in this UI build,
 * read from the bundle's own module graph, for Settings → About.
 */
export function thirdPartyLicenses(): Plugin {
  return {
    name: 'station-third-party-licenses',
    apply: 'build',
    generateBundle: {
      order: 'pre',
      handler(_options, bundle) {
        const moduleIds = Object.values(bundle).flatMap((output) =>
          output.type === 'chunk' ? output.moduleIds : [],
        );
        this.emitFile({
          type: 'asset',
          fileName: THIRD_PARTY_LICENSES_FILE,
          source: JSON.stringify({
            packages: collectThirdPartyPackages(moduleIds),
          }),
        });
      },
    },
  };
}
