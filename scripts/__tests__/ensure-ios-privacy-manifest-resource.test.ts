import { describe, expect, test } from 'vitest';
import { ensureIosPrivacyManifestResource } from '../ensure-ios-privacy-manifest-resource.mjs';

const generatedProject = `targets:
  station_iOS:
    sources:
      - path: Sources
      - path: station_iOS
`;

describe('iOS privacy manifest project resource', () => {
  test('registers the preserved privacy manifest as an Xcode resource once', () => {
    const repaired = ensureIosPrivacyManifestResource(generatedProject);
    expect(repaired).toContain('path: PrivacyInfo.xcprivacy');
    expect(repaired).toContain('buildPhase: resources');
    expect(ensureIosPrivacyManifestResource(repaired)).toBe(repaired);
  });

  test('fails closed when the generated project shape is not recognized', () => {
    expect(() => ensureIosPrivacyManifestResource('targets: {}\n')).toThrow(
      'unique station_iOS source anchor',
    );
  });
});
