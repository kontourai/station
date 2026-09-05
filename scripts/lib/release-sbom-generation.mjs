import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  canonicalJson,
  lifecycleBindingForScope,
  SBOM_ASSETS,
  validateComponentPurlIdentity,
  validateSbomBytes,
  validateSbomDescriptorSet,
} from './release-sboms.mjs';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_FRAGMENT_BYTES = 2 * 1024 * 1024;
const MAX_COMPONENTS = 20_000;
const PURL =
  /^pkg:[A-Za-z0-9.+-]+\/[A-Za-z0-9._~%/-]+(?:@[A-Za-z0-9._~%+-]+)?(?:\?[A-Za-z0-9._~%&=.-]+)?(?:#[A-Za-z0-9._~%/-]+)?$/;
const LICENSE = /^[A-Za-z0-9.+-]{1,128}$/;

function fail(message) {
  throw new Error(`Invalid release SBOM generation input: ${message}`);
}

function safeText(value, max = 240) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function isContained(root, candidate) {
  const path = relative(root, candidate);
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

function realDirectory(path, label) {
  const lexical = resolve(path);
  let stat;
  try {
    stat = lstatSync(lexical);
  } catch {
    fail(`${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    fail(`${label} is not a real directory`);
  return { lexical, real: realpathSync(lexical), label };
}

function assertNoSymlinkBelow(root, file, label) {
  const lexical = resolve(file);
  if (!isContained(root.lexical, lexical))
    fail(`${label} is outside ${root.label}`);
  let current = root.lexical;
  for (const part of relative(root.lexical, lexical).split(sep)) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      fail(`missing ${label}`);
    }
    if (stat.isSymbolicLink()) fail(`${label} traverses a symbolic link`);
  }
  const real = realpathSync(lexical);
  if (!isContained(root.real, real))
    fail(`${label} resolves outside ${root.label}`);
  return lexical;
}

function regularFileBelow(root, file, label = basename(file)) {
  const lexical = assertNoSymlinkBelow(root, file, label);
  if (!lstatSync(lexical).isFile()) fail(`${label} is not a regular file`);
  return lexical;
}

function normalizedHashes(value, source) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8)
    fail(`${source} component hashes are invalid`);
  const hashes = value.map((hash) => {
    if (
      !hash ||
      Object.keys(hash).sort().join(',') !== 'alg,content' ||
      !(
        (hash.alg === 'SHA-256' && HASH.test(hash.content ?? '')) ||
        (hash.alg === 'SHA-512' && /^[a-f0-9]{128}$/.test(hash.content ?? ''))
      )
    )
      fail(`${source} component hashes are invalid`);
    return { alg: hash.alg, content: hash.content };
  });
  if (new Set(hashes.map((hash) => hash.content)).size !== hashes.length)
    fail(`${source} component hashes are duplicated`);
  return hashes.sort((left, right) =>
    left.content.localeCompare(right.content),
  );
}

function normalizedLicenses(value, source) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16)
    fail(`${source} component licenses are invalid`);
  const licenses = value.map((license) => {
    if (!LICENSE.test(license ?? ''))
      fail(`${source} component licenses are invalid`);
    return license;
  });
  if (new Set(licenses).size !== licenses.length)
    fail(`${source} component licenses are duplicated`);
  return licenses.sort((left, right) => left.localeCompare(right));
}

function normalizedPatchProperties(value, source) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    Object.keys(value[0] ?? {})
      .sort()
      .join(',') !== 'name,value' ||
    value[0].name !== 'station:pnpm-patch-hash' ||
    !HASH.test(value[0].value ?? '')
  )
    fail(`${source} component patch provenance is invalid`);
  return [{ name: value[0].name, value: value[0].value }];
}

function normalizedComponent(component, source) {
  if (
    !component ||
    typeof component !== 'object' ||
    Object.keys(component).some(
      (key) =>
        ![
          'name',
          'version',
          'purl',
          'hashes',
          'licenses',
          'properties',
        ].includes(key),
    ) ||
    !safeText(component.name) ||
    !safeText(component.version, 160) ||
    !safeText(component.purl, 512) ||
    !PURL.test(component.purl)
  )
    fail(`${source} fragment has an unsafe component`);
  const normalized = {
    name: component.name,
    version: component.version,
    purl: component.purl,
    hashes: normalizedHashes(component.hashes, source),
    licenses: normalizedLicenses(component.licenses, source),
    properties: normalizedPatchProperties(component.properties, source),
  };
  try {
    validateComponentPurlIdentity(
      normalized,
      source === 'npm' ? 'npm' : source === 'rust' ? 'cargo' : undefined,
    );
  } catch (error) {
    fail(
      `${source} fragment component identity is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return normalized;
}

function readCanonicalFragment(root, file, source, predicate) {
  const path = regularFileBelow(root, file, `${source} fragment`);
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_FRAGMENT_BYTES)
    fail(`${source} fragment exceeds the bounded size`);
  let value;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
    if (canonicalJson(value) !== text)
      fail(`${source} fragment is not canonical JSON`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Invalid release SBOM')
    )
      throw error;
    fail(`${source} fragment is not valid UTF-8 JSON`);
  }
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'components,predicate,source' ||
    value.source !== source ||
    value.predicate !== predicate ||
    !Array.isArray(value.components) ||
    value.components.length > MAX_COMPONENTS ||
    (source === 'container' && value.components.length === 0)
  )
    fail(`${source} fragment does not match its ${predicate} predicate`);
  const components = value.components.map((component) =>
    normalizedComponent(component, source),
  );
  if (
    new Set(components.map((component) => component.purl)).size !==
    components.length
  )
    fail(`${source} fragment has duplicate full component identities`);
  return components.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function subjectComponents(subjects) {
  return [...subjects]
    .sort((left, right) =>
      canonicalJson({
        name: left.name,
        sha256: left.sha256,
        variant: left.variant,
      }).localeCompare(
        canonicalJson({
          name: right.name,
          sha256: right.sha256,
          variant: right.variant,
        }),
      ),
    )
    .map((subject) => ({
      'bom-ref': `release:${subject.variant}:${subject.name}`,
      group: 'kontourai-release-subject',
      hashes: [{ alg: 'SHA-256', content: subject.sha256 }],
      name: subject.name,
      properties: [{ name: 'station:release-variant', value: subject.variant }],
      type: 'file',
    }));
}

function cyclonedxDependencies(components) {
  return components.map((component) => ({
    'bom-ref': `dep:${createHash('sha256').update(canonicalJson(component)).digest('hex')}`,
    hashes: component.hashes,
    ...(component.properties.length
      ? { properties: component.properties }
      : {}),
    licenses: component.licenses.map((id) => ({ license: { id } })),
    name: component.name,
    purl: component.purl,
    type: 'library',
    version: component.version,
  }));
}

function cyclonedx({ context, subjects, components, predicates, lifecycle }) {
  return canonicalJson({
    bomFormat: 'CycloneDX',
    components: [
      ...subjectComponents(subjects),
      ...cyclonedxDependencies(components),
    ],
    metadata: {
      component: {
        name: 'Station',
        type: 'application',
        version: context.version,
      },
      properties: [
        { name: 'station:fragment-predicates', value: predicates.join(',') },
        {
          name: 'station:dependency-lifecycle-digest',
          value: lifecycle.digest,
        },
        {
          name: 'station:dependency-lifecycle-purls',
          value: canonicalJson(lifecycle.purls),
        },
      ],
      timestamp: context.generatedAt,
    },
    specVersion: '1.6',
    version: 1,
  });
}

function containerSpdx({ context, components, lifecycle }) {
  const containerPurl = `pkg:oci/${context.container.image.replace(/^ghcr\.io\//, '')}@${context.container.digest.replace('sha256:', 'sha256-')}`;
  const containerChecksum = context.container.digest.slice('sha256:'.length);
  const packages = [
    {
      SPDXID: 'SPDXRef-Container',
      copyrightText: 'NOASSERTION',
      downloadLocation: 'NOASSERTION',
      externalRefs: context.container.platforms
        .map((platform) => ({
          referenceCategory: 'OTHER',
          referenceLocator: platform,
          referenceType: 'station-platform',
        }))
        .concat([
          {
            referenceCategory: 'OTHER',
            referenceLocator: `${context.container.image}@${context.container.digest}`,
            referenceType: 'station-image',
          },
          {
            referenceCategory: 'PACKAGE-MANAGER',
            referenceLocator: containerPurl,
            referenceType: 'purl',
          },
        ]),
      checksums: [{ algorithm: 'SHA256', checksumValue: containerChecksum }],
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: 'NOASSERTION',
      name: context.container.image,
      versionInfo: context.container.digest,
    },
    ...components.map((component) => ({
      SPDXID: `SPDXRef-Dependency-${createHash('sha256').update(component.purl).digest('hex').slice(0, 32)}`,
      checksums: component.hashes.map((hash) => ({
        algorithm: hash.alg === 'SHA-512' ? 'SHA512' : 'SHA256',
        checksumValue: hash.content,
      })),
      copyrightText: 'NOASSERTION',
      downloadLocation: 'NOASSERTION',
      externalRefs: [
        {
          referenceCategory: 'PACKAGE-MANAGER',
          referenceLocator: component.purl,
          referenceType: 'purl',
        },
      ],
      filesAnalyzed: false,
      licenseConcluded: component.licenses.join(' AND ') || 'NOASSERTION',
      licenseDeclared: component.licenses.join(' AND ') || 'NOASSERTION',
      name: component.name,
      ...(component.properties.length
        ? {
            sourceInfo: `pnpm patch hash: ${component.properties[0].value}; checksums identify the registry tarball before patching`,
          }
        : {}),
      versionInfo: component.version,
    })),
  ];
  return canonicalJson({
    SPDXID: 'SPDXRef-DOCUMENT',
    creationInfo: {
      created: context.generatedAt,
      creators: ['Tool: Station release-sbom-generator'],
    },
    dataLicense: 'CC0-1.0',
    documentDescribes: ['SPDXRef-Container'],
    documentNamespace: `https://station.kontour.ai/sbom/${context.sourceSha}/container`,
    comment:
      'station:fragment-predicates=container/image' +
      `;station:dependency-lifecycle-digest=${lifecycle.digest};station:dependency-lifecycle-purls=${canonicalJson(lifecycle.purls)}`,
    name: 'Station container SBOM',
    packages,
    spdxVersion: 'SPDX-2.3',
  });
}

function descriptor(scope, context, bytes, lifecycle) {
  const asset = SBOM_ASSETS[scope];
  return {
    scope,
    asset,
    format: scope === 'container' ? 'SPDX' : 'CycloneDX',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    tag: context.tag,
    version: context.version,
    sourceSha: context.sourceSha,
    generatedAt: context.generatedAt,
    dependencyLifecycle: lifecycle,
    ...(scope === 'container'
      ? {
          container: {
            image: context.container.image,
            digest: context.container.digest,
            platforms: context.container.platforms,
          },
        }
      : { subjects: context.subjectsByScope?.[scope] }),
  };
}

function assertOutputTargets(root) {
  for (const asset of Object.values(SBOM_ASSETS)) {
    const output = join(root.lexical, asset);
    try {
      assertNoSymlinkBelow(root, output, `output ${asset}`);
      fail(`output ${asset} already exists`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          `Invalid release SBOM generation input: missing output ${asset}`
      )
        continue;
      throw error;
    }
  }
}

function publishAtomically(root, records, rename) {
  const temporary = [];
  try {
    for (const record of records) {
      const temp = join(
        root.lexical,
        `.${record.descriptor.asset}.${randomUUID()}.tmp`,
      );
      writeFileSync(temp, record.bytes, { flag: 'wx', mode: 0o600 });
      temporary.push({
        destination: join(root.lexical, record.descriptor.asset),
        temp,
      });
    }
    assertOutputTargets(root);
    for (const { destination, temp } of temporary) rename(temp, destination);
  } catch (error) {
    for (const asset of Object.values(SBOM_ASSETS)) {
      const output = join(root.lexical, asset);
      try {
        if (lstatSync(output).isFile()) unlinkSync(output);
      } catch {
        // Missing is the desired rollback state; rejected links are untouched.
      }
    }
    throw error;
  } finally {
    for (const { temp } of temporary) {
      try {
        unlinkSync(temp);
      } catch {
        /* already published or unavailable */
      }
    }
  }
}

/** Generates four bound SBOMs from verified fragments outside publishable assets. */
export function generateReleaseSboms({
  assetsDir,
  fragmentsDir,
  context,
  fragments,
  rename = renameSync,
}) {
  if (
    !assetsDir ||
    !fragmentsDir ||
    !context ||
    !SHA.test(context.sourceSha ?? '')
  )
    fail(
      'assets directory, fragments directory, and release context are required',
    );
  if (!context.container || !DIGEST.test(context.container.digest ?? ''))
    fail('an immutable container context is required');
  const assets = realDirectory(assetsDir, 'assets directory');
  const fragmentRoot = realDirectory(fragmentsDir, 'fragments directory');
  const paths = Object.fromEntries(
    Object.entries(fragments ?? {}).map(([name, file]) => [
      name,
      resolve(file),
    ]),
  );
  if (Object.keys(paths).sort().join(',') !== 'container,npm,rust')
    fail('fragment paths must be exactly npm, rust, and container');
  const npm = readCanonicalFragment(fragmentRoot, paths.npm, 'npm', 'runtime');
  const rust = readCanonicalFragment(
    fragmentRoot,
    paths.rust,
    'rust',
    'native',
  );
  const container = readCanonicalFragment(
    fragmentRoot,
    paths.container,
    'container',
    'image',
  );
  const records = ['portable', 'desktop', 'mobile'].map((scope) => {
    const components = scope === 'portable' ? npm : [...npm, ...rust];
    const expectedLifecycle = lifecycleBindingForScope(context, scope);
    const lifecycle = expectedLifecycle;
    const bytes = cyclonedx({
      context,
      subjects: context.subjectsByScope?.[scope],
      components,
      lifecycle,
      predicates:
        scope === 'portable' ? ['npm/runtime'] : ['npm/runtime', 'rust/native'],
    });
    return { descriptor: descriptor(scope, context, bytes, lifecycle), bytes };
  });
  const expectedContainerLifecycle = lifecycleBindingForScope(
    context,
    'container',
  );
  const containerLifecycle = expectedContainerLifecycle;
  const containerBytes = containerSpdx({
    context,
    components: container,
    lifecycle: containerLifecycle,
  });
  records.push({
    descriptor: descriptor(
      'container',
      context,
      containerBytes,
      containerLifecycle,
    ),
    bytes: containerBytes,
  });
  const descriptors = records.map((record) => record.descriptor);
  validateSbomDescriptorSet(descriptors, context);
  for (const record of records)
    validateSbomBytes(record.descriptor, record.bytes);
  assertOutputTargets(assets);
  publishAtomically(assets, records, rename);
  return Object.fromEntries(
    records.map((record) => [record.descriptor.scope, record.descriptor]),
  );
}
