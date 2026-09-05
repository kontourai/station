import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { releaseVariants } from '../lib/release-artifacts.mjs';
import {
  canonicalJson,
  SBOM_ASSETS,
  validateSbomBytes,
  validateSbomDescriptor,
  validateSbomDescriptorSet,
} from '../lib/release-sboms.mjs';

const hash = (source: string) =>
  createHash('sha256').update(source).digest('hex');
const subject = (name: string, variant: string) => ({
  name,
  variant,
  sha256: hash(`${name}:${variant}`),
});
const subjectsFor = (tag: string, scope: 'portable' | 'desktop' | 'mobile') =>
  (
    releaseVariants(tag) as Array<{
      id: string;
      platform: string;
      files: string[];
    }>
  )
    .filter((variant) =>
      scope === 'portable'
        ? variant.id === 'portable-server'
        : scope === 'desktop'
          ? ['macos', 'windows', 'linux'].includes(variant.platform)
          : ['android', 'ios'].includes(variant.platform),
    )
    .flatMap((variant) =>
      variant.files.map((name) => subject(name, variant.id)),
    );
const context = {
  tag: 'v1.0.0',
  version: '1.0.0',
  sourceSha: 'a'.repeat(40),
  generatedAt: '2026-01-01T00:00:00.000Z',
  channel: 'stable',
  dependencyLifecycle: {
    digest: 'd'.repeat(64),
    purlsByScope: {
      portable: ['pkg:npm/esbuild@0.28.1'],
      desktop: ['pkg:npm/esbuild@0.28.1'],
      mobile: ['pkg:npm/esbuild@0.28.1'],
      container: ['pkg:npm/esbuild@0.28.1'],
    },
  },
  subjectsByScope: {
    portable: subjectsFor('v1.0.0', 'portable'),
    desktop: subjectsFor('v1.0.0', 'desktop'),
    mobile: subjectsFor('v1.0.0', 'mobile'),
  },
  container: {
    image: 'ghcr.io/kontourai/station',
    digest: `sha256:${'b'.repeat(64)}`,
  },
} as const;

function cycloneDx(scope: 'portable' | 'desktop' | 'mobile') {
  return canonicalJson({
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      timestamp: context.generatedAt,
      component: {
        type: 'application',
        name: 'Station',
        version: context.version,
      },
      properties: [
        {
          name: 'station:dependency-lifecycle-digest',
          value: context.dependencyLifecycle.digest,
        },
        {
          name: 'station:dependency-lifecycle-purls',
          value: canonicalJson(context.dependencyLifecycle.purlsByScope[scope]),
        },
      ],
    },
    components: [
      ...context.subjectsByScope[scope].map((item, index) => ({
        type: 'file',
        group: 'kontourai-release-subject',
        name: item.name,
        'bom-ref': `subject-${index}`,
        hashes: [{ alg: 'SHA-256', content: item.sha256 }],
        properties: [{ name: 'station:release-variant', value: item.variant }],
      })),
      {
        type: 'library',
        name: 'esbuild',
        version: '0.28.1',
        purl: 'pkg:npm/esbuild@0.28.1',
        'bom-ref': 'dependency-esbuild',
      },
    ],
  });
}

function descriptor(scope: 'portable' | 'desktop' | 'mobile') {
  const bytes = cycloneDx(scope);
  const value = {
    scope,
    asset: SBOM_ASSETS[scope],
    format: 'CycloneDX',
    sha256: hash(bytes),
    tag: context.tag,
    version: context.version,
    sourceSha: context.sourceSha,
    generatedAt: context.generatedAt,
    dependencyLifecycle: {
      digest: context.dependencyLifecycle.digest,
      purls: context.dependencyLifecycle.purlsByScope[scope],
    },
    subjects: context.subjectsByScope[scope],
  };
  return Object.defineProperty(value, 'bytes', {
    value: bytes,
  }) as typeof value & {
    bytes: string;
  };
}

