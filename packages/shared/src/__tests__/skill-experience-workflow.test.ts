import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import exampleDefinition from '../../../../examples/visual-skill-experience/io.kontourai.station/experiences/stress-test-idea.json' with {
  type: 'json',
};
import exampleManifest from '../../../../examples/visual-skill-experience/plugin.json' with {
  type: 'json',
};
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  inspectSkillLibrary,
  readSkillExperienceReview,
  reviewSkillExperiencePackage,
  type SkillExperienceReview,
  skillExperiencePackageDigest,
} from '../skill-experience-workflow.js';

const makeTemp = trackTempDirs();
const example = fileURLToPath(
  new URL('../../../../examples/visual-skill-experience/', import.meta.url),
);

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

describe('public Skill experience author workflow', () => {
  test('follows a delegating entry, references and assets without executing source, and reports missing/dynamic dependencies', () => {
    const library = makeTemp('experience-library-');
    write(
      library,
      'skills/interview/SKILL.md',
      '---\nname: interview\ndescription: Delegate an interview.\n---\nCall the Skill tool twice, for "rounds" and "missing". See [procedure](../../references/procedure.md).\n',
    );
    write(
      library,
      'skills/rounds/SKILL.md',
      '---\nname: rounds\ndescription: Ask questions.\n---\nWait for answers. See [rules](rules.md).\n',
    );
    write(
      library,
      'skills/rounds/rules.md',
      'Do not implement before confirmation.',
    );
    write(
      library,
      'skills/rounds/scripts/action.sh',
      'echo forbidden > invented-success.txt',
    );
    write(library, 'references/procedure.md', 'Read [calls](calls.md).');
    write(
      library,
      'references/calls.md',
      'Call the Skill tool for "analysis" and "shared-missing". See [procedure](procedure.md).',
    );
    write(
      library,
      'skills/analysis/SKILL.md',
      '---\nname: analysis\ndescription: Inspect the actual context.\n---\nRead facts before asking questions.\n',
    );
    const result = inspectSkillLibrary(library, ['interview']);
    expect(result.skills).toEqual([
      { name: 'analysis', path: 'skills/analysis/SKILL.md', dependsOn: [] },
      {
        name: 'interview',
        path: 'skills/interview/SKILL.md',
        dependsOn: ['analysis', 'rounds'],
      },
      { name: 'rounds', path: 'skills/rounds/SKILL.md', dependsOn: [] },
    ]);
    expect(result.files.map((file) => file.path)).toContain(
      'skills/rounds/rules.md',
    );
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unresolved Skill missing'),
        'references/calls.md: unresolved Skill shared-missing',
        expect.stringContaining('script is inspection data'),
        expect.stringContaining('dynamic Skill/tool/environment'),
      ]),
    );
    expect(() => readFileSync(join(library, 'invented-success.txt'))).toThrow();
    expect(result.files.map((file) => file.path)).toContain(
      'skills/analysis/SKILL.md',
    );
    write(
      library,
      'skills/analysis/SKILL.md',
      '---\nname: analysis\ndescription: Inspect the actual context.\n---\nConfirm the actual context before continuing.\n',
    );
    expect(inspectSkillLibrary(library, ['interview']).digest).not.toBe(
      result.digest,
    );
    rmSync(join(library, 'skills/analysis/SKILL.md'));
    expect(inspectSkillLibrary(library, ['interview']).gaps).toContain(
      'references/calls.md: unresolved Skill analysis',
    );
  });

  function authorReview() {
    const root = makeTemp('experience-review-');
    const plugin = join(root, 'plugin');
    write(plugin, 'plugin.json', JSON.stringify(exampleManifest));
    write(
      plugin,
      'io.kontourai.station/experiences/stress-test-idea.json',
      JSON.stringify(exampleDefinition),
    );
    write(
      plugin,
      'skills/stress-test-idea/SKILL.md',
      readFileSync(
        new URL(
          '../../../../examples/visual-skill-experience/skills/stress-test-idea/SKILL.md',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const inspection = inspectSkillLibrary(plugin, ['stress-test-idea']);
    write(
      plugin,
      'evaluations/success.md',
      'Session: local-evaluation\nObserved user idea, independent questions, answers, then reviewed decisions.',
    );
    write(
      plugin,
      'evaluations/refusal.md',
      'Session: local-evaluation-denial\nObserved pending confirmation; no implementation actions.',
    );
    const review: SkillExperienceReview = {
      sourceDigest: inspection.digest,
      packageDigest: skillExperiencePackageDigest(plugin),
      reviewer: 'Independent author',
      decision: 'approve',
      evidence: [
        {
          experienceId: 'stress-test-idea',
          pointer: '/inputs/0',
          origin: 'skill-declared',
          explanation: 'Idea is required.',
          source: {
            path: 'skills/stress-test-idea/SKILL.md',
            startLine: 1,
            endLine: 5,
          },
        },
        {
          experienceId: 'stress-test-idea',
          pointer: '/outputs/0',
          origin: 'station-added',
          explanation: 'Optional decision summary.',
        },
        {
          experienceId: 'stress-test-idea',
          pointer: '/interaction',
          origin: 'reviewer-inferred',
          explanation: 'Use interview rounds with stop conditions.',
        },
        {
          experienceId: 'stress-test-idea',
          pointer: '/capabilities',
          origin: 'reviewer-inferred',
          explanation: 'Conversation and optional artifact suitability.',
        },
      ],
      gapDispositions: inspection.gaps.map((gap) => ({
        gap,
        disposition:
          'No external tools needed; dynamic source reviewed, unsupported actions remain withheld.',
      })),
      evaluations: ['success', 'refusal'].map((name) => ({
        experienceId: 'stress-test-idea',
        kind: name === 'success' ? 'representative' : 'refusal-stop',
        scenario: name,
        expected: 'Preserve confirmation stop.',
        observed: 'Canonical conversation retained the stop.',
        status: 'pass',
        transcript: {
          path: `evaluations/${name}.md`,
          sha256: createHash('sha256')
            .update(readFileSync(join(plugin, `evaluations/${name}.md`)))
            .digest('hex'),
        },
      })),
    };
    return { plugin, review };
  }

  test('validates authored definitions and revision-bound source spans/transcript bytes while declaring evidence limits', () => {
    const { plugin, review } = authorReview();
    const result = reviewSkillExperiencePackage(
      plugin,
      plugin,
      ['stress-test-idea'],
      review,
    );
    expect(result.status).toBe('author-approved');
    expect(result.limits).toContain(
      'no model, installed runtime, device or release',
    );
  });

  test.each([
    'gap',
    'not-run',
    'span',
    'origin',
    'transcript',
    'source-delta',
  ] as const)('refuses %s instead of emitting author approval', (failure) => {
    const { plugin, review } = authorReview();
    const expected = {
      gap: /Unreviewed gap/,
      'not-run': /evaluations required/,
      span: /Invalid source span/,
      origin: /origin conflicts/,
      transcript: /transcript changed/,
      'source-delta': /delta requires/,
    }[failure];
    if (failure === 'gap') review.gapDispositions = [];
    if (failure === 'not-run') review.evaluations[0].status = 'not-run';
    if (failure === 'span')
      review.evidence[0].source = {
        path: 'skills/stress-test-idea/SKILL.md',
        startLine: 900,
        endLine: 901,
      };
    if (failure === 'origin') review.evidence[0].origin = 'station-added';
    if (failure === 'transcript') {
      write(plugin, 'evaluations/success.md', 'Edited transcript.');
      review.packageDigest = skillExperiencePackageDigest(plugin);
    }
    if (failure === 'source-delta')
      write(
        plugin,
        'skills/stress-test-idea/notes.md',
        'Changed dependency reference.',
      );
    expect(() =>
      reviewSkillExperiencePackage(
        plugin,
        plugin,
        ['stress-test-idea'],
        review,
      ),
    ).toThrow(expected);
  });

  test('refuses escaping symlink sources and unknown entry names', () => {
    const library = makeTemp('experience-contained-');
    const outside = makeTemp('experience-outside-');
    write(
      outside,
      'SKILL.md',
      '---\nname: outside\ndescription: Outside.\n---\nRead.',
    );
    symlinkSync(join(outside, 'SKILL.md'), join(library, 'SKILL.md'));
    expect(() => inspectSkillLibrary(library, ['outside'])).toThrow(
      /escapes root/,
    );
    expect(() => inspectSkillLibrary(example, ['missing'])).toThrow(
      /Entries must name/,
    );
  });

  test('refuses a changed rich asset anywhere in the distributed package', () => {
    const { plugin, review } = authorReview();
    write(
      plugin,
      'io.kontourai.station/assets/panel.html',
      '<p>Changed behavior</p>',
    );
    expect(() =>
      reviewSkillExperiencePackage(
        plugin,
        plugin,
        ['stress-test-idea'],
        review,
      ),
    ).toThrow(/delta requires/);
  });

  test('refuses unsupported receipt origins and duplicate source evidence before approval', () => {
    const { plugin, review } = authorReview();
    const malformed = structuredClone(review);
    const candidate: unknown = {
      ...malformed,
      evidence: malformed.evidence.map((item) =>
        item.pointer === '/interaction' ? { ...item, origin: 'garbage' } : item,
      ),
    };
    expect(() =>
      reviewSkillExperiencePackage(
        plugin,
        plugin,
        ['stress-test-idea'],
        candidate,
      ),
    ).toThrow(/Invalid author review receipt/);
    review.evidence.push(review.evidence[0]);
    expect(() =>
      reviewSkillExperiencePackage(
        plugin,
        plugin,
        ['stress-test-idea'],
        review,
      ),
    ).toThrow(/Duplicate author review evidence/);
  });

  test('reads only bounded regular receipt files and refuses unknown receipt fields', () => {
    const { plugin, review } = authorReview();
    const receipt = join(makeTemp('experience-receipt-'), 'review.json');
    writeFileSync(receipt, JSON.stringify(review));
    expect(readSkillExperienceReview(receipt).reviewer).toBe(
      'Independent author',
    );
    writeFileSync(receipt, JSON.stringify({ ...review, grantTools: true }));
    expect(() => readSkillExperienceReview(receipt)).toThrow(
      /Invalid author review receipt/,
    );
    writeFileSync(receipt, ' '.repeat(65537));
    expect(() => readSkillExperienceReview(receipt)).toThrow(
      /exceeds 65536 bytes/,
    );
    expect(() => readSkillExperienceReview(plugin)).toThrow(/must be regular/);
  });

  test('counts symbolic files against the limit and bounds package depth/total bytes', () => {
    const library = makeTemp('experience-many-symlinks-');
    write(library, 'ordinary.txt', 'contained');
    for (let i = 0; i < 1024; i++)
      symlinkSync(join(library, 'ordinary.txt'), join(library, `link-${i}`));
    expect(() => inspectSkillLibrary(library, ['missing'])).toThrow(
      /exceeds 1024 files/,
    );
    const { plugin } = authorReview();
    write(
      plugin,
      `${Array.from({ length: 18 }, () => 'deep').join('/')}/asset.txt`,
      'asset',
    );
    expect(() => skillExperiencePackageDigest(plugin)).toThrow(
      /16 directory levels/,
    );
    const large = authorReview().plugin;
    for (let i = 0; i < 9; i++)
      write(large, `assets/${i}.txt`, 'x'.repeat(1024 * 1024));
    expect(() => skillExperiencePackageDigest(large)).toThrow(/8 MiB/);
  });
});
