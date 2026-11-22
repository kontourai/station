/**
 * Name planning for the Codex import dialog: which rows need a new name, the
 * first free name to suggest, and what is wrong with a name the person typed.
 *
 * Names are compared without regard to case, because a skill is a folder and
 * a Mac's file system treats `Changelog` and `changelog` as the same folder.
 */
import {
  isSafeSkillName,
  SETUP_IMPORT_MAX_TARGET_NAME_LENGTH,
} from '@kontourai/station-shared/setup-import-bounds';

/** Why a row cannot keep the name its prompt file gives it. */
type NameClash = 'existing' | 'duplicate';

interface PlannedName {
  /** The name the row starts with: the prompt's own, or the first free one. */
  suggested: string;
  clash?: NameClash;
}

interface ImportEntry {
  id: string;
  skillName: string;
  /** The server's statement that a skill with this exact name exists. */
  collision: boolean;
}

const fold = (name: string) => name.toLowerCase();

function firstFreeName(base: string, taken: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? '-codex' : `-codex-${index}`;
    const candidate = `${base.slice(
      0,
      SETUP_IMPORT_MAX_TARGET_NAME_LENGTH - suffix.length,
    )}${suffix}`;
    if (!taken.has(fold(candidate))) return candidate;
  }
}

/**
 * One suggestion per row, never repeating an existing skill's name or another
 * row's suggestion. Every row that shares a name with another row is marked,
 * so each of them can be renamed, not only the later ones.
 */
export function planImportNames(
  entries: readonly ImportEntry[],
  existingSkillNames: readonly string[],
): Map<string, PlannedName> {
  const existing = new Set(existingSkillNames.map(fold));
  const occurrences = new Map<string, number>();
  for (const entry of entries) {
    const key = fold(entry.skillName);
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }
  const taken = new Set(existing);
  const plan = new Map<string, PlannedName>();
  for (const entry of entries) {
    const key = fold(entry.skillName);
    const clash: NameClash | undefined =
      entry.collision || existing.has(key)
        ? 'existing'
        : (occurrences.get(key) ?? 0) > 1
          ? 'duplicate'
          : undefined;
    const suggested = taken.has(key)
      ? firstFreeName(entry.skillName, taken)
      : entry.skillName;
    taken.add(fold(suggested));
    plan.set(entry.id, clash ? { suggested, clash } : { suggested });
  }
  return plan;
}

/**
 * What is wrong with a chosen name, in the person's words, or nothing.
 * `others` are the names the other selected rows will use.
 */
export function importNameProblem(
  name: string,
  existingSkillNames: readonly string[],
  others: readonly string[],
): string | undefined {
  if (name.trim() === '') return 'Type a name, or untick to skip this prompt.';
  if (name.length > SETUP_IMPORT_MAX_TARGET_NAME_LENGTH)
    return `Use a name of ${SETUP_IMPORT_MAX_TARGET_NAME_LENGTH} characters or fewer.`;
  if (!isSafeSkillName(name))
    return /[/\\]|\.\./.test(name) || name === '.'
      ? 'Choose a name without slashes or "..".'
      : 'Station keeps this name for itself. Choose another.';
  const key = fold(name);
  const taken = existingSkillNames.find((skill) => fold(skill) === key);
  if (taken !== undefined) return `You already have a skill called “${taken}”.`;
  if (others.some((other) => fold(other) === key))
    return 'Another selected prompt uses this name.';
  return undefined;
}
