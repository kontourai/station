import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BACKLOG_POLICY } from '../backlog-priority-policy.mjs';
import {
  collectPublicContributionSurfaceFindings,
  parseCodeowners,
  REPORTER_INELIGIBLE_LABELS,
  TRUST_ROOTS,
} from '../public-contribution-surfaces.mjs';

const root = process.cwd();

function findingsWith(
  patches: Record<string, string> = {},
  exists: typeof existsSync = existsSync,
) {
  // `read`/`exists` are typed by the .mjs module's own defaults
  // (`readFileSync`/`existsSync`), whose first parameter is a
  // PathOrFileDescriptor / PathLike, not a string. Normalize at the boundary
  // rather than narrowing the callback and failing to be assignable.
  const read = ((path: unknown, encoding: unknown) => {
    const target = String(path);
    const entry = Object.entries(patches).find(([relative]) =>
      target.endsWith(relative),
    );
    return entry ? entry[1] : readFileSync(target, encoding as BufferEncoding);
  }) as unknown as typeof readFileSync;
  return collectPublicContributionSurfaceFindings({ root, exists, read });
}

describe('public contribution surfaces', () => {
  it('accepts the checked-in contract and protects only existing narrow roots', () => {
    expect(findingsWith()).toEqual([]);
    expect(REPORTER_INELIGIBLE_LABELS).toEqual(
      BACKLOG_POLICY.classificationLabels,
    );
    expect(TRUST_ROOTS).toEqual(
      expect.arrayContaining([
        '.github/CODEOWNERS',
        '.github/ISSUE_TEMPLATE/',
        '.github/pull_request_template.md',
        'scripts/actionlint-gate.mjs',
        'scripts/ci-workflow-governance.mjs',
        'scripts/dependency-advisory-policy.mjs',
        'scripts/dependency-advisory-exceptions.json',
        'scripts/codeql-sarif-policy.mjs',
        'docs/guides/dependency-security.md',
        'schemas/release-artifact-manifest.schema.json',
        'src-server/services/privacy-inventory.ts',
        'src-desktop/gen/apple/PrivacyInfo.xcprivacy',
      ]),
    );
    for (const path of TRUST_ROOTS) {
      expect(existsSync(`${root}/${path}`), path).toBe(true);
    }
  });

  it('parses only a single path and owner per CODEOWNERS line', () => {
    expect(
      parseCodeowners('docs/privacy-policy.md @briananderson1222 @other'),
    ).toEqual({
      entries: [],
      findings: ['CODEOWNERS line 1 must contain one path and one owner.'],
    });
  });

  it('rejects blank issues, missing privacy protection, and laundered bug requirements', () => {
    const config = readFileSync(
      '.github/ISSUE_TEMPLATE/config.yml',
      'utf8',
    ).replace('blank_issues_enabled: false', 'blank_issues_enabled: true');
    const bug = readFileSync('.github/ISSUE_TEMPLATE/bug-report.yml', 'utf8')
      .replace('Do not include secrets', 'Share everything')
      .replace('id: user-impact', 'id: removed-user-impact')
      .replace('id: observed-behavior', 'id: laundered-observed-behavior');
    const findings = findingsWith({
      '.github/ISSUE_TEMPLATE/config.yml': config,
      '.github/ISSUE_TEMPLATE/bug-report.yml': bug,
    });
    expect(findings).toContain(
      'Issue-template config must disable blank issues.',
    );
    expect(findings).toContain(
      'Bug form must warn reporters not to include private or unredacted diagnostics.',
    );
    expect(findings).toContain("Bug form must include 'user-impact'.");
    expect(findings).toContain("Bug form must include 'observed-behavior'.");
  });

  it('rejects a required solution and laundered feature priority field', () => {
    const feature =
      `${readFileSync('.github/ISSUE_TEMPLATE/feature-request.yml', 'utf8')}
  - type: input
    id: priority
    attributes:
      label: Priority
    validations:
      required: true
`
        .replace(
          'label: Proposed solution (optional)',
          'label: Proposed solution',
        )
        .replace(
          'description: Offer a possible shape only if it helps explain the problem. Maintainers may choose a different implementation.',
          'description: Required implementation plan.',
        )
        .replace(
          'id: proposed-solution\n    attributes:',
          'id: proposed-solution\n    validations:\n      required: true\n    attributes:',
        );
    const findings = findingsWith({
      '.github/ISSUE_TEMPLATE/feature-request.yml': feature,
    });
    expect(findings).toContain(
      'Feature form proposed solution must remain optional.',
    );
    expect(findings).toContain(
      'Feature form must not assign priority or disposition fields.',
    );
  });

  it.each(BACKLOG_POLICY.classificationLabels)(
    'rejects reporter-ineligible label %s on both issue forms',
    (label) => {
      const bug = readFileSync(
        '.github/ISSUE_TEMPLATE/bug-report.yml',
        'utf8',
      ).replace('  - bug', `  - bug\n  - ${label}`);
      const feature = readFileSync(
        '.github/ISSUE_TEMPLATE/feature-request.yml',
        'utf8',
      ).replace('  - enhancement', `  - enhancement\n  - ${label}`);
      const findings = findingsWith({
        '.github/ISSUE_TEMPLATE/bug-report.yml': bug,
        '.github/ISSUE_TEMPLATE/feature-request.yml': feature,
      });
      expect(findings).toContain(
        `Bug form must not assign reporter-ineligible label '${label}'.`,
      );
      expect(findings).toContain(
        `Feature form must not assign reporter-ineligible label '${label}'.`,
      );
    },
  );

  it('accepts neutral category labels on both forms', () => {
    const bug = readFileSync('.github/ISSUE_TEMPLATE/bug-report.yml', 'utf8');
    const feature = readFileSync(
      '.github/ISSUE_TEMPLATE/feature-request.yml',
      'utf8',
    );
    expect(
      findingsWith({
        '.github/ISSUE_TEMPLATE/bug-report.yml': bug,
        '.github/ISSUE_TEMPLATE/feature-request.yml': feature,
      }),
    ).toEqual([]);
  });

  it('rejects disabled Discussions routes and routes support through Kontour', () => {
    const config = readFileSync(
      '.github/ISSUE_TEMPLATE/config.yml',
      'utf8',
    ).replace(
      'https://kontourai.io/support/',
      'https://github.com/kontourai/station/discussions',
    );
    const contributing = readFileSync('CONTRIBUTING.md', 'utf8')
      .replace(
        'https://kontourai.io/support/',
        'https://github.com/kontourai/station/discussions',
      )
      .replace('discussion/architecture proposal', 'architecture proposal');
    const guide = readFileSync('docs/user/contributing.md', 'utf8')
      .replace(
        'https://kontourai.io/support/',
        'https://github.com/kontourai/station/discussions',
      )
      .replace('discussion/architecture proposal', 'architecture proposal');
    const findings = findingsWith({
      '.github/ISSUE_TEMPLATE/config.yml': config,
      'CONTRIBUTING.md': contributing,
      'docs/user/contributing.md': guide,
    });
    expect(findings).toContain(
      "Issue-template contact 'Get Support' must target its canonical route.",
    );
    expect(findings).toContain(
      'CONTRIBUTING must route support to https://kontourai.io/support/.',
    );
    expect(findings).toContain(
      'CONTRIBUTING must route discuss-first through the issue chooser.',
    );
    expect(findings).toContain(
      'CONTRIBUTING must not claim GitHub Discussions is available.',
    );
    expect(findings).toContain(
      'Public contribution guide must route support to kontourai.io/support/.',
    );
    expect(findings).toContain(
      'Public contribution guide must route discuss-first through the issue chooser.',
    );
    expect(findings).toContain(
      'Public contribution guide must not claim GitHub Discussions is available.',
    );
  });

  it('rejects incomplete PR evidence and prompt disclosure', () => {
    const template = readFileSync('.github/pull_request_template.md', 'utf8')
      .replace('## Risk and rollback', '## Risk')
      .replace('Personal inspection performed:', 'Prompt used:');
    const findings = findingsWith({
      '.github/pull_request_template.md': template,
    });
    expect(findings).toContain(
      "PR template is missing '## Risk and rollback'.",
    );
    expect(findings).toContain(
      "PR template is missing 'Personal inspection performed'.",
    );
    expect(findings).toContain(
      'PR template must not ask contributors to disclose prompts.',
    );
  });

  it('requires the exact documentation-impact topology and rejects weak alternatives', () => {
    const template = readFileSync('.github/pull_request_template.md', 'utf8')
      .replace('## Documentation impact', '## Docs')
      .replace(
        'Affected public docs and generated sources (exact repository-relative paths):',
        'Affected docs:',
      )
      .replace(
        'No documentation impact (explicit reason; do not write "none", "N/A", or leave this blank):',
        'Documentation impact: N/A',
      );
    const findings = findingsWith({
      '.github/pull_request_template.md': template,
    });
    expect(findings).toContain(
      "PR template is missing '## Documentation impact'.",
    );
    expect(findings).toContain(
      "PR template is missing 'Affected public docs and generated sources (exact repository-relative paths):'.",
    );
    expect(findings).toContain(
      'PR template is missing \'No documentation impact (explicit reason; do not write "none", "N/A", or leave this blank):\'.',
    );
  });

  it('rejects a missing route, an unverified-fork claim, and public command duplication', () => {
    const contributing = readFileSync('CONTRIBUTING.md', 'utf8')
      .replace('| Support |', '| Help |')
      .replace('**NOT_VERIFIED**', 'available and safe')
      .replace('hosted Pages deployment', 'Pages deployment');
    const guide = `${readFileSync('docs/user/contributing.md', 'utf8')}
\`\`\`sh
npm run full:regression
\`\`\`
`;
    const findings = findingsWith({
      'CONTRIBUTING.md': contributing,
      'docs/user/contributing.md': guide,
    });
    expect(findings).toContain("CONTRIBUTING must route 'Support'.");
    expect(findings).toContain(
      'CONTRIBUTING must state the external-fork boundary as NOT_VERIFIED.',
    );
    expect(findings).toContain(
      "CONTRIBUTING must state 'hosted Pages deployment'.",
    );
    expect(findings).toContain(
      'Public contribution guide must not duplicate commands or live delivery state.',
    );
  });

  it('rejects broad, unexpected, and missing CODEOWNERS roots', () => {
    const codeowners = `${readFileSync('.github/CODEOWNERS', 'utf8')}
* @briananderson1222
README.md @briananderson1222
`;
    const findings = findingsWith({ '.github/CODEOWNERS': codeowners });
    expect(
      findings.some((finding) =>
        finding.includes('must not use a broad root or wildcard.'),
      ),
    ).toBe(true);
    expect(findings).toContain(
      "CODEOWNERS path '*' is not an approved narrow trust root.",
    );
    expect(findings).toContain(
      "CODEOWNERS path 'README.md' is not an approved narrow trust root.",
    );
  });

  it('rejects a trust root that no longer exists and duplicate public admission', () => {
    const manifest = readFileSync(
      'docs/pages/public-docs.json',
      'utf8',
    ).replace(
      '{\n      "source": "user/contributing.md",\n      "section": "Contribute"\n    }',
      '{\n      "source": "user/contributing.md",\n      "section": "Contribute"\n    },\n    {\n      "source": "user/contributing.md",\n      "section": "Contribute"\n    }',
    );
    const findings = findingsWith(
      { 'docs/pages/public-docs.json': manifest },
      (path) =>
        !String(path).endsWith('scripts/native-update-feed.mjs') &&
        existsSync(path),
    );
    expect(findings).toContain(
      "CODEOWNERS path 'scripts/native-update-feed.mjs' does not exist.",
    );
    expect(findings).toContain(
      'Public docs manifest must admit user/contributing.md exactly once under Contribute.',
    );
  });
});
