import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export function assertPathInside(
  root: string,
  candidate: string,
  label: string,
): void {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (
    candidatePath !== rootPath &&
    !candidatePath.startsWith(`${rootPath}${sep}`)
  ) {
    throw new Error(`${label} escapes root`);
  }
}

export function assertExistingPathInside(
  root: string,
  candidate: string,
  label: string,
): void {
  assertPathInside(root, candidate, label);
  if (!existsSync(candidate)) return;
  const rootPath = realpathSync(root);
  const candidatePath = realpathSync(candidate);
  if (
    candidatePath !== rootPath &&
    !candidatePath.startsWith(`${rootPath}${sep}`)
  ) {
    throw new Error(`${label} escapes root`);
  }
}
