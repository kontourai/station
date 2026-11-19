/**
 * The repository a chat's remote task works on: the GitHub repository the
 * chat's working copy pushes to (`origin`). Station reads only the remote's
 * URL, never the working copy's contents; the vendor clones the repository
 * itself.
 */
import { execFile } from 'node:child_process';
import type { RemoteTaskRepository } from '@kontourai/station-contracts/remote-task-engine';

const PART = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * `owner/name` from a GitHub remote URL (`https://github.com/o/n(.git)`,
 * `git@github.com:o/n(.git)`, `ssh://git@github.com/o/n(.git)`); undefined
 * for any other host or shape. A segment of only dots is refused.
 */
export function githubRepositoryFromRemote(
  url: string,
): RemoteTaskRepository | undefined {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  if (!match) return undefined;
  const [owner, name] = [match[1] as string, match[2] as string];
  if (
    !PART.test(owner) ||
    !PART.test(name) ||
    /^\.+$/.test(owner) ||
    /^\.+$/.test(name)
  )
    return undefined;
  return { owner, name };
}

/** The `origin` remote of the working copy at `cwd`, as a GitHub repository. */
export function resolveRemoteTaskRepository(
  cwd: string | undefined,
): Promise<RemoteTaskRepository | undefined> {
  if (!cwd) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, 'remote', 'get-url', 'origin'],
      { timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        resolve(error ? undefined : githubRepositoryFromRemote(String(stdout)));
      },
    );
  });
}
