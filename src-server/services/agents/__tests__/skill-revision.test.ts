import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  expectedLocalSkillRevision,
  LOCAL_SKILL_REVISION_LIMITS,
  localSkillRevisionFromDirectory,
} from '../skill-revision.js';

const roots: string[] = [];
function skillRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-revision-'));
  roots.push(root);
  writeFileSync(join(root, 'SKILL.md'), '# Skill');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('local Skill revisions', () => {
  test('frames every entry so the old folded stream collision differs', () => {
    // The previous hash saw both as the same `abcabc` byte stream.
    expect(
      expectedLocalSkillRevision([
        { type: 'file', path: 'a', content: Buffer.from('bc') },
        { type: 'file', path: 'ab', content: Buffer.from('c') },
      ]),
    ).not.toBe(
      expectedLocalSkillRevision([
        { type: 'file', path: 'a', content: Buffer.from('bcabc') },
      ]),
    );
  });

  test('commits directory shape as well as bytes', () => {
    expect(
      expectedLocalSkillRevision([
        { type: 'directory', path: 'nested' },
        { type: 'file', path: 'nested/a', content: Buffer.from('x') },
      ]),
    ).not.toBe(
      expectedLocalSkillRevision([
        { type: 'file', path: 'nested/a', content: Buffer.from('x') },
      ]),
    );
  });

  test('refuses oversized, deep, symbolic, and hardlinked trees', async () => {
    const oversized = skillRoot();
    writeFileSync(
      join(oversized, 'large'),
      Buffer.alloc(LOCAL_SKILL_REVISION_LIMITS.fileBytes + 1),
    );
    await expect(localSkillRevisionFromDirectory(oversized)).rejects.toThrow(
      'Skill revision unavailable',
    );

    const deep = skillRoot();
    let cursor = deep;
    for (
      let index = 0;
      index <= LOCAL_SKILL_REVISION_LIMITS.depth;
      index += 1
    ) {
      cursor = join(cursor, `d${index}`);
      mkdirSync(cursor);
    }
    writeFileSync(join(cursor, 'leaf'), 'x');
    await expect(localSkillRevisionFromDirectory(deep)).rejects.toThrow(
      'Skill revision unavailable',
    );

    const linked = skillRoot();
    writeFileSync(join(linked, 'source'), 'x');
    linkSync(join(linked, 'source'), join(linked, 'hardlink'));
    await expect(localSkillRevisionFromDirectory(linked)).rejects.toThrow(
      'Skill revision unavailable',
    );

    const symlinked = skillRoot();
    symlinkSync(join(symlinked, 'SKILL.md'), join(symlinked, 'link'));
    await expect(localSkillRevisionFromDirectory(symlinked)).rejects.toThrow(
      'Skill revision unavailable',
    );
  });

  test('refuses a directory substitution immediately before the first enumeration', async () => {
    const root = skillRoot();
    const parked = `${root}-original`;
    await expect(
      localSkillRevisionFromDirectory(root, {
        beforeEnumerationForTest: () => {
          renameSync(root, parked);
          mkdirSync(root);
          writeFileSync(join(root, 'SKILL.md'), '# attacker');
          writeFileSync(join(root, 'attacker'), 'attacker bytes');
        },
      }),
    ).rejects.toThrow('Skill revision unavailable');
    rmSync(root, { recursive: true, force: true });
    renameSync(parked, root);
  });

  test('refuses a child substitution between parent enumeration and child recursion', async () => {
    const root = skillRoot();
    const child = join(root, 'nested');
    const parked = `${child}-original`;
    mkdirSync(child);
    writeFileSync(join(child, 'safe'), 'safe bytes');
    await expect(
      localSkillRevisionFromDirectory(root, {
        beforeChildVisitForTest: (path) => {
          if (path !== child) return;
          renameSync(child, parked);
          mkdirSync(child);
          writeFileSync(join(child, 'attacker'), 'attacker bytes');
        },
      }),
    ).rejects.toThrow('Skill revision unavailable');
    rmSync(child, { recursive: true, force: true });
    renameSync(parked, child);
  });
});
