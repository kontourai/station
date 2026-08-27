import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseVariants } from '../lib/release-artifacts.mjs';
import { generateReleaseSboms } from '../lib/release-sbom-generation.mjs';
import {
  canonicalJson,
  SBOM_ASSETS,
  validateSbomBytes,
} from '../lib/release-sboms.mjs';
import { platformDigests } from '../release-container-platform-digests.mjs';
import {
  containerSourceToFragment,
  createContainerScannerSource,
} from '../release-container-sbom-source.mjs';
import { releaseDependencyLifecycle } from '../release-sbom-context.mjs';
import { cyclonedxComponents } from '../release-sbom-fragments.mjs';
import { validateReleaseSbomPredicates } from '../release-sbom-predicates.mjs';

const roots: string[] = [];
const root = resolve(import.meta.dirname, '../..');
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function subjects(tag: string) {
  const byScope = Object.fromEntries(
    ['portable', 'desktop', 'mobile'].map((scope) => [scope, []]),
  ) as Record<string, any[]>;
  for (const variant of releaseVariants(tag) as any[]) {
    const scope =
      variant.id === 'portable-server'
        ? 'portable'
        : ['macos', 'windows', 'linux'].includes(variant.platform)
          ? 'desktop'
          : 'mobile';
    for (const name of variant.files)
      byScope[scope].push({ name, variant: variant.id, sha256: hash(name) });
  }
  return byScope;
}

function writeFragment(
  path: string,
  source: string,
  predicate: string,
  components: any[],
) {
  writeFileSync(path, canonicalJson({ components, predicate, source }));
}

function fixture({
  tag = 'v1.2.3',
  components = [
    { name: 'npm-dep', version: '1.0.0', purl: 'pkg:npm/npm-dep@1.0.0' },
  ],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'station-sbom-generation-'));
  roots.push(root);
  const assetsDir = join(root, 'assets');
  const fragmentsDir = join(root, 'fragments');
  mkdirSync(assetsDir);
  mkdirSync(fragmentsDir);
  const lifecyclePurls = components.map((component) => component.purl).sort();
  const context = {
    tag,
    version: tag.slice(1),
    sourceSha: 'a'.repeat(40),
    generatedAt: '2026-08-24T00:00:00.000Z',
    channel: tag.includes('-preview.') ? 'preview' : 'stable',
    dependencyLifecycle: {
      digest: 'd'.repeat(64),
      purlsByScope: {
        portable: lifecyclePurls,
        desktop: lifecyclePurls,
        mobile: lifecyclePurls,
        container: lifecyclePurls,
      },
    },
    container: {
      image: 'ghcr.io/kontourai/station',
      digest: `sha256:${'b'.repeat(64)}`,
      platforms: ['linux/amd64', 'linux/arm64'],
    },
    subjectsByScope: subjects(tag),
  };
  const fragments = {
    npm: join(fragmentsDir, 'npm.fragment.json'),
    rust: join(fragmentsDir, 'rust.fragment.json'),
    container: join(fragmentsDir, 'container.fragment.json'),
  };
  writeFragment(fragments.npm, 'npm', 'runtime', components);
  writeFragment(fragments.rust, 'rust', 'native', [
    { name: 'rust-dep', version: '2.0.0', purl: 'pkg:cargo/rust-dep@2.0.0' },
  ]);
  writeFragment(fragments.container, 'container', 'image', [
    { name: 'image-dep', version: '3.0.0', purl: 'pkg:oci/image-dep@3.0.0' },
    ...components,
  ]);
  return { root, assetsDir, fragmentsDir, context, fragments };
}

function generatedAssets(assetsDir: string) {
  return Object.values(SBOM_ASSETS).filter((asset) =>
    existsSync(join(assetsDir, asset)),
  );
}

function scannerDescriptor(context: any) {
  return {
    createdAt: context.generatedAt,
    digest: context.container.digest,
    image: context.container.image,
    platforms: context.container.platforms,
    sha: context.sourceSha,
    tag: context.tag,
    tags: [context.tag, context.version, `sha-${context.sourceSha}`],
  };
}

