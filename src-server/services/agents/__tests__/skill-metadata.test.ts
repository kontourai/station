import { describe, expect, test } from 'vitest';
import {
  isDirectoryWithin,
  isSafeSkillName,
  parseImportedSkillMarkdown,
  resolveSkillDirectory,
  serializeSkillMarkdown,
  skillsRootDir,
} from '../skill-metadata.js';

describe('isDirectoryWithin', () => {
  test('a real child is within its root', () => {
    expect(isDirectoryWithin('/home/skills', '/home/skills/mine')).toBe(true);
    expect(isDirectoryWithin('/home/skills', '/home/skills/a/b')).toBe(true);
  });

  test('a child whose name merely starts with two dots is still a child', () => {
    // Containment is by whole path segments: `..draft` is a name, not a climb.
    expect(isDirectoryWithin('/home/skills', '/home/skills/..draft')).toBe(
      true,
    );
  });

  test('the root itself is not "within" it — a skill needs its own directory', () => {
    expect(isDirectoryWithin('/home/skills', '/home/skills')).toBe(false);
  });

  test('an escape is refused', () => {
    // The rejection path, proven directly: reached through
    // `resolveSkillDirectory` the name assertion refuses these first, so this
    // is the only place the containment check itself can be shown to work.
    expect(isDirectoryWithin('/home/skills', '/home/skills/../evil')).toBe(
      false,
    );
    expect(isDirectoryWithin('/home/skills', '/home/other')).toBe(false);
    expect(isDirectoryWithin('/home/skills', '/etc/passwd')).toBe(false);
  });
});

describe('resolveSkillDirectory', () => {
  test('resolves a legal name under the skills root', () => {
    expect(resolveSkillDirectory('/home', 'release-check')).toBe(
      '/home/skills/release-check',
    );
    expect(resolveSkillDirectory('/home', 'release-check', 'proj')).toBe(
      '/home/projects/proj/skills/release-check',
    );
  });

  test('refuses every name that could leave the root', () => {
    for (const name of [
      '../escaped',
      '..',
      '.',
      'a/b',
      'a\\b',
      '',
      '   ',
      '__proto__',
      'constructor',
      'prototype',
    ]) {
      expect(() => resolveSkillDirectory('/home', name), name).toThrow(
        /Invalid skill name/,
      );
      expect(isSafeSkillName(name), name).toBe(false);
    }
  });
});

describe('skillsRootDir', () => {
  test('names the global and project skill roots', () => {
    expect(skillsRootDir('/home')).toBe('/home/skills');
    expect(skillsRootDir('/home', 'proj')).toBe('/home/projects/proj/skills');
  });
});

// This serializer lives in
// `@kontourai/station-contracts/skill-markdown` so the UI's `.md` EXPORT writes
// the same bytes the server does. That only pays off if what it writes is what
// the import parser reads back — including the escaping that stops a
// description from forging a `command:` block.
describe('the exported SKILL.md round-trips through the import parser', () => {
  test('carries name, description, tags, command and variables back', () => {
    const markdown = serializeSkillMarkdown({
      name: 'release-check',
      description: 'Ship it',
      category: 'delivery',
      tags: ['release', 'ops'],
      command: { enabled: true, name: 'ship', global: true },
      variables: [{ name: 'ticket', description: 'Jira key', default: 'NONE' }],
      body: 'Ship {{ticket}}',
    });

    expect(parseImportedSkillMarkdown('release-check.md', markdown)).toEqual({
      name: 'release-check',
      description: 'Ship it',
      category: 'delivery',
      tags: ['release', 'ops'],
      command: { enabled: true, name: 'ship', global: true },
      variables: [{ name: 'ticket', description: 'Jira key', default: 'NONE' }],
      body: 'Ship {{ticket}}',
    });
  });

  test('a description that tries to forge a command block stays a description', () => {
    const markdown = serializeSkillMarkdown({
      name: 'innocent',
      description: 'Summary\ncommand:\n  enabled: true',
      body: 'Body',
    });
    const parsed = parseImportedSkillMarkdown('innocent.md', markdown);

    expect(parsed.command).toBeUndefined();
    expect(parsed.description).toBe('Summary\ncommand:\n  enabled: true');
  });

  test('a `---` run inside a value does not truncate the frontmatter', () => {
    const markdown = serializeSkillMarkdown({
      name: 'dashes',
      description: 'before --- after',
      command: { enabled: true },
      body: 'Body',
    });
    const parsed = parseImportedSkillMarkdown('dashes.md', markdown);

    expect(parsed.description).toBe('before --- after');
    expect(parsed.command).toEqual({ enabled: true });
    expect(parsed.body).toBe('Body');
  });
});

