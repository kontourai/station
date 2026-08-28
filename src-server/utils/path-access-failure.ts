/**
 * archive#3158 — one classification for "the server could not read the local
 * path you named".
 *
 * Both callers previously answered every failure with a single 404 whose text
 * named several causes at once ("Path not found or permission denied",
 * "Workspace is unavailable or inaccessible"). The distinguishing evidence —
 * the errno the filesystem already returned — was computed and then dropped,
 * so a user staring at the project-creation folder picker could not tell
 * "I typed a path that does not exist" (retype it) from "this folder is not
 * readable by Station" (fix the permissions, or pick another folder). Those
 * are different problems with different remedies.
 *
 * Only the errno decides. The thrown error's message is never forwarded: it
 * carries the absolute path, and neither route discloses one.
 */
export interface PathAccessFailure {
  error: string;
  status: 400 | 403 | 404 | 500;
}

/** What the caller asked us to read, as it should be named back to them. */
export type PathAccessSubject = 'Folder' | 'Workspace';

export function pathAccessFailure(
  error: unknown,
  subject: PathAccessSubject,
): PathAccessFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const lower = subject.toLowerCase();
  switch (code) {
    case 'ENOENT':
      return { error: `${subject} not found`, status: 404 };
    case 'EACCES':
    case 'EPERM':
      return {
        error: `Permission denied reading this ${lower}`,
        status: 403,
      };
    case 'ENOTDIR':
      return { error: 'That path is a file, not a directory', status: 400 };

    case 'ENAMETOOLONG':
      // Client-shaped, not server-shaped: a pasted over-long path is a bad
      // request. It used to fall to the default branch, answering 500 and
      // writing an error-level entry into the durable server log for what is
      // ordinary user input (archive#3158 review).
      return { error: `${subject} path is too long`, status: 400 };
    default:
      // A NUL byte in the path makes readdir throw a TypeError with
      // ERR_INVALID_ARG_VALUE — not an errno — which is client input, not a
      // server fault. Classify it as such rather than logging it as one.
      if (code === 'ERR_INVALID_ARG_VALUE') {
        return { error: `${subject} path is not valid`, status: 400 };
      }
      // Deliberately NOT another 404: an unclassified failure (EIO, ELOOP, a
      // malformed argument) is the server's problem, and saying "not found"
      // sends the user to check a path that may be perfectly fine. Callers
      // log the cause on this branch.
      return { error: `${subject} could not be read`, status: 500 };
  }
}
