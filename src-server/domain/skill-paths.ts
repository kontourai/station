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
import { lstatSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
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

/**
 * A project slug is ONE path segment, refused here rather than joined.
 *
 * The same rule a skill name follows, for the same reason: `skillsRootDir`
 * joins this straight into a path, so `..` collapsed the root back to
 * `<home>/skills` and a write labelled project-scoped landed in the machine
 * root — silently, which is worse than the throw a separator produced (delta
 * review F5). Both now refuse for the same stated reason.
 *
 * An absent or empty slug is not a slug: it means "no project scope", which is
 * what every unscoped caller passes.
 */
export function assertSafeProjectSlug(projectSlug: string): void {
  if (!isSafeSkillName(projectSlug)) {
    throw new Error(
      `Invalid project slug ${JSON.stringify(projectSlug)}: it must be a single path segment and must not be '__proto__', 'constructor' or 'prototype'`,
    );
  }
}

/** The directory that holds this Station's (or project's) skill packages. */
export function skillsRootDir(
  projectHomeDir: string,
  projectSlug?: string,
): string {
  if (!projectSlug) return join(projectHomeDir, 'skills');
  assertSafeProjectSlug(projectSlug);
  return join(projectHomeDir, 'projects', projectSlug, 'skills');
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
 * Does this path component exist AS A COMPONENT — link-aware?
 *
 * `existsSync` follows symlinks, so a DANGLING one reports false and the walk
 * below climbs straight past it, resolving as if the redirect were not there
 * (delta review F3). `lstatSync` answers about the entry itself, which is what
 * "is there something here" has to mean when the something may be a link.
 */
function componentExists(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    // ONLY a missing path is absent. Catching every error made an unreadable
    // or looping component read as "not there", so the walk climbed past it
    // and the verdict was accept — while the comment in
    // `isDirectoryPhysicallyWithin` promised the opposite ("I could not tell"
    // must never read as "yes"). Constructed by the reviewer: a home at mode
    // 000 holding a live symlink out of the home was accepted by both seams,
    // and only the same permission failure that hid the redirect stopped the
    // write. A present-but-unanswerable component is PRESENT, which makes the
    // resolution below fail and the caller refuse (delta review 3, M1).
    return !componentIsMissing(error);
  }
}

/**
 * Is this error "there is nothing here", as opposed to "I cannot tell"?
 *
 * `ENOENT` is the path itself being absent; `ENOTDIR` is an ancestor that is
 * not a directory, which makes everything below it absent for the same reason.
 * Anything else — a permission denial, a symlink loop, an I/O error — means the
 * component may well be there and this process cannot see it.
 */
function componentIsMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * The deepest ancestor of `target` that exists on disk, `target` itself
 * included. A skill directory usually does NOT exist yet at create time, so
 * there is nothing to resolve links through — the nearest existing ancestor is
 * what a write would actually land under.
 */
function nearestExistingAncestor(target: string): string {
  let candidate = resolve(target);
  while (!componentExists(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

/**
 * `target` as it PHYSICALLY is: the deepest existing ancestor resolved through
 * symlinks, with the not-yet-created remainder appended.
 *
 * `realpathSync` alone cannot answer for a directory that does not exist yet,
 * which is every package a create is about to make, and comparing an
 * unresolved path against a resolved one is how a redirect hides (see
 * `assertSkillPackageDirectory`).
 *
 * A component that exists but CANNOT be resolved — a dangling symlink — is not
 * the same as one that is absent, and returning the lexical path for it is a
 * fail-open: the redirect vanishes and the shape reads as an ordinary root
 * (delta review F3). `null` says "this cannot be answered", and every caller
 * treats that as a refusal rather than as an answer.
 *
 * `resolve()` normalises `..` LEXICALLY, while a real traversal would resolve
 * each component in turn — the two diverge across a symlink. Every case that
 * can be constructed here fails closed (the normalised path is what is then
 * checked for containment and shape, and a redirected component is caught by
 * the resolution above), and no production caller supplies such a string; this
 * is recorded as a property rather than defended against twice.
 */
function physicalPath(target: string): string | null {
  const resolved = resolve(target);
  const existing = nearestExistingAncestor(resolved);
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    return null;
  }
  const remainder = relative(existing, resolved);
  return remainder ? join(real, remainder) : real;
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
 * A root that does not exist YET is not a failure: nothing has been aliased if
 * nothing is there, and the lexical check is the whole answer. A root that
 * exists and cannot be RESOLVED is a different fact — a dangling symlink — and
 * conflating the two accepted it, with the redirect invisible because the walk
 * had already climbed past the link (delta review F3). "Absent" is answered by
 * a link-aware probe; anything else is refused.
 */
export function isDirectoryPhysicallyWithin(
  root: string,
  candidate: string,
): boolean {
  return directoryContainmentVerdict(root, candidate) === 'within';
}

/**
 * The same question with its THIRD answer kept: is `candidate` inside `root`,
 * outside it, or unanswerable?
 *
 * Both non-`within` answers refuse, but they are not the same fact and a caller
 * that reports them as one accuses the user's skill name of something the
 * filesystem did. A home that cannot be read, holding an ordinary real skills
 * root, said "it resolves outside" — nothing resolved outside anything; the
 * walk could not read (delta review 4, M3).
 */
export type DirectoryContainmentVerdict = 'within' | 'outside' | 'unanswerable';

export function directoryContainmentVerdict(
  root: string,
  candidate: string,
): DirectoryContainmentVerdict {
  if (!isDirectoryWithin(root, candidate)) return 'outside';
  const resolvedRoot = resolve(root);
  let realRoot: string;
  try {
    realRoot = realpathSync(resolvedRoot);
  } catch {
    // Absent is an answer; unreadable is not. A root that is simply not there
    // yet leaves the lexical containment above as the whole answer; a dangling
    // link, an unreadable ancestor or a loop leaves this unable to say where a
    // write would land — and "I could not tell" must never read as "yes".
    return componentExists(resolvedRoot) ? 'unanswerable' : 'within';
  }
  try {
    const realTarget = realpathSync(nearestExistingAncestor(candidate));
    // The ancestor may BE the root itself, which is inside itself for this
    // purpose: the skill directory below it has simply not been created.
    return realTarget === realRoot || isDirectoryWithin(realRoot, realTarget)
      ? 'within'
      : 'outside';
  } catch {
    return 'unanswerable';
  }
}

/**
 * Re-assert, for a package directory that did NOT come from
 * `resolveSkillDirectory`, everything that resolver guarantees.
 *
 * The write path resolves a package's directory from where DISCOVERY found it
 * rather than from a name plus a project slug no route can supply (#1619). That
 * moves the derivation off this module, so the guarantees have to move with it
 * or they are simply gone: the name is still a single safe path segment, the
 * directory is still that name inside a `skills` root, and the root is still
 * physically inside the home Station owns — the same containment
 * `resolveSkillDirectory` asserts, checked here on a directory somebody else
 * derived.
 *
 * It does NOT decide whether Station may write a package (a canonical
 * package's root is elsewhere and fails the containment check, but a plugin's
 * may not): that is `SkillService.isSkillWritable`'s question, and this is the
 * floor beneath it.
 */
/**
 * WHY a directory is not the package for a name — every condition that holds,
 * not just the first.
 *
 * `assertSkillPackageDirectory` is this same evaluation as a throw, and takes
 * the FIRST failure in the order below so its message never changes. Callers
 * that must tell the conditions apart read the report instead, and are free to
 * order them differently: a caller publishing a REMEDY cares that the package
 * sits in the wrong root before it cares what the directory is called, because
 * "rename it" is unfollowable advice for a package in a root Station will never
 * write. One evaluation, two precedences — deriving the conditions twice is how
 * two callers end up disagreeing about the same directory.
 */
export type SkillPackageDirectoryCondition =
  /** The NAME cannot be a directory name at all. */
  | 'unsafe-name'
  /** The directory exists and is fine, but is not named for this skill. */
  | 'name-mismatch'
  /**
   * Where a write would land could not be determined — a dangling link, an
   * unreadable ancestor, a loop. NOT the same as sitting outside a writable
   * root, and its remedy is not an install: the path is broken, and it may well
   * be broken INSIDE a root Station writes.
   */
  | 'unreadable'
  /** It resolves somewhere Station does not write. */
  | 'outside-writable-root';

export interface SkillPackageDirectoryReport {
  /**
   * Each condition that holds, ONCE, in the order first met. Empty means the
   * directory is this name's package.
   *
   * Deduplicated because several checks can raise the same condition — three
   * separate ones can each mean "resolves somewhere Station does not write" —
   * and a caller reading this as a set should not have to care how many times a
   * condition was reached.
   */
  conditions: SkillPackageDirectoryCondition[];
  /** What `assertSkillPackageDirectory` throws: the first failure's message. */
  message?: string;
}

/**
 * EVERY check runs, deliberately — this no longer returns at the first failure.
 *
 * A traded property, recorded rather than absorbed (review L5): the previous
 * shape refused an unsafe name before touching the filesystem, and a name
 * mismatch before resolving containment. It cannot short-circuit now, because
 * the caller that picks WHICH refusal to speak about needs to know whether the
 * other conditions hold — the ordering is a claim about remedies, and a remedy
 * cannot be chosen from a condition set that stopped being collected early.
 *
 * What that costs: the listing evaluates containment for every row rather than
 * skipping rows that fail earlier, so the work is bounded by rows rather than by
 * rows-that-get-that-far. Both calls are `realpathSync` on paths already being
 * `stat`ed by discovery. What it does NOT open: nothing here is reachable
 * without a package already discovered under the caller's own home, so the
 * inputs are the same-user filesystem the caller already reads.
 *
 * If this ever needs to short-circuit again, the fix is to make the caller ask
 * for one condition rather than to make this function guess which one it wants.
 */
export function skillPackageDirectoryReport(
  projectHomeDir: string,
  name: string,
  directory: string,
): SkillPackageDirectoryReport {
  const found: Array<{
    condition: SkillPackageDirectoryCondition;
    message: string;
  }> = [];
  try {
    assertSafeSkillName(name);
  } catch (error) {
    found.push({
      condition: 'unsafe-name',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const resolved = resolve(directory);
  if (basename(resolved) !== name) {
    found.push({
      condition: 'name-mismatch',
      message: `Skill directory ${JSON.stringify(directory)} is not the package for ${JSON.stringify(name)}`,
    });
  }
  const homeVerdict = directoryContainmentVerdict(projectHomeDir, resolved);
  if (homeVerdict === 'unanswerable') {
    found.push({
      condition: 'unreadable',
      message: `Skill directory ${JSON.stringify(directory)} could not be read, so where a write would land is unknown`,
    });
  }
  if (homeVerdict === 'outside') {
    found.push({
      condition: 'outside-writable-root',
      message: `Skill directory ${JSON.stringify(directory)} resolves outside ${projectHomeDir}`,
    });
  }
  const rest = skillPackageRootConditions(projectHomeDir, directory, resolved);
  found.push(...rest);
  return {
    conditions: [...new Set(found.map((entry) => entry.condition))],
    ...(found.length > 0 ? { message: found[0].message } : {}),
  };
}

export function assertSkillPackageDirectory(
  projectHomeDir: string,
  name: string,
  directory: string,
): void {
  const report = skillPackageDirectoryReport(projectHomeDir, name, directory);
  // On the CONDITIONS, not on whether the message is a non-empty string. This
  // is the enforcement path, and a truthiness test standing in for a presence
  // test is the one shape in which it and the projection could disagree about
  // whether a write is refused at all rather than about why (review L2). A
  // condition whose message was ever empty would be silently admitted here and
  // refused there.
  if (report.conditions.length > 0) {
    throw new Error(
      report.message ??
        `Skill directory ${JSON.stringify(directory)} is not the package for ${JSON.stringify(name)}`,
    );
  }
}

function skillPackageRootConditions(
  projectHomeDir: string,
  directory: string,
  resolved: string,
): Array<{ condition: SkillPackageDirectoryCondition; message: string }> {
  const found: Array<{
    condition: SkillPackageDirectoryCondition;
    message: string;
  }> = [];
  // A WRITABLE skills root, named exactly: `<home>/skills` or
  // `<home>/projects/<slug>/skills`, which are the two roots `skillsRootDir`
  // builds and the two `deriveOrigin` reads as `user` and `project`. "Its
  // parent happens to be called skills" is not the same statement and admits
  // `<home>/plugins/<ns>/skills/<name>` — a root Station serves from and must
  // never write to.
  //
  // THE SHAPE IS READ OFF THE PHYSICAL PATHS, root resolved FIRST. Reading it
  // off the unresolved path let the ROOT ITSELF be the redirect: with
  // `<home>/skills` symlinked to `<home>/plugins/<ns>/skills`, the lexical
  // parent still reads `skills` while every write lands in the plugin's root —
  // and the containment check below could not see it either, because resolving
  // both sides put the whole comparison in redirected space (delta review,
  // executed: a write landed there and a delete emptied it). Refusal now
  // extends to any redirect that stays inside the home, which is every
  // read-only root Station serves.
  const root = dirname(resolved);
  const physicalHome = physicalPath(projectHomeDir);
  const physicalRoot = physicalPath(root);
  const parent =
    physicalHome === null || physicalRoot === null
      ? null
      : relative(physicalHome, physicalRoot).split(sep).join('/');
  const inWritableRoot =
    parent !== null &&
    (parent === 'skills' || /^projects\/[^/]+\/skills$/.test(parent));
  if (!inWritableRoot) {
    found.push({
      condition: 'outside-writable-root',
      message: `Skill directory ${JSON.stringify(directory)} does not sit in a skills root Station writes (${projectHomeDir}/skills or ${projectHomeDir}/projects/<project>/skills)`,
    });
  }
  // …and PHYSICALLY inside that root, which the checks above do not compose
  // into: a package directory that is a symlink redirecting elsewhere inside
  // the home — `<home>/skills/<name>` pointing at `<home>/somewhere-else` —
  // satisfies both while every write lands outside the roots.
  // `resolveSkillDirectory` made exactly this call against `skillsRootDir(...)`
  // and refused it (`skill-paths.test.ts` pins that refusal); moving the
  // derivation must not drop the guarantee that came with it (review H2).
  const rootVerdict = directoryContainmentVerdict(root, resolved);
  if (rootVerdict === 'unanswerable') {
    found.push({
      condition: 'unreadable',
      message: `Skill directory ${JSON.stringify(directory)} could not be read, so where a write would land is unknown`,
    });
  }
  if (rootVerdict === 'outside') {
    found.push({
      condition: 'outside-writable-root',
      message: `Skill directory ${JSON.stringify(directory)} resolves outside ${root}`,
    });
  }
  return found;
}

/**
 * THE one place a skill NAME becomes a directory.
 *
 * Every writer that starts from a name resolves through this — local create,
 * registry install, and the conditional setup-import seams — so a name can
 * never reach a filesystem join without having been refused first. Review
 * delta-2 finding (a): `installSkill` forwarded an unchecked registry id into
 * `cp(join(root, id), join(targetDir, id))`, so `../candidate` selected a
 * directory beside the registry root and copied outside `<home>/skills`.
 *
 * A writer that starts from a DISCOVERED package resolves its directory from
 * the registry instead (#1619) and asserts the same guarantees through
 * `assertSkillPackageDirectory` above; this stays the derivation for everything
 * that has only a name.
 */
export function resolveSkillDirectory(
  projectHomeDir: string,
  name: string,
  projectSlug?: string,
): string {
  assertSafeSkillName(name);
  const root = skillsRootDir(projectHomeDir, projectSlug);
  const directory = join(root, name);
  const verdict = directoryContainmentVerdict(root, directory);
  if (verdict === 'unanswerable') {
    throw new Error(
      `Cannot resolve a skill directory under ${root}: it exists but could not be read`,
    );
  }
  if (verdict === 'outside') {
    throw new Error(
      `Invalid skill name ${JSON.stringify(name)}: it resolves outside ${root}`,
    );
  }
  return directory;
}
