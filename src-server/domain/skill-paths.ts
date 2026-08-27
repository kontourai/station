/**
 * How a skill NAME becomes a PATH — the one seam every skill writer shares.
 *
 * This lives in `domain/` rather than beside the service that first needed it
 * because `config-loader-storage.ts` writes `skill.json` from a name too. With
 * the rule in one place that both layers can import, "the single seam" is a
 * structural fact rather than a convention each caller has to remember (review
 * delta-3, item (a)).
 *
 * Deliberately dependency-free apart from `node:fs`/`node:path`, so nothing
 * here can create an import cycle between the domain and service layers.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { SETUP_IMPORT_MAX_TARGET_NAME_LENGTH } from '@kontourai/station-shared/setup-import-bounds';

/**
 * Keys that must never be used as a skill name. `JSON.parse` yields
 * `__proto__` as an own property, but assigning to it on an ordinary object
 * hits `Object.prototype`'s accessor instead of creating one — the usage
 * counter reported a run and persisted nothing, forever.
 */
export const PROTOTYPE_AFFECTING_KEYS: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
];

/**
 * A skill name that is a single path segment, never a traversal, and never a
 * key that behaves differently from an ordinary one.
 *
 * `__proto__`/`constructor`/`prototype` are refused because a skill name is
 * also a KEY: in the usage store, assigning to `__proto__` on an ordinary
 * object hits `Object.prototype`'s accessor instead of creating a property, so
 * the counter reported a run and persisted nothing forever (review finding 6).
 * The store additionally uses null-prototype records; this refusal and that one
 * are deliberately both present, since either alone leaves the other reader
 * exposed.
 */
export function isSafeSkillName(name: string): boolean {
  return (
    name.trim() !== '' &&
    name.length <= SETUP_IMPORT_MAX_TARGET_NAME_LENGTH &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    name !== '.' &&
    !PROTOTYPE_AFFECTING_KEYS.includes(name)
  );
}

/**
 * The refusal every skill CREATE and RENAME seam shares, enforced in
 * `SkillService.createLocalSkill`/`updateLocalSkill` so no route can bypass it
 * by calling the service directly.
 *
 * Review delta finding 6: `isSafeSkillName` existed but only the import route
 * called it, so `POST /api/skills/local` happily created `__proto__` and the
 * failure surfaced later as a 500 from the usage store. A guard whose rejection
 * path one caller reaches is not a guard.
 */
export function assertSafeSkillName(name: string): void {
  if (!isSafeSkillName(name)) {
    throw new Error(
      `Invalid skill name ${JSON.stringify(name)}: it must be a single path segment and must not be '__proto__', 'constructor' or 'prototype'`,
    );
  }
}

/** The directory that holds this Station's (or project's) skill packages. */
export function skillsRootDir(
  projectHomeDir: string,
  projectSlug?: string,
): string {
  return projectSlug
    ? join(projectHomeDir, 'projects', projectSlug, 'skills')
    : join(projectHomeDir, 'skills');
}

/**
 * Is `candidate` a real child of `root` after both are resolved?
 *
 * Exported so its REJECTION path is provable on its own. Reached through
 * `resolveSkillDirectory` it is defence in depth rather than the primary
 * guard — `assertSafeSkillName` already refuses every POSIX name that could
 * escape — but path resolution is platform-specific (a Windows drive-relative
 * name like `C:x` resolves off the root while containing none of the
 * characters that assertion looks for), so the containment fact is asserted
 * rather than assumed.
 */
export function isDirectoryWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !isAbsolute(relativePath)
  );
}

/**
 * The deepest ancestor of `target` that exists on disk, `target` itself
 * included. A skill directory usually does NOT exist yet at create time, so
 * there is nothing to resolve links through — the nearest existing ancestor is
 * what a write would actually land under.
 */
function nearestExistingAncestor(target: string): string {
  let candidate = resolve(target);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

/**
 * Is `candidate` PHYSICALLY inside `root` — after following symlinks?
 *
 * `isDirectoryWithin` compares strings, which `<home>/skills/alpha ->
 * /somewhere/else` satisfies while every write to it lands outside the skills
 * root (review delta-3, HIGH). This resolves the root, and the deepest part of
 * the target that exists, through `realpathSync` before comparing.
 *
 * **Threat model, stated honestly.** Station's home belongs to the same user
 * as the Station process, so a user who wants to write outside their skills
 * root can simply do it — this is NOT a defence against a hostile same-user
 * actor, and nothing here could be. What it does defend is a skills tree that
 * has been MOVED or ALIASED: a symlinked skill directory left behind by a
 * migration, a home restored from a backup, a synced folder pointing at
 * another checkout. In those cases Station would silently write into a tree it
 * does not own and report success; refusing is the honest answer.
 *
 * An unresolvable root (it does not exist yet) is not a failure: nothing has
 * been aliased if nothing is there, and the lexical check still applies.
 */
export function isDirectoryPhysicallyWithin(
  root: string,
  candidate: string,
): boolean {
  if (!isDirectoryWithin(root, candidate)) return false;
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    // The root does not exist yet — there is no link to follow, and the
    // lexical containment above is the whole answer.
    return true;
  }
  try {
    const realTarget = realpathSync(nearestExistingAncestor(candidate));
    // The ancestor may BE the root itself, which is inside itself for this
    // purpose: the skill directory below it has simply not been created.
    return realTarget === realRoot || isDirectoryWithin(realRoot, realTarget);
  } catch {
    return false;
  }
}

/**
 * THE one place a skill name becomes a directory.
 *
 * Every writer resolves through this — local create, rename, and registry
 * install — so a name can never reach a filesystem join without having been
 * refused first. Review delta-2 finding (a): `installSkill` forwarded an
 * unchecked registry id into `cp(join(root, id), join(targetDir, id))`, so
 * `../candidate` selected a directory beside the registry root and copied
 * outside `<home>/skills`.
 */
export function resolveSkillDirectory(
  projectHomeDir: string,
  name: string,
  projectSlug?: string,
): string {
  assertSafeSkillName(name);
  const root = skillsRootDir(projectHomeDir, projectSlug);
  const directory = join(root, name);
  if (!isDirectoryPhysicallyWithin(root, directory)) {
    throw new Error(
      `Invalid skill name ${JSON.stringify(name)}: it resolves outside ${root}`,
    );
  }
  return directory;
}
