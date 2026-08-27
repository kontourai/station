import { describe, expect, it } from 'vitest';
import {
  isVocabularyTextFile,
  runVocabularyGate,
  scanVocabularyContent,
} from '../station-vocabulary-gate.mjs';

const retired = (...parts: string[]) => parts.join('');

describe('station-vocabulary-gate', () => {
  it('catches retired saved-Station selectors and nouns', () => {
    const source = [
      retired('station ', 'profile list'),
      retired('Station active ', 'profile'),
      retired('--', 'profile=box-b'),
      retired('STATION_', 'PROFILE=box-b'),
    ].join('\n');
    expect(
      scanVocabularyContent('packages/cli/README.md', source).map(
        (finding) => finding.code,
      ),
    ).toEqual([
      'saved-station-profile',
      'saved-station-profile',
      'legacy-target-flag',
      'station-profile-env',
    ]);
  });

  it('catches Layout, Pane, and Panel boundary drift', () => {
    const source = [
      retired('Project layout ', 'profile'),
      retired('Workspace ', 'Panel'),
      retired('Layout ', 'panels'),
      retired('Workspace Pane ', 'layout'),
      retired('Runtime ', 'pane'),
    ].join('\n');
    expect(
      scanVocabularyContent('docs/example.md', source).map(
        (finding) => finding.code,
      ),
    ).toEqual([
      'layout-profile',
      'workspace-panel',
      'layout-panel',
      'workspace-pane-layout',
      'runtime-pane',
    ]);
  });

  it('accepts canonical composition and qualified profile concepts', () => {
    const source = [
      'A Layout contains Panes; a Pane may contain Panels.',
      'Edit your user Profile.',
      'Choose an AWS profile.',
      'Select an Apple provisioning profile.',
      'A saved SSH profile already exists.',
      'Apply the credential-recovery profile.',
      'Use --station=box-b or STATION_TARGET=box-b.',
    ].join('\n');
    expect(scanVocabularyContent('docs/example.md', source)).toEqual([]);
  });

  it('allows vendor-owned profile flags only at their qualified sources', () => {
    const flag = retired('--', 'profile value');
    expect(
      scanVocabularyContent('scripts/check-ios-store-profile.mjs', flag),
    ).toEqual([]);
    expect(
      scanVocabularyContent(
        'docs/guides/mobile-release.md',
        'node scripts/ios-local-release-preflight.mjs --profile /tmp/profile.mobileprovision',
      ),
    ).toEqual([]);
    expect(
      scanVocabularyContent(
        'docs/guides/mobile-release.md',
        'node ../scripts/check-ios-store-profile.mjs --profile Payload/Station.app/embedded.mobileprovision',
      ),
    ).toEqual([]);
    expect(
      scanVocabularyContent('docs/guides/mobile-release.md', '--profile=box-b'),
    ).toMatchObject([{ code: 'legacy-target-flag' }]);
    expect(
      scanVocabularyContent(
        'src-server/providers/adapters/bedrock-adapter.ts',
        `aws sso login ${flag}`,
      ),
    ).toEqual([]);
    expect(scanVocabularyContent('docs/reference/cli.md', flag)).toHaveLength(
      1,
    );
  });

  it('discovers tracked text dynamically and excludes generated/self files', () => {
    expect(isVocabularyTextFile('docs/new-guide.md')).toBe(true);
    expect(isVocabularyTextFile('src-desktop/src/lib.rs')).toBe(true);
    expect(isVocabularyTextFile('package-lock.json')).toBe(false);
    expect(isVocabularyTextFile('asset.png')).toBe(false);

    const files = ['docs/a.md', 'src/a.ts', 'asset.png'];
    const result = runVocabularyGate({
      files,
      readFile: (file: string) =>
        file === 'docs/a.md' ? retired('Station ', 'profile') : 'Station',
    });
    expect(result.scanned).toEqual(['docs/a.md', 'src/a.ts']);
    expect(result.findings).toHaveLength(1);
  });
});
