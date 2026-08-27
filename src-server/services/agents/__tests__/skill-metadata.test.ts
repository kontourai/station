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
