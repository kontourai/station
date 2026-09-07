import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  assertSkillPackageDirectory,
  isDirectoryPhysicallyWithin,
  isDirectoryWithin,
  resolveSkillDirectory,
  skillsRootDir,
} from '../skill-paths.js';

let home: string;
let outside: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skill-paths-'));
  outside = mkdtempSync(join(tmpdir(), 'skill-paths-outside-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('isDirectoryPhysicallyWithin', () => {
  test('a real child is inside', () => {
    mkdirSync(join(home, 'skills', 'alpha'), { recursive: true });
    expect(
      isDirectoryPhysicallyWithin(
        join(home, 'skills'),
        join(home, 'skills', 'alpha'),
      ),
    ).toBe(true);
  });

  test('a skill directory that does not exist yet is inside', () => {
    mkdirSync(join(home, 'skills'), { recursive: true });
    expect(
      isDirectoryPhysicallyWithin(
        join(home, 'skills'),
        join(home, 'skills', 'new'),
      ),
    ).toBe(true);
  });

  test('a symlink pointing out of the root is NOT inside, though it looks it', () => {
    // The exact gap: lexically `<root>/aliased` is a child, so the string
    // comparison passes while every write to it lands in `outside`.
    mkdirSync(join(home, 'skills'), { recursive: true });
    symlinkSync(outside, join(home, 'skills', 'aliased'), 'dir');

    expect(
      isDirectoryWithin(join(home, 'skills'), join(home, 'skills', 'aliased')),
    ).toBe(true);
    expect(
      isDirectoryPhysicallyWithin(
        join(home, 'skills'),
        join(home, 'skills', 'aliased'),
      ),
    ).toBe(false);
  });

  test('a symlinked ROOT is fine — the tree itself may legitimately be a link', () => {
    const realSkills = join(outside, 'real-skills');
    mkdirSync(realSkills, { recursive: true });
    mkdirSync(join(realSkills, 'alpha'), { recursive: true });
    mkdirSync(home, { recursive: true });
    symlinkSync(realSkills, join(home, 'skills'), 'dir');

    expect(
      isDirectoryPhysicallyWithin(
        join(home, 'skills'),
        join(home, 'skills', 'alpha'),
      ),
    ).toBe(true);
  });

  test('a root that does not exist yet has nothing aliased', () => {
    expect(
      isDirectoryPhysicallyWithin(
        join(home, 'skills'),
        join(home, 'skills', 'alpha'),
      ),
    ).toBe(true);
  });
});

describe('resolveSkillDirectory refuses a symlinked-out skill directory', () => {
  test('the write seam refuses it, not just the predicate', () => {
    mkdirSync(join(home, 'skills'), { recursive: true });
    symlinkSync(outside, join(home, 'skills', 'aliased'), 'dir');
    writeFileSync(join(outside, 'canary.txt'), 'untouched', 'utf-8');

    expect(() => resolveSkillDirectory(home, 'aliased')).toThrow(
      /resolves outside/,
    );
  });

  // Delta review F3, at the seam where the containment answer is the WHOLE
  // answer: `resolveSkillDirectory` has no shape check to refuse first, so a
  // root that exists and cannot be resolved reaches the containment predicate
  // directly. Treating "cannot be resolved" as "does not exist yet" accepted
  // it, and this is the name-derived writer every create and install uses.
  test('the write seam refuses a dangling skills root', () => {
    symlinkSync(join(outside, 'never-created'), join(home, 'skills'), 'dir');

    expect(() => resolveSkillDirectory(home, 'alpha')).toThrow(
      /resolves outside/,
    );
  });

  test('an ordinary name still resolves', () => {
    expect(resolveSkillDirectory(home, 'alpha')).toBe(
      join(home, 'skills', 'alpha'),
    );
  });
});

/**
 * The floor beneath every directory the write path did NOT get from
 * `resolveSkillDirectory` (#1619). Its rejection paths are what stand between a
 * caller-supplied directory and `rm -rf`, so each one is executed here rather
 * than reached through a service that happens to call it.
 */
