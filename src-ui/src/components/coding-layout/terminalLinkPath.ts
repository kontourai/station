function normalize(value: string): { drive: string; parts: string[] } | null {
  const unified = value.replace(/\\/g, '/');
  const drive = /^[A-Za-z]:\//.exec(unified)?.[0].toLowerCase() ?? '';
  const parts: string[] = [];
  for (const part of unified.slice(drive.length).split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') parts.push(part);
    else if (parts.pop() === undefined) return null;
  }
  return { drive, parts };
}

/**
 * A `path:line` a program printed, as a path relative to the terminal's
 * root, or null when it resolves outside that root. Relative paths are read
 * against the shell's live working directory, since that is what the program
 * printed them relative to. Works on POSIX and Windows paths.
 */
export function terminalLinkRelativePath(
  root: string,
  cwd: string | null,
  path: string,
): string | null {
  const absolute = /^([A-Za-z]:)?[\\/]/.test(path);
  const base = normalize(root);
  const resolved = normalize(absolute ? path : `${cwd ?? root}/${path}`);
  if (!base || !resolved || resolved.drive !== base.drive) return null;
  const inside = base.parts.every((part, i) => resolved.parts[i] === part);
  if (!inside || resolved.parts.length === base.parts.length) return null;
  return resolved.parts.slice(base.parts.length).join('/');
}
