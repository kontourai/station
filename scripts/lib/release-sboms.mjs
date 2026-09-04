import { createHash } from 'node:crypto';
import { releaseVariants } from './release-artifacts.mjs';

export const SBOM_ASSETS = Object.freeze({
  portable: 'station-sbom-portable.cdx.json',
  desktop: 'station-sbom-desktop.cdx.json',
  mobile: 'station-sbom-mobile.cdx.json',
  container: 'station-sbom-container.spdx.json',
});
export const SBOM_SCOPES = Object.freeze(Object.keys(SBOM_ASSETS));
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const MAX_SBOM_BYTES = 2 * 1024 * 1024;
const SUBJECT_GROUP = 'kontourai-release-subject';
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/;
const VARIANT_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const BOM_REF = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,255}$/;
const SPDX_ID = /^SPDXRef-[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
const VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-preview\.([1-9][0-9]*))?$/;
const CYCLONEDX_COMPONENT_TYPES = new Set([
  'application',
  'container',
  'cryptographic-asset',
  'data',
  'device',
  'device-driver',
  'file',
  'firmware',
  'framework',
  'library',
  'machine-learning-model',
  'operating-system',
  'platform',
]);

const safeText = (value, max = 4096) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
const exactKeys = (value, allowed) =>
  Object.keys(value).every((key) => allowed.includes(key));
const exactIso = (value) =>
  safeText(value, 64) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const sortedUnique = (items) =>
  [...new Set(items)].sort((left, right) => left.localeCompare(right));

function lifecyclePurls(value) {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('SBOM lifecycle policy binding is invalid');
  const normalized = sortedUnique(value);
  if (
    normalized.length !== value.length ||
    !normalized.every((purl) => /^pkg:npm\/.+@[^@/]+$/.test(purl))
  )
    throw new Error('SBOM lifecycle policy binding is invalid');
  return normalized;
}

function expectedLifecycle(context) {
  const lifecycle = context?.dependencyLifecycle;
  if (
    !lifecycle ||
    Object.keys(lifecycle).sort().join(',') !== 'digest,purlsByScope' ||
    !/^[a-f0-9]{64}$/.test(lifecycle.digest ?? '') ||
    !lifecycle.purlsByScope ||
    Object.keys(lifecycle.purlsByScope).sort().join(',') !==
      [...SBOM_SCOPES].sort().join(',')
  )
    throw new Error('Invalid SBOM release context');
  return {
    digest: lifecycle.digest,
    purlsByScope: Object.fromEntries(
      SBOM_SCOPES.map((scope) => [
        scope,
        lifecyclePurls(lifecycle.purlsByScope[scope]),
      ]),
    ),
  };
}

export function lifecycleBindingForScope(context, scope) {
  if (!SBOM_SCOPES.includes(scope))
    throw new Error('Invalid SBOM lifecycle scope');
  const lifecycle = expectedLifecycle(context);
  return { digest: lifecycle.digest, purls: lifecycle.purlsByScope[scope] };
}

function purlIdentity(purl) {
  if (!safeText(purl, 512) || !purl.startsWith('pkg:'))
    throw new Error('SBOM component has an invalid package URL');
  const withoutQualifiers = purl.slice(4).split(/[?#]/, 1)[0];
  const separator = withoutQualifiers.indexOf('/');
  const at = withoutQualifiers.lastIndexOf('@');
  if (
    separator <= 0 ||
    at <= separator + 1 ||
    at === withoutQualifiers.length - 1
  )
    throw new Error('SBOM component has an invalid package URL');
  let name, version;
  try {
    const packagePath = withoutQualifiers.slice(separator + 1, at);
    const packageName =
      withoutQualifiers.slice(0, separator) === 'npm'
        ? packagePath
        : packagePath.slice(packagePath.lastIndexOf('/') + 1);
    name = decodeURIComponent(packageName);
    version = decodeURIComponent(withoutQualifiers.slice(at + 1));
  } catch {
    throw new Error('SBOM component has an invalid package URL');
  }
  if (!safeText(name, 240) || !safeText(version, 160))
    throw new Error('SBOM component has an invalid package URL');
  return { name, purlType: withoutQualifiers.slice(0, separator), version };
}

/** Rejects a copied package URL that does not describe this component itself. */
export function validateComponentPurlIdentity(component, expectedPurlType) {
  const identity = purlIdentity(component?.purl);
  if (
    (expectedPurlType && identity.purlType !== expectedPurlType) ||
    component?.name !== identity.name ||
    component?.version !== identity.version
  )
    throw new Error('SBOM component package URL does not match its identity');
  return identity;
}

function containerPurl(container) {
  return `pkg:oci/${container.image.replace(/^ghcr\.io\//, '')}@${container.digest.replace('sha256:', 'sha256-')}`;
}

function decode(bytes) {
  if (typeof bytes === 'string') {
    if (Buffer.byteLength(bytes) > MAX_SBOM_BYTES)
      throw new Error('SBOM bytes exceed the bounded size');
    return bytes;
  }
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array))
    throw new Error('SBOM bytes must be UTF-8 text');
  if (bytes.byteLength > MAX_SBOM_BYTES)
    throw new Error('SBOM bytes exceed the bounded size');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('SBOM bytes are not valid UTF-8');
  }
}

