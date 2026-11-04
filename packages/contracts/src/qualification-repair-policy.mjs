/** Shared by the dependency-free CI intake and the trusted Station publisher. */
export function validateRepairPaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 40)
    throw new Error('Repair must change 1–40 paths');
  const seen = new Set();
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      path.length > 240 ||
      !/^[\w./-]+$/.test(path) ||
      path
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '..' ||
            part === '.' ||
            part.toLowerCase() === '.git',
        ) ||
      seen.has(path.toLowerCase()) ||
      /^(\.github\/|\.veritas\/|\.githooks\/|\.husky\/|\.gitmodules$|AGENTS\.md$|CLAUDE\.md$|veritas\.claims\.json$)/i.test(
        path,
      ) ||
      /(^|\/)(AGENTS|CLAUDE)\.md$/i.test(path) ||
      /^scripts\/(qualification-|actionlint-gate|verification-lanes|vitest-resource-manifest|dependency-lifecycle)/i.test(
        path,
      ) ||
      /^packages\/contracts\/(package\.json$|src\/(qualification-repair|isolated-repair|automation|.*grant|.*security))/i.test(
        path,
      ) ||
      /^src-server\/(security\/|services\/(automation\/|secrets\/|environment-security\/)|routes\/(operations\/(automations|repairs)|automation|repair|security|grants)|runtime\/(automation|routes\/runtime-route)|.*repair-control)/i.test(
        path,
      ) ||
      /(^|\/)(repair-control[^/]*|[^/]*grant[^/]*|[^/]*security[^/]*)($|\/)/i.test(
        path,
      )
    )
      throw new Error(
        `Repair requires owner review for protected path: ${path}`,
      );
    seen.add(path.toLowerCase());
  }
  for (const path of paths)
    if (
      paths.some(
        (other) =>
          other !== path &&
          other.toLowerCase().startsWith(`${path.toLowerCase()}/`),
      )
    )
      throw new Error(
        'Repair paths cannot contain both a file and its descendant',
      );
}
