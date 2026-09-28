import { spawnSync } from 'node:child_process';

/**
 * The highest `<prefix>_x.y` symbol version an ELF object requires (for
 * example GLIBC or GLIBCXX), read with objdump. That version is the oldest
 * C library a host can run the object on. Null when objdump is unavailable,
 * cannot read the object, or the object requires no versioned symbol.
 */
export function symbolVersionFloor(artifact, prefix) {
  const result = spawnSync('objdump', ['-T', artifact], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return highestSymbolVersion(
    result.stdout.match(new RegExp(`${prefix}_[0-9.]+`, 'g')) ?? [],
  );
}

export function highestSymbolVersion(versions) {
  const unique = [...new Set(versions.filter(Boolean))];
  unique.sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
  return unique.at(-1) ?? null;
}