function scannerInventory(components: any[] = []) {
  return {
    bomFormat: 'CycloneDX',
    components,
    metadata: { component: { name: 'station', type: 'container' } },
    serialNumber: 'urn:uuid:fbad8d4b-1633-429a-8a45-7b39f25ed442',
    specVersion: '1.6',
    version: 1,
  };
}

function scannerSource(value: any, components?: any[]) {
  const inventory = scannerInventory(
    components ?? [
      {
        hashes: [{ alg: 'SHA-256', content: 'd'.repeat(64) }],
        licenses: [{ license: { id: 'MIT' } }],
        name: 'bash',
        purl: 'pkg:deb/debian/bash@5.2.15-2+b2?arch=amd64',
        type: 'library',
        version: '5.2.15-2+b2',
      },
      {
        name: 'npm-dep',
        purl: 'pkg:npm/npm-dep@1.0.0',
        type: 'library',
        version: '1.0.0',
      },
    ],
  );
  return createContainerScannerSource({
    descriptor: scannerDescriptor(value.context),
    inputs: [
      {
        platform: 'linux/amd64',
        digest: `sha256:${'c'.repeat(64)}`,
        input: inventory,
      },
      {
        platform: 'linux/arm64',
        digest: `sha256:${'d'.repeat(64)}`,
        input: inventory,
      },
    ],
    sourceSha: value.context.sourceSha,
  });
}

afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

