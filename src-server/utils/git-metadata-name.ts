/**
 * Whether a single path component is one git — or the filesystem under it —
 * may resolve as the repository directory `.git`. The one matcher for every
 * Station path that must keep git metadata out (plugin publish snapshots,
 * dependency copies, declared dependency paths).
 */

/**
 * Code points HFS+ ignores when comparing names, so `.g` + U+200C + `it` IS
 * `.git` on such a volume. This includes exactly the set git itself skips in
 * `next_hfs_char` (git/git `utf8.c`, used by `is_hfs_dotgit`): U+200C–U+200F,
 * U+202A–U+202E, U+206A–U+206F and U+FEFF. It also keeps U+200B and
 * U+2060–U+2064, which the publish snapshot already treated as ignorable.
 * Matching too many only leaves an oddly named entry out.
 */
const IGNORABLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x206a, 0x206f],
  [0xfeff, 0xfeff],
];

function isIgnorable(code: number): boolean {
  return IGNORABLE_RANGES.some(([low, high]) => code >= low && code <= high);
}

/** `name` with every HFS+-ignorable code point removed. */
export function stripHfsIgnorable(name: string): string {
  return Array.from(name)
    .filter((character) => !isIgnorable(character.codePointAt(0) ?? 0))
    .join('');
}

/**
 * True for `.git` in any case, with HFS+-ignorable code points anywhere or
 * trailing dots and spaces (Win32 strips those), and for its NTFS 8.3 short
 * name `git~1` (git's `is_ntfs_dotgit` treats both as `.git`).
 */
export function isGitMetadataName(name: string): boolean {
  const folded = stripHfsIgnorable(name)
    .replace(/[. ]+$/, '')
    .toLowerCase();
  return folded === '.git' || folded === 'git~1';
}

/**
 * True for a final path component a git-aware tool may read as a repository:
 * one ending in `.git` under the same folding as {@link isGitMetadataName}
 * (`repo.git`, `repo.GIT.`, HFS+-ignorable spellings), or one that IS `.git`
 * (`git~1` included).
 */
export function endsAsGitName(name: string): boolean {
  return (
    /\.git[. ]*$/i.test(stripHfsIgnorable(name)) || isGitMetadataName(name)
  );
}