function parseCanonical(bytes) {
  const source = decode(bytes);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('SBOM bytes are not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('SBOM root must be an object');
  if (canonicalJson(value) !== source)
    throw new Error('SBOM JSON is not canonical');
  return { source, value };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function validateContext(context) {
  if (
    !safeText(context?.tag, 160) ||
    !VERSION.test(context?.version ?? '') ||
    context.tag !== `v${context.version}` ||
    !GIT_SHA.test(context?.sourceSha ?? '') ||
    !exactIso(context?.generatedAt) ||
    (context?.channel !== 'preview' && context?.channel !== 'stable') ||
    context.tag.includes('-preview.') !== (context.channel === 'preview') ||
    (() => {
      try {
        expectedLifecycle(context);
        return false;
      } catch {
        return true;
      }
    })()
  )
    throw new Error('Invalid SBOM release context');
}

function normalizedSubjects(subjects) {
  if (!Array.isArray(subjects) || subjects.length === 0 || subjects.length > 32)
    throw new Error('SBOM subject set is missing or exceeds the bound');
  const normalized = subjects.map((subject) => {
    if (
      !subject ||
      !exactKeys(subject, ['name', 'sha256', 'variant']) ||
      !FILE_NAME.test(subject.name ?? '') ||
      subject.name === '.' ||
      subject.name === '..' ||
      !SHA256.test(subject.sha256 ?? '') ||
      !VARIANT_ID.test(subject.variant ?? '')
    )
      throw new Error('Invalid SBOM artifact subject');
    return {
      name: subject.name,
      sha256: subject.sha256,
      variant: subject.variant,
    };
  });
  if (
    new Set(normalized.map((subject) => subject.name)).size !==
    normalized.length
  )
    throw new Error('Duplicate SBOM artifact subject');
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

function expectedSubjects(scope, context) {
  const subjects = normalizedSubjects(context?.subjectsByScope?.[scope]);
  const expected = releaseVariants(context.tag)
    .filter((variant) =>
      scope === 'portable'
        ? variant.id === 'portable-server'
        : scope === 'desktop'
          ? ['macos', 'windows', 'linux'].includes(variant.platform)
          : ['android', 'ios'].includes(variant.platform),
    )
    .flatMap((variant) =>
      variant.files.map((name) => ({ name, variant: variant.id })),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  if (
    JSON.stringify(subjects.map(({ name, variant }) => ({ name, variant }))) !==
    JSON.stringify(expected)
  )
    throw new Error(
      `${scope} SBOM subjects do not match the exact release variants`,
    );
  return subjects;
}

export function validateSbomDescriptor(descriptor, context) {
  validateContext(context);
  if (
    !descriptor ||
    !exactKeys(descriptor, [
      'scope',
      'asset',
      'format',
      'sha256',
      'tag',
      'version',
      'sourceSha',
      'generatedAt',
      'subjects',
      'container',
      'dependencyLifecycle',
    ]) ||
    !SBOM_SCOPES.includes(descriptor.scope) ||
    descriptor.asset !== SBOM_ASSETS[descriptor.scope] ||
    !SHA256.test(descriptor.sha256 ?? '') ||
    descriptor.tag !== context.tag ||
    descriptor.version !== context.version ||
    descriptor.sourceSha !== context.sourceSha ||
    descriptor.generatedAt !== context.generatedAt
  )
    throw new Error('Invalid SBOM descriptor binding');
  const lifecycle = lifecycleBindingForScope(context, descriptor.scope);
  if (
    canonicalJson(descriptor.dependencyLifecycle) !== canonicalJson(lifecycle)
  )
    throw new Error(
      'SBOM descriptor lifecycle policy does not match the release context',
    );
  if (descriptor.scope === 'container') {
    const container = descriptor.container;
    if (
      descriptor.format !== 'SPDX' ||
      descriptor.subjects !== undefined ||
      !container ||
      !exactKeys(container, ['image', 'digest', 'platforms']) ||
      !safeText(container.image, 240) ||
      container.image.includes('@') ||
      !/^sha256:[a-f0-9]{64}$/.test(container.digest ?? '') ||
      JSON.stringify(container.platforms) !==
        JSON.stringify(['linux/amd64', 'linux/arm64']) ||
      container.image !== context.container?.image ||
      container.digest !== context.container?.digest
    )
      throw new Error('Container SBOM lacks its immutable multi-arch subject');
  } else {
    if (descriptor.format !== 'CycloneDX' || descriptor.container !== undefined)
      throw new Error('CycloneDX descriptor has an invalid scope payload');
    const expected = expectedSubjects(descriptor.scope, context);
    if (
      JSON.stringify(normalizedSubjects(descriptor.subjects)) !==
      JSON.stringify(expected)
    )
      throw new Error(
        'SBOM artifact subjects do not match the release inventory',
      );
  }
  return descriptor;
}

export function validateSbomDescriptorSet(descriptors, context) {
  if (!Array.isArray(descriptors) || descriptors.length !== SBOM_SCOPES.length)
    throw new Error('Release must contain exactly four SBOM descriptors');
  const validated = descriptors.map((descriptor) =>
    validateSbomDescriptor(descriptor, context),
  );
  if (
    JSON.stringify(sortedUnique(validated.map((entry) => entry.scope))) !==
    JSON.stringify([...SBOM_SCOPES].sort())
  )
    throw new Error('Release SBOM scopes are missing or duplicated');
  return validated;
}

function componentHash(component) {
  const hashes = Array.isArray(component?.hashes) ? component.hashes : [];
  const matches = hashes.filter((hash) => hash?.alg === 'SHA-256');
  return matches.length === 1 && SHA256.test(matches[0]?.content ?? '')
    ? matches[0].content
    : null;
}

function componentVariant(component) {
  const properties = Array.isArray(component?.properties)
    ? component.properties
    : [];
  const matches = properties.filter(
    (property) => property?.name === 'station:release-variant',
  );
  return matches.length === 1 && safeText(matches[0]?.value, 80)
    ? matches[0].value
    : null;
}

function validateCycloneDx(descriptor, value) {
  if (
    value.bomFormat !== 'CycloneDX' ||
    value.specVersion !== '1.6' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    value.metadata?.timestamp !== descriptor.generatedAt ||
    value.metadata?.component?.type !== 'application' ||
    value.metadata?.component?.name !== 'Station' ||
    value.metadata?.component?.version !== descriptor.version ||
    !Array.isArray(value.components) ||
    value.components.length > 20_000
  )
    throw new Error('CycloneDX metadata does not match the descriptor');
  const expectedLifecyclePolicy = descriptor.dependencyLifecycle;
  const lifecycleProperties =
    value.metadata?.properties?.filter(
      (property) =>
        property?.name === 'station:dependency-lifecycle-digest' ||
        property?.name === 'station:dependency-lifecycle-purls',
    ) ?? [];
  if (lifecycleProperties.length !== 2)
    throw new Error('CycloneDX lifecycle policy binding is missing');
  {
    const lifecycle = Object.fromEntries(
      lifecycleProperties.map((property) => [property.name, property.value]),
    );
    let actualPurls;
    try {
      actualPurls = lifecyclePurls(
        JSON.parse(lifecycle['station:dependency-lifecycle-purls'] ?? 'null'),
      );
    } catch {
      throw new Error('CycloneDX lifecycle policy binding is invalid');
    }
    if (
      lifecycle['station:dependency-lifecycle-digest'] !==
        expectedLifecyclePolicy.digest ||
      canonicalJson(actualPurls) !==
        canonicalJson(expectedLifecyclePolicy.purls)
    )
      throw new Error(
        'CycloneDX lifecycle policy binding does not match the descriptor',
      );
    const componentPurls = new Set(
      value.components.map((component) => component?.purl).filter(Boolean),
    );
    const relevant = sortedUnique(
      expectedLifecyclePolicy.purls.filter((purl) => componentPurls.has(purl)),
    );
    if (
      canonicalJson(relevant) !== canonicalJson(expectedLifecyclePolicy.purls)
    )
      throw new Error(
        'CycloneDX lifecycle components do not match the allowlist',
      );
  }
  const refs = value.components.map((component) => component?.['bom-ref']);
  if (
    value.components.some(
      (component) =>
        !CYCLONEDX_COMPONENT_TYPES.has(component?.type) ||
        !safeText(component?.name, 240) ||
        (component?.group === SUBJECT_GROUP &&
          !FILE_NAME.test(component?.name ?? '')),
    ) ||
    refs.some(
      (ref) =>
        !BOM_REF.test(ref ?? '') || ref.includes('..') || ref.includes('\\'),
    ) ||
    new Set(refs).size !== refs.length
  )
    throw new Error('CycloneDX has invalid or duplicate bom-ref values');
  for (const component of value.components)
    if (component?.purl !== undefined) {
      if (component.type !== 'library')
        throw new Error('CycloneDX dependency has an invalid component type');
      validateComponentPurlIdentity(component);
    }
  const releaseSubjects = value.components
    .filter((component) => component?.group === SUBJECT_GROUP)
    .map((component) => ({
      name: component.name,
      sha256: componentHash(component),
      variant: componentVariant(component),
    }));
  if (
    value.components.some(
      (component) =>
        component?.group === SUBJECT_GROUP && component?.type !== 'file',
    )
  )
    throw new Error('CycloneDX release subjects must be file components');
  if (
    JSON.stringify(normalizedSubjects(releaseSubjects)) !==
    JSON.stringify(normalizedSubjects(descriptor.subjects))
  )
    throw new Error('CycloneDX release subjects do not match the descriptor');
}

function validateSpdx(descriptor, value) {
  if (
    value.spdxVersion !== 'SPDX-2.3' ||
    value.SPDXID !== 'SPDXRef-DOCUMENT' ||
    value.dataLicense !== 'CC0-1.0' ||
    !safeText(value.name, 240) ||
    !/^https:\/\/[^\s]+$/.test(value.documentNamespace ?? '') ||
    value.creationInfo?.created !== descriptor.generatedAt ||
    !Array.isArray(value.creationInfo?.creators) ||
    value.creationInfo.creators.length === 0 ||
    value.creationInfo.creators.some(
      (creator) => !safeText(creator, 206) || !creator.startsWith('Tool: '),
    ) ||
    !Array.isArray(value.packages) ||
    value.packages.length < 2 ||
    value.packages.length > 20_000
  )
    throw new Error('SPDX metadata does not match the descriptor');
  const ids = value.packages.map((item) => item?.SPDXID);
  if (
    value.packages.some(
      (item) =>
        !safeText(item?.name, 240) ||
        item?.downloadLocation !== 'NOASSERTION' ||
        item?.filesAnalyzed !== false ||
        !safeText(item?.licenseConcluded, 512) ||
        !safeText(item?.licenseDeclared, 512) ||
        item?.copyrightText !== 'NOASSERTION',
    ) ||
    ids.some((id) => !SPDX_ID.test(id ?? '') || id.includes('..')) ||
    new Set(ids).size !== ids.length
  )
    throw new Error('SPDX has invalid or duplicate package identities');
  if (
    JSON.stringify(value.documentDescribes) !==
    JSON.stringify(['SPDXRef-Container'])
  )
    throw new Error('SPDX does not describe the immutable container subject');
  const subject = value.packages.find(
    (item) => item?.SPDXID === 'SPDXRef-Container',
  );
  const containerRefs = subject?.externalRefs ?? [];
  const platforms = (subject?.externalRefs ?? [])
    .filter(
      (ref) =>
        ref?.referenceCategory === 'OTHER' &&
        ref?.referenceType === 'station-platform',
    )
    .map((ref) => ref.referenceLocator)
    .sort();
  const imageRef = containerRefs.filter(
    (ref) =>
      ref?.referenceCategory === 'OTHER' &&
      ref?.referenceType === 'station-image',
  );
  const purlRef = containerRefs.filter(
    (ref) =>
      ref?.referenceCategory === 'PACKAGE-MANAGER' &&
      ref?.referenceType === 'purl',
  );
  const checksums = subject?.checksums ?? [];
  if (
    subject?.name !== descriptor.container.image ||
    subject?.versionInfo !== descriptor.container.digest ||
    JSON.stringify(platforms) !==
      JSON.stringify(['linux/amd64', 'linux/arm64']) ||
    imageRef.length !== 1 ||
    imageRef[0]?.referenceLocator !==
      `${descriptor.container.image}@${descriptor.container.digest}` ||
    purlRef.length !== 1 ||
    purlRef[0]?.referenceLocator !== containerPurl(descriptor.container) ||
    checksums.length !== 1 ||
    checksums[0]?.algorithm !== 'SHA256' ||
    checksums[0]?.checksumValue !== descriptor.container.digest.slice(7)
  )
    throw new Error('SPDX container subject does not match the descriptor');
  const dependencies = value.packages.filter(
    (item) => item?.SPDXID !== 'SPDXRef-Container',
  );
  if (
    dependencies.length === 0 ||
    dependencies.some(
      (item) =>
        !Array.isArray(item?.externalRefs) ||
        item.externalRefs.length !== 1 ||
        item.externalRefs[0]?.referenceCategory !== 'PACKAGE-MANAGER' ||
        item.externalRefs[0]?.referenceType !== 'purl' ||
        !safeText(item.externalRefs[0]?.referenceLocator, 512) ||
        !item.externalRefs[0].referenceLocator.startsWith('pkg:'),
    )
  )
    throw new Error('SPDX container inventory has no valid scanner packages');
  for (const dependency of dependencies)
    validateComponentPurlIdentity({
      name: dependency.name,
      purl: dependency.externalRefs[0].referenceLocator,
      version: dependency.versionInfo,
    });
  const lifecycle = descriptor.dependencyLifecycle;
  const comment = spdxComment(value);
  const prefix = 'station:fragment-predicates=container/image';
  const expectedComment = `${prefix};station:dependency-lifecycle-digest=${lifecycle.digest};station:dependency-lifecycle-purls=${canonicalJson(lifecycle.purls)}`;
  if (comment !== expectedComment)
    throw new Error(
      'SPDX lifecycle policy binding does not match the descriptor',
    );
  const dependencyPurls = new Set(
    dependencies.map((item) => item.externalRefs[0].referenceLocator),
  );
  const relevant = sortedUnique(
    lifecycle.purls.filter((purl) => dependencyPurls.has(purl)),
  );
  if (canonicalJson(relevant) !== canonicalJson(lifecycle.purls))
    throw new Error('SPDX lifecycle components do not match the allowlist');
}

/** Read older Station artifacts while new producers use SPDX's standard field. */
export function spdxComment(value) {
  if (
    value.comment !== undefined &&
    value.documentComment !== undefined &&
    value.comment !== value.documentComment
  )
    throw new Error('SPDX comment fields disagree');
  return value.comment ?? value.documentComment ?? '';
}

export function validateSbomBytes(descriptor, bytes) {
  const { source, value } = parseCanonical(bytes);
  if (
    createHash('sha256').update(source).digest('hex') !==
    descriptor.sha256.toLowerCase()
  )
    throw new Error('SBOM checksum does not bind descriptor');
  if (descriptor.format === 'CycloneDX') validateCycloneDx(descriptor, value);
  else if (descriptor.format === 'SPDX') validateSpdx(descriptor, value);
  else throw new Error('Unsupported SBOM format');
  return value;
}