describe('release SBOM generation', () => {
  it('derives runtime and container lifecycle applicability from their independent root-lock installs', () => {
    const production = {
      name: 'production-native',
      version: '1.0.0',
      purl: 'pkg:npm/production-native@1.0.0',
    };
    const root = {
      packages: {
        '': {
          dependencies: {
            'darwin-native': '3.0.0',
            'production-native': '1.0.0',
            'x64-native': '4.0.0',
          },
          devDependencies: { 'dev-only-native': '2.0.0' },
        },
        'node_modules/production-native': { version: '1.0.0' },
        'node_modules/dev-only-native': { dev: true, version: '2.0.0' },
        'node_modules/darwin-native': {
          os: ['darwin'],
          optional: true,
          version: '3.0.0',
        },
        'node_modules/x64-native': { cpu: ['x64'], version: '4.0.0' },
      },
    };
    const lifecycle = releaseDependencyLifecycle({
      allowlist: {
        entries: [
          {
            path: 'node_modules/production-native',
            purl: production.purl,
            scope: 'root',
          },
          {
            path: 'node_modules/dev-only-native',
            purl: 'pkg:npm/dev-only-native@2.0.0',
            scope: 'root',
          },
          {
            path: 'node_modules/darwin-native',
            purl: 'pkg:npm/darwin-native@3.0.0',
            scope: 'root',
          },
          {
            path: 'node_modules/x64-native',
            purl: 'pkg:npm/x64-native@4.0.0',
            scope: 'root',
          },
          {
            path: 'node_modules/sdk-native',
            purl: 'pkg:npm/sdk-native@4.0.0',
            scope: 'sdk',
          },
          {
            path: 'node_modules/shared-native',
            purl: 'pkg:npm/shared-native@5.0.0',
            scope: 'shared',
          },
        ],
      },
      rootLock: root,
    });
    expect(lifecycle.purlsByScope).toEqual({
      portable: [production.purl, 'pkg:npm/x64-native@4.0.0'],
      desktop: [production.purl, 'pkg:npm/x64-native@4.0.0'],
      mobile: [production.purl, 'pkg:npm/x64-native@4.0.0'],
      // The container copies root node_modules after the normal (unpruned)
      // install, so its own inventory must retain its dev lifecycle package.
      container: [
        'pkg:npm/dev-only-native@2.0.0',
        production.purl,
        'pkg:npm/x64-native@4.0.0',
      ],
    });
  });

  it('rejects an all-dev lifecycle policy rather than binding empty SBOM metadata', () => {
    expect(() =>
      releaseDependencyLifecycle({
        allowlist: {
          entries: [
            {
              path: 'node_modules/dev-only-native',
              purl: 'pkg:npm/dev-only-native@2.0.0',
              scope: 'root',
            },
          ],
        },
        rootLock: {
          packages: {
            '': {},
            'node_modules/dev-only-native': { dev: true, version: '2.0.0' },
          },
        },
      }),
    ).toThrow(/no applicable production packages/);
  });

  it('binds current root production and unpruned multi-arch container inventories exactly', () => {
    const lifecycle = releaseDependencyLifecycle({
      allowlist: JSON.parse(
        readFileSync(
          resolve(root, 'config/dependency-lifecycle-allowlist.json'),
          'utf8',
        ),
      ),
      rootLock: JSON.parse(
        readFileSync(resolve(root, 'package-lock.json'), 'utf8'),
      ),
    });
    expect(lifecycle.purlsByScope).toEqual({
      portable: [
        'pkg:npm/esbuild@0.28.1',
        'pkg:npm/node-pty@1.1.0',
        'pkg:npm/protobufjs@7.6.5',
      ],
      desktop: [
        'pkg:npm/esbuild@0.28.1',
        'pkg:npm/node-pty@1.1.0',
        'pkg:npm/protobufjs@7.6.5',
      ],
      mobile: [
        'pkg:npm/esbuild@0.28.1',
        'pkg:npm/node-pty@1.1.0',
        'pkg:npm/protobufjs@7.6.5',
      ],
      container: [
        'pkg:npm/cpu-features@0.0.10',
        'pkg:npm/esbuild@0.25.12',
        'pkg:npm/esbuild@0.28.1',
        'pkg:npm/libxmljs2@0.37.0',
        'pkg:npm/node-pty@1.1.0',
        'pkg:npm/protobufjs@7.6.5',
        'pkg:npm/ssh2@1.17.0',
      ],
    });
  });

  it('normalizes the scoped npm group emitted by the real CycloneDX producer', () => {
    expect(
      cyclonedxComponents(
        {
          bomFormat: 'CycloneDX',
          specVersion: '1.6',
          components: [
            {
              group: '@kontourai',
              name: 'station-shared',
              purl: 'pkg:npm/%40kontourai/station-shared@0.5.0',
              version: '0.5.0',
            },
          ],
        },
        'npm',
      ),
    ).toEqual([
      expect.objectContaining({
        name: '@kontourai/station-shared',
        purl: 'pkg:npm/%40kontourai/station-shared@0.5.0',
      }),
    ]);
  });

  it('normalizes the cargo-cyclonedx patched local path without publishing it', () => {
    const components = cyclonedxComponents(
      {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        components: [
          {
            name: 'android-native-keyring-store',
            version: '1.0.0',
            purl: 'pkg:cargo/android-native-keyring-store@1.0.0?z=last&download_url=file%3A%2F%2F%2Fprivate%2Frunner%2Fpatches%2Fandroid-native-keyring-store&a=first',
          },
        ],
      },
      'cargo',
    );
    expect(components).toEqual([
      expect.objectContaining({
        purl: 'pkg:cargo/android-native-keyring-store@1.0.0?a=first&z=last',
      }),
    ]);
    expect(JSON.stringify(components)).not.toContain('/private');
    expect(() =>
      cyclonedxComponents(
        {
          bomFormat: 'CycloneDX',
          specVersion: '1.5',
          components: [
            {
              name: 'bad',
              version: '1',
              purl: 'pkg:cargo/bad@1?download_url=https%3A%2F%2Fevil.test',
            },
          ],
        },
        'cargo',
      ),
    ).toThrow(/non-file local download URL/);
  });

  it.each([
    [
      'missing platform',
      [
        {
          platform: { os: 'linux', architecture: 'amd64' },
          digest: `sha256:${'c'.repeat(64)}`,
        },
      ],
    ],
    [
      'duplicate platform',
      [
        {
          platform: { os: 'linux', architecture: 'amd64' },
          digest: `sha256:${'c'.repeat(64)}`,
        },
        {
          platform: { os: 'linux', architecture: 'amd64' },
          digest: `sha256:${'d'.repeat(64)}`,
        },
        {
          platform: { os: 'linux', architecture: 'arm64' },
          digest: `sha256:${'e'.repeat(64)}`,
        },
      ],
    ],
  ])(
    'rejects hostile manifest-list platform binding: %s',
    (_label, manifests) => {
      expect(() =>
        platformDigests({ manifests }, `sha256:${'b'.repeat(64)}`),
      ).toThrow(/platform/);
    },
  );

  it('binds exactly both immutable platform digests from a manifest list', () => {
    expect(
      platformDigests(
        {
          manifests: [
            {
              platform: { os: 'linux', architecture: 'arm64' },
              digest: `sha256:${'d'.repeat(64)}`,
            },
            {
              platform: { os: 'linux', architecture: 'amd64' },
              digest: `sha256:${'c'.repeat(64)}`,
            },
          ],
        },
        `sha256:${'b'.repeat(64)}`,
      ),
    ).toEqual({
      'linux/amd64': `sha256:${'c'.repeat(64)}`,
      'linux/arm64': `sha256:${'d'.repeat(64)}`,
    });
  });

  it('materializes a pinned container scanner inventory into a nonempty canonical image fragment', () => {
    const value = fixture();
    const source = scannerSource(value);
    const fragment = containerSourceToFragment({
      descriptor: scannerDescriptor(value.context),
      source,
      sourceSha: value.context.sourceSha,
    });
    writeFileSync(value.fragments.container, canonicalJson(fragment));
    generateReleaseSboms(value);
    const finalSbom = JSON.parse(
      readFileSync(join(value.assetsDir, SBOM_ASSETS.container), 'utf8'),
    );
    expect(finalSbom.packages).toHaveLength(3);
    expect(finalSbom.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checksums: [{ algorithm: 'SHA256', checksumValue: 'd'.repeat(64) }],
          externalRefs: [
            expect.objectContaining({
              referenceLocator: 'pkg:deb/debian/bash@5.2.15-2+b2?arch=amd64',
            }),
          ],
          licenseDeclared: 'MIT',
          name: 'bash',
          versionInfo: '5.2.15-2+b2',
        }),
      ]),
    );
  });

  it.each([
    [
      'altered source SHA',
      (value: any) => ({ ...scannerSource(value), sourceSha: 'e'.repeat(40) }),
      /scanner envelope/,
    ],
    [
      'wrong image',
      (value: any) => ({
        ...scannerSource(value),
        image: 'ghcr.io/kontourai/other',
      }),
      /recorded image digest and platforms/,
    ],
    [
      'wrong digest',
      (value: any) => ({
        ...scannerSource(value),
        digest: `sha256:${'e'.repeat(64)}`,
      }),
      /recorded image digest and platforms/,
    ],
    [
      'wrong platform envelope',
      (value: any) => ({ ...scannerSource(value), platforms: ['linux/amd64'] }),
      /recorded image digest and platforms/,
    ],
    [
      'wrong ecosystem envelope',
      (value: any) => ({ ...scannerSource(value), ecosystems: ['cargo'] }),
      /ecosystem envelope/,
    ],
  ])(
    'rejects hostile container scanner source: %s',
    (_label, mutate, error) => {
      const value = fixture();
      const source = mutate(value);
      if (source === undefined) return;
      expect(() =>
        containerSourceToFragment({
          descriptor: scannerDescriptor(value.context),
          source,
          sourceSha: value.context.sourceSha,
        }),
      ).toThrow(error);
      expect(generatedAssets(value.assetsDir)).toEqual([]);
    },
  );

  it('rejects an empty container scanner inventory before any fragment can be published', () => {
    const value = fixture();
    expect(() => scannerSource(value, [])).toThrow(/exact and nonempty/);
    expect(generatedAssets(value.assetsDir)).toEqual([]);
  });

  it('generates exactly four canonical bound assets and preserves rich dependency identity', () => {
    const rich = {
      name: 'npm-dep',
      version: '1.0.0',
      purl: 'pkg:npm/npm-dep@1.0.0',
      hashes: [{ alg: 'SHA-256', content: 'c'.repeat(64) }],
      licenses: ['MIT'],
    };
    const { assetsDir, fragmentsDir, context, fragments } = fixture({
      components: [rich],
    });
    context.dependencyLifecycle = {
      digest: 'd'.repeat(64),
      purlsByScope: {
        portable: [rich.purl],
        desktop: [rich.purl],
        mobile: [rich.purl],
        container: [rich.purl],
      },
    };
    writeFragment(fragments.container, 'container', 'image', [
      {
        name: 'image-dep',
        version: '3.0.0',
        purl: 'pkg:oci/image-dep@3.0.0',
      },
      rich,
    ]);
    const generated = generateReleaseSboms({
      assetsDir,
      fragmentsDir,
      context,
      fragments,
    });
    expect(Object.keys(generated)).toEqual([
      'portable',
      'desktop',
      'mobile',
      'container',
    ]);
    for (const [scope, asset] of Object.entries(SBOM_ASSETS))
      expect(
        validateSbomBytes(
          generated[scope as keyof typeof generated],
          readFileSync(join(assetsDir, asset)),
        ),
      ).toBeTruthy();
    const npm = JSON.parse(
      readFileSync(join(assetsDir, SBOM_ASSETS.portable), 'utf8'),
    ).components.find((item: any) => item.purl === rich.purl);
    expect(npm).toMatchObject({
      name: rich.name,
      version: rich.version,
      purl: rich.purl,
      hashes: rich.hashes,
      licenses: [{ license: { id: 'MIT' } }],
    });
    const metadata = JSON.parse(
      readFileSync(join(assetsDir, SBOM_ASSETS.portable), 'utf8'),
    ).metadata.properties;
    expect(metadata).toEqual(
      expect.arrayContaining([
        {
          name: 'station:dependency-lifecycle-digest',
          value: context.dependencyLifecycle.digest,
        },
        {
          name: 'station:dependency-lifecycle-purls',
          value: canonicalJson(
            context.dependencyLifecycle.purlsByScope.portable,
          ),
        },
      ]),
    );
    expect(() => validateReleaseSbomPredicates(assetsDir)).not.toThrow();
    expect(readdirSync(fragmentsDir)).toHaveLength(3);
  });

  it('rejects a lifecycle purl expected for a scope but absent from that scope inventory', () => {
    const value = fixture();
    value.context.dependencyLifecycle.purlsByScope.portable = [
      'pkg:npm/missing-native@1.0.0',
    ];
    expect(() => generateReleaseSboms(value)).toThrow(
      'lifecycle components do not match the allowlist',
    );
  });

  const requiredContainerLifecyclePurls = [
    'pkg:npm/cpu-features@0.0.10',
    'pkg:npm/esbuild@0.25.12',
    'pkg:npm/esbuild@0.28.1',
    'pkg:npm/libxmljs2@0.37.0',
    'pkg:npm/node-pty@1.1.0',
    'pkg:npm/protobufjs@7.6.5',
    'pkg:npm/ssh2@1.17.0',
  ];

  it.each(requiredContainerLifecyclePurls)(
    'rejects a container SBOM missing required installed lifecycle package %s',
    (missing) => {
      const value = fixture();
      value.context.dependencyLifecycle.purlsByScope = {
        portable: ['pkg:npm/npm-dep@1.0.0'],
        desktop: ['pkg:npm/npm-dep@1.0.0'],
        mobile: ['pkg:npm/npm-dep@1.0.0'],
        container: requiredContainerLifecyclePurls,
      };
      writeFragment(value.fragments.container, 'container', 'image', [
        {
          name: 'image-dep',
          version: '3.0.0',
          purl: 'pkg:oci/image-dep@3.0.0',
        },
        ...requiredContainerLifecyclePurls
          .filter((purl) => purl !== missing)
          .map((purl) => {
            const [, name, version] = purl.match(/^pkg:npm\/(.+)@(.+)$/) ?? [];
            return { name, version, purl };
          }),
      ]);
      expect(() => generateReleaseSboms(value)).toThrow(
        'lifecycle components do not match the allowlist',
      );
    },
  );

  it('rejects a fragment component that copies another package identity', () => {
    const value = fixture({
      components: [
        {
          name: 'not-the-package',
          version: '9.9.9',
          purl: 'pkg:npm/npm-dep@1.0.0',
        },
      ],
    });
    expect(() => generateReleaseSboms(value)).toThrow(
      'fragment component identity is invalid',
    );
  });

  it('normalizes component permutations and permits distinct versions of one package name', () => {
    const first = [
      { name: 'same', version: '1.0.0', purl: 'pkg:npm/same@1.0.0' },
      { name: 'same', version: '2.0.0', purl: 'pkg:npm/same@2.0.0' },
    ];
    const left = fixture({ components: first });
    const right = fixture({ components: [...first].reverse() });
    generateReleaseSboms(left);
    generateReleaseSboms(right);
    expect(readFileSync(join(left.assetsDir, SBOM_ASSETS.desktop))).toEqual(
      readFileSync(join(right.assetsDir, SBOM_ASSETS.desktop)),
    );
    expect(
      JSON.parse(
        readFileSync(join(left.assetsDir, SBOM_ASSETS.desktop), 'utf8'),
      ).components.filter((item: any) => item.name === 'same'),
    ).toHaveLength(2);
  });

  it.each([
    [
      'bad tag',
      (value: any) => {
        value.context.tag = 'bad';
      },
    ],
    [
      'bad channel',
      (value: any) => {
        value.context.channel = 'preview';
      },
    ],
    [
      'bad generated time',
      (value: any) => {
        value.context.generatedAt = 'yesterday';
      },
    ],
    [
      'incomplete scope',
      (value: any) => {
        value.context.subjectsByScope.desktop.pop();
      },
    ],
    [
      'cross scope',
      (value: any) => {
        value.context.subjectsByScope.portable =
          value.context.subjectsByScope.desktop;
      },
    ],
  ])('rejects invalid %s before writing a partial set', (_label, mutate) => {
    const value = fixture();
    mutate(value);
    expect(() => generateReleaseSboms(value)).toThrow();
    expect(generatedAssets(value.assetsDir)).toEqual([]);
  });

  it.each([
    [
      'unknown field',
      (value: any) =>
        writeFileSync(
          value.fragments.npm,
          canonicalJson({
            components: [],
            predicate: 'runtime',
            source: 'npm',
            unsafe: true,
          }),
        ),
    ],
    [
      'duplicate full identity',
      (value: any) =>
        writeFragment(value.fragments.npm, 'npm', 'runtime', [
          { name: 'same', version: '1.0.0', purl: 'pkg:npm/same@1.0.0' },
          { name: 'same', version: '1.0.0', purl: 'pkg:npm/same@1.0.0' },
        ]),
    ],
    [
      'wrong predicate',
      (value: any) => writeFragment(value.fragments.npm, 'npm', 'native', []),
    ],
  ])(
    'rejects hostile fragments with no partial assets: %s',
    (_label, mutate) => {
      const value = fixture();
      mutate(value);
      expect(() => generateReleaseSboms(value)).toThrow(
        'Invalid release SBOM generation input',
      );
      expect(generatedAssets(value.assetsDir)).toEqual([]);
    },
  );

  it('rejects symlinked asset roots, fragment parents, and output links without touching outside bytes', () => {
    const value = fixture();
    const outside = join(value.root, 'outside');
    mkdirSync(outside);
    const sentinel = join(outside, 'sentinel');
    writeFileSync(sentinel, 'unchanged');
    const linkedRoot = join(value.root, 'linked-assets');
    symlinkSync(value.assetsDir, linkedRoot);
    expect(() =>
      generateReleaseSboms({ ...value, assetsDir: linkedRoot }),
    ).toThrow('not a real directory');
    const linkedParent = join(value.fragmentsDir, 'escape');
    symlinkSync(outside, linkedParent);
    const escaped = join(linkedParent, 'npm.json');
    writeFileSync(join(outside, 'npm.json'), readFileSync(value.fragments.npm));
    expect(() =>
      generateReleaseSboms({
        ...value,
        fragments: { ...value.fragments, npm: escaped },
      }),
    ).toThrow('symbolic link');
    symlinkSync(sentinel, join(value.assetsDir, SBOM_ASSETS.portable));
    expect(() => generateReleaseSboms(value)).toThrow('symbolic link');
    expect(readFileSync(sentinel, 'utf8')).toBe('unchanged');
    expect(generatedAssets(value.assetsDir)).toEqual([SBOM_ASSETS.portable]);
  });

  it.each([1, 2, 3, 4])(
    'rolls back every staged output when rename %i fails',
    (failureAt) => {
      const value = fixture();
      let calls = 0;
      expect(() =>
        generateReleaseSboms({
          ...value,
          rename(from: any, to: any) {
            calls += 1;
            if (calls === failureAt) throw new Error('injected rename failure');
            renameSync(from, to);
          },
        }),
      ).toThrow('injected rename failure');
      expect(generatedAssets(value.assetsDir)).toEqual([]);
    },
  );
});
