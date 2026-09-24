/**
 * Whether a session's directory IS its project's checkout — the directory the
 * file preview reads. A `~/` project path matches the absolute cwd it expands
 * to. Unknown either way is not a mismatch.
 */
export function sessionRunsInProjectDirectory(
  cwd: string | null | undefined,
  projectDirectory: string | null | undefined,
): boolean {
  if (!cwd || !projectDirectory) return true;
  const a = cwd.replace(/\/+$/, '');
  const b = projectDirectory.replace(/\/+$/, '');
  return a === b || (b.startsWith('~/') && a.endsWith(b.slice(1)));
}