function containerFixture() {
  const bytes = canonicalJson({
    spdxVersion: 'SPDX-2.3',
    SPDXID: 'SPDXRef-DOCUMENT',
    dataLicense: 'CC0-1.0',
    name: 'Station container SBOM',
    documentNamespace:
      'https://kontourai.example/sbom/station/v1.0.0/container',
    comment:
      'station:fragment-predicates=container/image;station:dependency-lifecycle-digest=' +
      context.dependencyLifecycle.digest +
      ';station:dependency-lifecycle-purls=' +
      canonicalJson(context.dependencyLifecycle.purlsByScope.container),
    creationInfo: {
      created: context.generatedAt,
      creators: ['Tool: Station release-sboms'],
    },
    documentDescribes: ['SPDXRef-Container'],
    packages: [
      {
        SPDXID: 'SPDXRef-Container',
        name: context.container.image,
        versionInfo: context.container.digest,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'NOASSERTION',
        copyrightText: 'NOASSERTION',
        externalRefs: [
          {
            referenceCategory: 'OTHER',
            referenceType: 'station-platform',
            referenceLocator: 'linux/amd64',
          },
          {
            referenceCategory: 'OTHER',
            referenceType: 'station-platform',
            referenceLocator: 'linux/arm64',
          },
          {
            referenceCategory: 'OTHER',
            referenceType: 'station-image',
            referenceLocator: `${context.container.image}@${context.container.digest}`,
          },
          {
            referenceCategory: 'PACKAGE-MANAGER',
            referenceType: 'purl',
            referenceLocator:
              'pkg:oci/kontourai/station@sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
        ],
        checksums: [{ algorithm: 'SHA256', checksumValue: 'b'.repeat(64) }],
      },
      {
        SPDXID: 'SPDXRef-Dependency-bash',
        name: 'bash',
        versionInfo: '5.2',
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'NOASSERTION',
        copyrightText: 'NOASSERTION',
        externalRefs: [
          {
            referenceCategory: 'PACKAGE-MANAGER',
            referenceType: 'purl',
            referenceLocator: 'pkg:deb/debian/bash@5.2',
          },
        ],
      },
      {
        SPDXID: 'SPDXRef-Dependency-esbuild',
        name: 'esbuild',
        versionInfo: '0.28.1',
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'NOASSERTION',
        copyrightText: 'NOASSERTION',
        externalRefs: [
          {
            referenceCategory: 'PACKAGE-MANAGER',
            referenceType: 'purl',
            referenceLocator: 'pkg:npm/esbuild@0.28.1',
          },
        ],
      },
    ],
  });
  const value = {
    scope: 'container',
    asset: SBOM_ASSETS.container,
    format: 'SPDX',
    sha256: hash(bytes),
    tag: context.tag,
    version: context.version,
    sourceSha: context.sourceSha,
    generatedAt: context.generatedAt,
    dependencyLifecycle: {
      digest: context.dependencyLifecycle.digest,
      purls: context.dependencyLifecycle.purlsByScope.container,
    },
    container: {
      ...context.container,
      platforms: ['linux/amd64', 'linux/arm64'],
    },
  };
  return Object.defineProperty(value, 'bytes', {
    value: bytes,
  }) as typeof value & {
    bytes: string;
  };
}

describe('release SBOM validation leaf', () => {
  test('binds exact CycloneDX 1.6 subjects and checksum', () => {
    const fixture = descriptor('desktop');
    const validated = validateSbomDescriptor(fixture, context);
    expect(validateSbomBytes(validated, fixture.bytes)).toEqual(
      JSON.parse(fixture.bytes),
    );
  });

  test('fails closed when a CycloneDX lifecycle binding is omitted, extra, wrong, or absent from components', () => {
    const fixture = descriptor('desktop');
    const mutate = (change: (value: any) => void) => {
      const value = JSON.parse(fixture.bytes);
      change(value);
      const bytes = canonicalJson(value);
      return () =>
        validateSbomBytes({ ...fixture, sha256: hash(bytes) }, bytes);
    };
    expect(
      mutate((value) => {
        value.metadata.properties = value.metadata.properties.slice(1);
      }),
    ).toThrow(/lifecycle policy binding is missing/);
    expect(
      mutate((value) => {
        value.metadata.properties[0].value = '0'.repeat(64);
      }),
    ).toThrow(/does not match the descriptor/);
    expect(
      mutate((value) => {
        value.metadata.properties[1].value = canonicalJson([
          ...context.dependencyLifecycle.purlsByScope.desktop,
          'pkg:npm/extra@1.0.0',
        ]);
      }),
    ).toThrow(/does not match the descriptor/);
    expect(
      mutate((value) => {
        value.components = value.components.filter(
          (component: any) => component.purl !== 'pkg:npm/esbuild@0.28.1',
        );
      }),
    ).toThrow(/lifecycle components/);
    expect(() =>
      validateSbomDescriptor(
        { ...fixture, dependencyLifecycle: undefined },
        context,
      ),
    ).toThrow(/lifecycle policy/);
  });

  test('rejects copied purls with a mismatched CycloneDX component identity or type', () => {
    const fixture = descriptor('desktop');
    const mutate = (change: (value: any) => void) => {
      const value = JSON.parse(fixture.bytes);
      change(value);
      const bytes = canonicalJson(value);
      return () =>
        validateSbomBytes({ ...fixture, sha256: hash(bytes) }, bytes);
    };
    expect(
      mutate((value) => {
        const component = value.components.find(
          (item: any) => item.purl === 'pkg:npm/esbuild@0.28.1',
        );
        component.name = 'copied-esbuild';
        component.version = '9.9.9';
      }),
    ).toThrow(/package URL does not match/);
    expect(
      mutate((value) => {
        const component = value.components.find(
          (item: any) => item.purl === 'pkg:npm/esbuild@0.28.1',
        );
        component.type = 'file';
      }),
    ).toThrow(/invalid component type/);
  });

  test('rejects incomplete CycloneDX 1.6 document metadata', () => {
    const fixture = descriptor('portable');
    const missingVersion = JSON.parse(fixture.bytes);
    delete missingVersion.version;
    const missingVersionBytes = canonicalJson(missingVersion);
    expect(() =>
      validateSbomBytes(
        { ...fixture, sha256: hash(missingVersionBytes) },
        missingVersionBytes,
      ),
    ).toThrow(/CycloneDX metadata/);
    const missingComponentType = JSON.parse(fixture.bytes);
    delete missingComponentType.metadata.component.type;
    const missingComponentTypeBytes = canonicalJson(missingComponentType);
    expect(() =>
      validateSbomBytes(
        { ...fixture, sha256: hash(missingComponentTypeBytes) },
        missingComponentTypeBytes,
      ),
    ).toThrow(/CycloneDX metadata/);
    for (const type of ['garbage', 'library']) {
      const wrongType = JSON.parse(fixture.bytes);
      wrongType.components[0].type = type;
      const wrongTypeBytes = canonicalJson(wrongType);
      expect(() =>
        validateSbomBytes(
          { ...fixture, sha256: hash(wrongTypeBytes) },
          wrongTypeBytes,
        ),
      ).toThrow(type === 'library' ? /must be file/ : /CycloneDX/);
    }
    const fullEnum = JSON.parse(fixture.bytes);
    fullEnum.components.push(
      {
        type: 'data',
        name: 'training-data.json',
        'bom-ref': 'dependency-data',
      },
      {
        type: 'cryptographic-asset',
        name: 'release-key',
        'bom-ref': 'dependency-cryptographic-asset',
      },
    );
    const fullEnumBytes = canonicalJson(fullEnum);
    expect(
      validateSbomBytes(
        { ...fixture, sha256: hash(fullEnumBytes) },
        fullEnumBytes,
      ),
    ).toEqual(fullEnum);
  });

  test('binds the release version exactly to the tag', () => {
    const fixture = descriptor('portable');
    expect(() =>
      validateSbomDescriptor(
        { ...fixture, version: '9.9.9' },
        { ...context, version: '9.9.9' },
      ),
    ).toThrow(/release context/);
  });

  test('requires one exact descriptor per scope', () => {
    const fixtures = [
      descriptor('portable'),
      descriptor('desktop'),
      descriptor('mobile'),
      containerFixture(),
    ];
    expect(validateSbomDescriptorSet(fixtures, context)).toHaveLength(4);
    expect(() =>
      validateSbomDescriptorSet(
        [...fixtures.slice(0, 3), fixtures[0]],
        context,
      ),
    ).toThrow(/missing or duplicated/);
  });

  test('rejects traversal, checksum drift, duplicate subjects and bom-ref', () => {
    const fixture = descriptor('portable');
    expect(() =>
      validateSbomDescriptor({ ...fixture, asset: '../x' }, context),
    ).toThrow();
    expect(() =>
      validateSbomDescriptor({ ...fixture, asset: '.' }, context),
    ).toThrow();
    expect(() =>
      validateSbomDescriptor(
        {
          ...fixture,
          subjects: [{ ...fixture.subjects[0], variant: '../portable' }],
        },
        context,
      ),
    ).toThrow();
    expect(() =>
      validateSbomBytes({ ...fixture, sha256: '0'.repeat(64) }, fixture.bytes),
    ).toThrow(/checksum/);
    expect(() =>
      validateSbomDescriptor(
        { ...fixture, subjects: [fixture.subjects[0], fixture.subjects[0]] },
        context,
      ),
    ).toThrow(/Duplicate/);
    const duplicate = canonicalJson({
      ...JSON.parse(fixture.bytes),
      components: [
        ...JSON.parse(fixture.bytes).components,
        JSON.parse(fixture.bytes).components[0],
      ],
    });
    expect(() =>
      validateSbomBytes({ ...fixture, sha256: hash(duplicate) }, duplicate),
    ).toThrow(/duplicate bom-ref/);
    const invalidRefValue = JSON.parse(fixture.bytes);
    invalidRefValue.components[0]['bom-ref'] = '../subject';
    const invalidRef = canonicalJson(invalidRefValue);
    expect(() =>
      validateSbomBytes({ ...fixture, sha256: hash(invalidRef) }, invalidRef),
    ).toThrow(/bom-ref/);
  });

  test('rejects malformed, noncanonical, oversized, and invalid UTF-8 bytes', () => {
    const fixture = descriptor('portable');
    expect(() => validateSbomBytes(fixture, '{')).toThrow(/valid JSON/);
    expect(() =>
      validateSbomBytes(
        fixture,
        JSON.stringify(JSON.parse(fixture.bytes), null, 2),
      ),
    ).toThrow(/canonical/);
    const parsed = JSON.parse(fixture.bytes);
    const reordered = JSON.stringify({
      version: parsed.version,
      components: parsed.components,
      bomFormat: parsed.bomFormat,
      metadata: parsed.metadata,
      specVersion: parsed.specVersion,
    });
    expect(() => validateSbomBytes(fixture, reordered)).toThrow(/canonical/);
    expect(() =>
      validateSbomBytes(fixture, 'x'.repeat(2 * 1024 * 1024 + 1)),
    ).toThrow(/bounded size/);
    expect(() => validateSbomBytes(fixture, Buffer.from([0xc3, 0x28]))).toThrow(
      /UTF-8/,
    );
  });

  test('enforces preview/stable mobile and complete desktop variants', () => {
    const previewContext = {
      ...context,
      tag: 'v1.0.0-preview.1',
      version: '1.0.0-preview.1',
      channel: 'preview',
      subjectsByScope: {
        portable: subjectsFor('v1.0.0-preview.1', 'portable'),
        desktop: subjectsFor('v1.0.0-preview.1', 'desktop'),
        mobile: subjectsFor('v1.0.0-preview.1', 'mobile'),
      },
    } as const;
    const mobile = {
      ...descriptor('mobile'),
      tag: previewContext.tag,
      version: previewContext.version,
      subjects: previewContext.subjectsByScope.mobile,
    };
    expect(validateSbomDescriptor(mobile, previewContext)).toBe(mobile);
    expect(() =>
      validateSbomDescriptor(
        {
          ...mobile,
          subjects: [
            ...mobile.subjects,
            subject('unexpected.ipa', 'ios-device'),
          ],
        },
        {
          ...previewContext,
          subjectsByScope: {
            ...previewContext.subjectsByScope,
            mobile: [
              ...previewContext.subjectsByScope.mobile,
              subject('unexpected.ipa', 'ios-device'),
            ],
          },
        },
      ),
    ).toThrow(/exact release variants/);
    const desktop = descriptor('desktop');
    expect(() =>
      validateSbomDescriptor(
        { ...desktop, subjects: desktop.subjects.slice(0, 2) },
        {
          ...context,
          subjectsByScope: {
            ...context.subjectsByScope,
            desktop: desktop.subjects.slice(0, 2),
          },
        },
      ),
    ).toThrow(/exact release variants/);
  });

  test('binds an immutable multi-arch SPDX container subject', () => {
    const fixture = containerFixture();
    const validated = validateSbomDescriptor(fixture, context);
    expect(validateSbomBytes(validated, fixture.bytes)).toEqual(
      JSON.parse(fixture.bytes),
    );
    expect(() =>
      validateSbomDescriptor(
        {
          ...fixture,
          container: { ...fixture.container, digest: 'latest' },
        },
        context,
      ),
    ).toThrow(/immutable/);
    expect(() =>
      validateSbomDescriptor(
        { ...fixture, tag: 'x1.0.0' },
        { ...context, tag: 'x1.0.0' },
      ),
    ).toThrow(/release context/);
    const invalidDocument = JSON.parse(fixture.bytes);
    delete invalidDocument.dataLicense;
    const invalidDocumentBytes = canonicalJson(invalidDocument);
    expect(() =>
      validateSbomBytes(
        { ...fixture, sha256: hash(invalidDocumentBytes) },
        invalidDocumentBytes,
      ),
    ).toThrow(/SPDX metadata/);
    const invalidId = JSON.parse(fixture.bytes);
    invalidId.packages[0].SPDXID = '../container';
    const invalidIdBytes = canonicalJson(invalidId);
    expect(() =>
      validateSbomBytes(
        { ...fixture, sha256: hash(invalidIdBytes) },
        invalidIdBytes,
      ),
    ).toThrow(/package identities/);
    const invalidReference = JSON.parse(fixture.bytes);
    invalidReference.packages[0].externalRefs[0].referenceCategory =
      'PACKAGE-MANAGER';
    const invalidReferenceBytes = canonicalJson(invalidReference);
    expect(() =>
      validateSbomBytes(
        { ...fixture, sha256: hash(invalidReferenceBytes) },
        invalidReferenceBytes,
      ),
    ).toThrow(/container subject/);
    const missingLifecycleComponent = JSON.parse(fixture.bytes);
    missingLifecycleComponent.packages =
      missingLifecycleComponent.packages.filter(
        (item: any) => item.SPDXID !== 'SPDXRef-Dependency-esbuild',
      );
    const missingLifecycleComponentBytes = canonicalJson(
      missingLifecycleComponent,
    );
    expect(() =>
      validateSbomBytes(
        { ...fixture, sha256: hash(missingLifecycleComponentBytes) },
        missingLifecycleComponentBytes,
      ),
    ).toThrow(/lifecycle components/);
    const legacy = JSON.parse(fixture.bytes);
    legacy.documentComment = legacy.comment;
    delete legacy.comment;
    const legacyBytes = canonicalJson(legacy);
    expect(() =>
      validateSbomBytes({ ...fixture, sha256: hash(legacyBytes) }, legacyBytes),
    ).not.toThrow();
    legacy.comment = 'conflicting binding';
    const ambiguousBytes = canonicalJson(legacy);
    expect(() =>
      validateSbomBytes(
        { ...fixture, sha256: hash(ambiguousBytes) },
        ambiguousBytes,
      ),
    ).toThrow(/comment fields disagree/);
    const wrongLifecycle = JSON.parse(fixture.bytes);
    wrongLifecycle.comment = wrongLifecycle.comment.replace(
      context.dependencyLifecycle.digest,
      '0'.repeat(64),
    );
    const wrongLifecycleBytes = canonicalJson(wrongLifecycle);
    expect(() =>
      validateSbomBytes(
        { ...fixture, sha256: hash(wrongLifecycleBytes) },
        wrongLifecycleBytes,
      ),
    ).toThrow(/lifecycle policy binding/);
    const copiedPurl = JSON.parse(fixture.bytes);
    copiedPurl.packages.find(
      (item: any) => item.SPDXID === 'SPDXRef-Dependency-esbuild',
    ).name = 'copied-esbuild';
    const copiedPurlBytes = canonicalJson(copiedPurl);
    expect(() =>
      validateSbomBytes(
        { ...fixture, sha256: hash(copiedPurlBytes) },
        copiedPurlBytes,
      ),
    ).toThrow(/package URL does not match/);
    const missingPolicy = JSON.parse(fixture.bytes);
    missingPolicy.comment = 'station:fragment-predicates=container/image';
    const missingPolicyBytes = canonicalJson(missingPolicy);
    expect(() =>
      validateSbomBytes(
        { ...fixture, sha256: hash(missingPolicyBytes) },
        missingPolicyBytes,
      ),
    ).toThrow(/lifecycle policy binding/);
  });
});