describe('assertSkillPackageDirectory', () => {
  test('accepts a package in either root Station writes', () => {
    expect(() =>
      assertSkillPackageDirectory(home, 'alpha', join(home, 'skills', 'alpha')),
    ).not.toThrow();
    expect(() =>
      assertSkillPackageDirectory(
        home,
        'alpha',
        join(home, 'projects', 'demo', 'skills', 'alpha'),
      ),
    ).not.toThrow();
  });

  test('refuses an unsafe name, whatever directory it is handed', () => {
    for (const name of ['../escaped', 'a/b', '__proto__', '..']) {
      expect(
        () =>
          assertSkillPackageDirectory(home, name, join(home, 'skills', 'safe')),
        name,
      ).toThrow(/Invalid skill name/);
    }
  });

  test('refuses a directory that is not this package', () => {
    expect(() =>
      assertSkillPackageDirectory(home, 'alpha', join(home, 'skills', 'beta')),
    ).toThrow(/is not the package for/);
    // A case difference is a different directory on a case-sensitive
    // filesystem and the same one elsewhere; either way it is not this name.
    expect(() =>
      assertSkillPackageDirectory(home, 'alpha', join(home, 'skills', 'Alpha')),
    ).toThrow(/is not the package for/);
  });

  test('refuses a root Station serves from but does not write', () => {
    // Inside the home, with a parent literally called `skills` — which is why
    // "the parent is called skills" is not the rule.
    expect(() =>
      assertSkillPackageDirectory(
        home,
        'shipper',
        join(home, 'plugins', 'acme', 'skills', 'shipper'),
      ),
    ).toThrow(/does not sit in a skills root Station writes/);
    expect(() =>
      assertSkillPackageDirectory(
        home,
        'alpha',
        join(home, 'projects', 'demo', 'alpha'),
      ),
    ).toThrow(/does not sit in a skills root Station writes/);
  });

  test('refuses a directory outside the home', () => {
    expect(() =>
      assertSkillPackageDirectory(home, 'alpha', join(outside, 'alpha')),
    ).toThrow(/resolves outside/);
  });

  // Review H2. Containment against the HOME plus a lexical parent check do not
  // compose into "physically inside a writable root": a package directory that
  // is a symlink redirecting elsewhere INSIDE the home satisfies both while
  // every write lands outside the roots. `resolveSkillDirectory` refuses this
  // exact shape (above), and moving the derivation must not drop the guarantee.
  // Delta review, executed: with the ROOT itself symlinked, the lexical parent
  // still read `skills` and resolving both sides put the comparison in
  // redirected space — so a write landed in the plugin's root and a delete
  // emptied it. The shape is read off the physical paths now.
  test('refuses a skills root symlinked elsewhere inside the home', () => {
    const foreign = join(home, 'plugins', 'acme', 'skills');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'canary.txt'), 'untouched', 'utf-8');
    symlinkSync(foreign, join(home, 'skills'), 'dir');

    expect(() =>
      assertSkillPackageDirectory(home, 'alpha', join(home, 'skills', 'alpha')),
    ).toThrow(/does not sit in a skills root Station writes/);
    expect(existsSync(join(foreign, 'canary.txt'))).toBe(true);
  });

  test('refuses a skills root symlinked outside the home', () => {
    symlinkSync(outside, join(home, 'skills'), 'dir');

    expect(() =>
      assertSkillPackageDirectory(home, 'alpha', join(home, 'skills', 'alpha')),
    ).toThrow(/resolves outside/);
  });

  // The other direction: an ordinary root, unredirected, still resolves — the
  // refusals above must not be a blanket one.
  test('accepts a package under a root that is not redirected at all', () => {
    mkdirSync(join(home, 'skills', 'alpha'), { recursive: true });
    mkdirSync(join(home, 'projects', 'demo', 'skills', 'beta'), {
      recursive: true,
    });

    expect(() =>
      assertSkillPackageDirectory(home, 'alpha', join(home, 'skills', 'alpha')),
    ).not.toThrow();
    expect(() =>
      assertSkillPackageDirectory(
        home,
        'beta',
        join(home, 'projects', 'demo', 'skills', 'beta'),
      ),
    ).not.toThrow();
    // …including a package directory that does not exist yet, which is every
    // package a create is about to make.
    expect(() =>
      assertSkillPackageDirectory(home, 'gamma', join(home, 'skills', 'gamma')),
    ).not.toThrow();
  });

  // Delta review F3. `existsSync` follows symlinks, so a DANGLING root reported
  // false, the ancestor walk climbed straight past the link, and the shape read
  // as an ordinary skills root — accept, with the redirect invisible. The
  // containment check compounded it by treating "cannot be resolved" as "does
  // not exist yet". Nothing could exploit it (Node's recursive mkdir refuses to
  // traverse a dangling link), but the code looked like it refused and did not.
  test('refuses a skills root that is a dangling symlink', () => {
    const gone = join(outside, 'never-created');
    symlinkSync(gone, join(home, 'skills'), 'dir');
    // The probe the old walk used: the link exists, and `existsSync` says no.
    expect(existsSync(join(home, 'skills'))).toBe(false);

    expect(() =>
      assertSkillPackageDirectory(home, 'alpha', join(home, 'skills', 'alpha')),
    ).toThrow();
  });

  test('refuses a dangling symlink at the package directory itself', () => {
    mkdirSync(join(home, 'skills'), { recursive: true });
    symlinkSync(
      join(outside, 'never-created'),
      join(home, 'skills', 'alpha'),
      'dir',
    );

    expect(() =>
      assertSkillPackageDirectory(home, 'alpha', join(home, 'skills', 'alpha')),
    ).toThrow();
  });

  test('refuses a package directory symlinked elsewhere inside the home', () => {
    const elsewhere = join(home, 'not-a-skills-root');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'canary.txt'), 'untouched', 'utf-8');
    mkdirSync(join(home, 'skills'), { recursive: true });
    symlinkSync(elsewhere, join(home, 'skills', 'aliased'), 'dir');

    expect(() =>
      assertSkillPackageDirectory(
        home,
        'aliased',
        join(home, 'skills', 'aliased'),
      ),
    ).toThrow(/resolves outside/);
  });
});

