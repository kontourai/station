import {
  chmodSync,
  existsSync,
  lstatSync,
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

/**
 * Can this process be denied by mode 000? Root cannot, and some CI images run
 * as root — there the permission fixture below denies nothing, so the case is
 * skipped rather than passing for a reason that is not the one it names.
 */
function canDenyAccess(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'skill-paths-probe-'));
  try {
    mkdirSync(join(probe, 'child'), { recursive: true });
    chmodSync(probe, 0o000);
    try {
      lstatSync(join(probe, 'child'));
      return false;
    } catch {
      return true;
    } finally {
      chmodSync(probe, 0o700);
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

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
  // answer. `resolveSkillDirectory` is the only caller that ever hands this
  // predicate an unresolvable ROOT — the package assertion resolves its root
  // from a directory the registry found, and refuses a dangling one at the
  // home-containment check on the CANDIDATE side long before the root is
  // considered. That, not the shape check, is why removing the
  // absent-versus-unreadable distinction is invisible there and visible here
  // (delta review 3, L1). This is the name-derived writer every create and
  // install uses.
  test('the write seam refuses a dangling skills root', () => {
    symlinkSync(join(outside, 'never-created'), join(home, 'skills'), 'dir');

    // Unanswerable, not "outside": the link is there and cannot be followed,
    // which is a different fact from a resolved path landing elsewhere (M3).
    expect(() => resolveSkillDirectory(home, 'alpha')).toThrow(
      /could not be read/,
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

  // Delta review 3, M1. Catching every error made an unreadable component read
  // as absent, so the walk climbed past it and both seams ACCEPTED a home whose
  // permissions hid a live redirect out of the home — the very conflation the
  // containment comment says must not happen. Only the same permission failure
  // that hid the redirect stopped the write.
  //
  // Skipped where the process can read through mode 000 (running as root, as
  // some CI images do), because there the fixture cannot deny anything and a
  // green would prove nothing. The loop-at-home case below covers the same
  // branch at the resolver without depending on that; this one covers both
  // seams.
  test.skipIf(!canDenyAccess())(
    'refuses a root whose ancestor cannot be read',
    () => {
      symlinkSync(outside, join(home, 'skills'), 'dir');
      chmodSync(home, 0o000);
      try {
        // Its OWN message: nothing resolved outside anything, the walk could
        // not read, and reporting that as a containment fact accuses the
        // user's skill name of something the filesystem did (delta review 4,
        // M3).
        expect(() =>
          assertSkillPackageDirectory(
            home,
            'alpha',
            join(home, 'skills', 'alpha'),
          ),
        ).toThrow(/could not be read/);
        expect(() => resolveSkillDirectory(home, 'alpha')).toThrow(
          /could not be read/,
        );
      } finally {
        chmodSync(home, 0o700);
      }
    },
  );

  // The same branch WITHOUT permissions, at the seam where it is observable.
  //
  // An earlier version of this put the loop at `<home>/skills` and claimed to
  // cover the same branch: it did not. `lstat` does not follow a FINAL
  // symlink, so the catch never ran and both versions refused for another
  // reason — verified by restoring the catch-all, where it stayed green
  // (delta review 4, M2). The loop has to sit where the path is TRAVERSED, so
  // the home itself is the cycle and `lstat` on anything beneath it throws
  // `ELOOP`. Under the catch-all that read as "nothing is there" and the
  // resolver returned a path; it refuses now.
  //
  // The resolver is the seam: the package assertion refuses this shape either
  // way, at the home-containment check on the candidate side.
  test('refuses a home that cannot be traversed', () => {
    const cycleHome = join(outside, 'cycle-a');
    symlinkSync(join(outside, 'cycle-b'), cycleHome, 'dir');
    symlinkSync(cycleHome, join(outside, 'cycle-b'), 'dir');

    expect(() => resolveSkillDirectory(cycleHome, 'alpha')).toThrow(
      /could not be read/,
    );
  });

  test.skipIf(!canDenyAccess())(
    'an unreadable home is not reported as a containment failure',
    () => {
      // The shape M3 names: an ordinary REAL skills root under a home that
      // cannot be read. Refusing is right; blaming the name is not.
      mkdirSync(join(home, 'skills', 'alpha'), { recursive: true });
      chmodSync(home, 0o000);
      try {
        expect(() => resolveSkillDirectory(home, 'alpha')).toThrow(
          /could not be read/,
        );
        expect(() => resolveSkillDirectory(home, 'alpha')).not.toThrow(
          /resolves outside/,
        );
      } finally {
        chmodSync(home, 0o700);
      }
    },
  );

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