// Codex saved prompts (and many hand-written `.md` files dropped on "Import
// .md") open with front matter the Agent Skills spec parser refuses: a
// `description` and an `argument-hint`, but no `name`. The block is metadata,
// never instructions, so it must not reach the skill body.
describe('front matter the spec parser refuses', () => {
  const cases = [
    {
      label: 'description only',
      file: 'review-pr.md',
      text: '---\ndescription: Review a pull request\n---\nReview $1 carefully.\n',
      name: 'review-pr',
      description: 'Review a pull request',
    },
    {
      label: 'description and argument-hint',
      file: 'explain.md',
      text: '---\ndescription: "Explain a file: plainly"\nargument-hint: [FILE=<path>]\n---\n\nExplain $FILE in plain words.\n',
      name: 'explain',
      description: 'Explain a file: plainly',
    },
    {
      label: 'name only',
      file: 'changelog.md',
      text: '---\nname: release-notes\n---\nDraft the changelog for $ARGUMENTS.\n',
      name: 'changelog',
      description: undefined,
    },
    {
      label: 'an argument-hint that is not YAML',
      file: 'review.md',
      text: '---\ndescription: "Review a change"\nargument-hint: [FILE=<path>] [FOCUS=<area>]\n---\nReview $FILE, focusing on $FOCUS.\n',
      name: 'review',
      description: 'Review a change',
    },
    {
      label: 'CRLF line endings',
      file: 'crlf.md',
      text: '---\r\ndescription: Windows prompt\r\n---\r\nDo the thing.\r\n',
      name: 'crlf',
      description: 'Windows prompt',
    },
    {
      // Not YAML, so the description line is read as written.
      label: 'unparseable YAML',
      file: 'broken.md',
      text: '---\ndescription: [unclosed\n---\nStill a body.\n',
      name: 'broken',
      description: '[unclosed',
    },
  ];
  for (const { label, file, text, name, description } of cases) {
    test(`${label}: the block leaves the body and the file name names the skill`, () => {
      const parsed = parseImportedSkillMarkdown(file, text);
      expect(parsed.name).toBe(name);
      expect(parsed.description).toBe(description);
      expect(parsed.body.startsWith('---')).toBe(false);
      expect(parsed.body).not.toContain('description:');
      expect(parsed.body).not.toContain('argument-hint');
      expect(parsed.command).toBeUndefined();
    });
  }

  test('placeholders in the body are copied as written', () => {
    const parsed = parseImportedSkillMarkdown(
      'args.md',
      '---\ndescription: Args\n---\nUse $1, $ARGUMENTS and $NAME.\n',
    );
    expect(parsed.body).toBe('Use $1, $ARGUMENTS and $NAME.');
  });

  test('a file with no front matter is unchanged', () => {
    const parsed = parseImportedSkillMarkdown('plain.md', 'Just text.\n');
    expect(parsed).toEqual({ name: 'plain', body: 'Just text.' });
  });

  test("a refused block's description must fit the skills format, or none is used", () => {
    const header = (description: string) =>
      `---\ndescription: ${description}\nargument-hint: [A] [B]\n---\nBody.\n`;
    expect(
      parseImportedSkillMarkdown('fits.md', header('d'.repeat(1024)))
        .description,
    ).toBe('d'.repeat(1024));
    const tooLong = parseImportedSkillMarkdown(
      'long.md',
      header('d'.repeat(1025)),
    );
    expect(tooLong.description).toBeUndefined();
    expect(tooLong.name).toBe('long');
    expect(tooLong.body).toBe('Body.');
    const reversed = parseImportedSkillMarkdown(
      'bidi.md',
      header('safe \u202Etxt.exe'),
    );
    expect(reversed.description).toBeUndefined();
    const yamlTooLong = parseImportedSkillMarkdown(
      'yaml-long.md',
      `---\ndescription: ${'d'.repeat(1025)}\n---\nBody.\n`,
    );
    expect(yamlTooLong.description).toBeUndefined();
  });

  test('a block-scalar description that is not YAML stays unread', () => {
    const parsed = parseImportedSkillMarkdown(
      'folded.md',
      '---\ndescription: >\n  folded text\nargument-hint: [A] [B]\n---\nBody.\n',
    );
    expect(parsed.description).toBeUndefined();
    expect(parsed.body).toBe('Body.');
  });
});