/**
 * Delta review F5. `skillsRootDir` joins the slug straight into a path, so an
 * unvalidated one either threw (a separator, deep in a later check) or — worse
 * — silently redirected: `..` collapsed the root back to `<home>/skills`, and a
 * write labelled project-scoped landed in the machine root with nothing said.
 */
describe('project slugs are one path segment', () => {
  test('a traversal slug redirects nowhere: it is refused', () => {
    expect(() => resolveSkillDirectory(home, 'alpha', '..')).toThrow(
      /Invalid project slug/,
    );
    expect(() => skillsRootDir(home, '..')).toThrow(/Invalid project slug/);
  });

  test('a separator slug is refused with the same reason', () => {
    expect(() => resolveSkillDirectory(home, 'alpha', 'a/b')).toThrow(
      /Invalid project slug/,
    );
    expect(() => skillsRootDir(home, '../../etc')).toThrow(
      /Invalid project slug/,
    );
    expect(() => skillsRootDir(home, '__proto__')).toThrow(
      /Invalid project slug/,
    );
  });

  test('an ordinary slug still builds its root, and no slug means no scope', () => {
    expect(skillsRootDir(home, 'demo')).toBe(
      join(home, 'projects', 'demo', 'skills'),
    );
    expect(skillsRootDir(home)).toBe(join(home, 'skills'));
    // Empty is not a slug: it is what every unscoped caller passes.
    expect(skillsRootDir(home, '')).toBe(join(home, 'skills'));
  });
});
