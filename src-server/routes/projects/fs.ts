import { readdir, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { Hono } from 'hono';
import { fileTreeOps } from '../../telemetry/metrics.js';
import { createLogger } from '../../utils/logger.js';
import { pathAccessFailure } from '../../utils/path-access-failure.js';
import { expandTilde } from '../../utils/paths.js';

const logger = createLogger({ name: 'fs-routes' });

/**
 * The Windows drive-listing level ("This PC"). A bare `\\` cannot be a real
 * browsable directory (on Windows it is the device-namespace prefix, where
 * `readdir` refuses it), so it can never shadow a user folder. Only the
 * win32 branch below ever interprets it; POSIX servers never emit it as a
 * `parent`, so they never need to receive it either.
 */
const WINDOWS_DRIVES_PATH = '\\';

const DRIVE_ROOT_PATTERN = /^[A-Za-z]:\\?$/;
const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** `C:\` and `C:/` are drive roots; the bare `C:` form is drive-RELATIVE
 * (the process's cwd on that drive) and must never be navigated to as a
 * root. */
function driveRoot(letter: string): string {
  return `${letter}:\\`;
}

/**
 * Navigation parent of a resolved listing path, or null when the listing is
 * the top of the hierarchy. Windows drive roots sit under the virtual drive
 * listing; a POSIX root IS the top. Everything else is plain `dirname`
 * (Windows UNC parents fall out of this and stay browsable-or-erroring like
 * any other path). `dirname` of a root returns the root itself, which is why
 * roots are matched first.
 */
function browseParentOf(platform: string, resolvedPath: string): string | null {
  if (platform === 'win32') {
    if (DRIVE_ROOT_PATTERN.test(resolvedPath)) return WINDOWS_DRIVES_PATH;
    const parent = win32.dirname(resolvedPath);
    return parent === resolvedPath ? null : parent;
  }
  if (resolvedPath === '/') return null;
  return posix.dirname(resolvedPath);
}

/**
 * A full child path for an entry: the resolved listing path plus the name,
 * joined with the listing's own separator so Windows paths stay backslash-
 * canonical (`C:\` + `Projects`, not `C:\/Projects`).
 */
function joinEntryPath(
  pathTools: typeof posix,
  resolvedPath: string,
  name: string,
): string {
  const endsWithSeparator = resolvedPath.endsWith(pathTools.sep);
  return `${endsWithSeparator ? resolvedPath : `${resolvedPath}${pathTools.sep}`}${name}`;
}

/** Drive letters that exist on this Windows host, checked in parallel. A
 * letter that errors (absent, no media, locked) is simply not listed. */
async function listWindowsDrives(): Promise<string[]> {
  const drives = await Promise.all(
    DRIVE_LETTERS.map(async (letter) => {
      try {
        await stat(driveRoot(letter));
        return letter;
      } catch {
        return null;
      }
    }),
  );
  return drives.filter((letter): letter is string => letter !== null);
}

export function createFsRoutes(options: { platform?: string } = {}) {
  const platform = options.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const pathTools = isWindows ? win32 : posix;

  const app = new Hono();

  app.get('/browse', async (c) => {
    try {
      const pathParam = c.req.query('path') || '~';
      fileTreeOps.add(1, { op: 'browse' });
      const expandedPath = expandTilde(pathParam);

      if (isWindows && expandedPath === WINDOWS_DRIVES_PATH) {
        const drives = await listWindowsDrives();
        return c.json({
          success: true,
          data: {
            path: WINDOWS_DRIVES_PATH,
            label: 'This PC',
            selectable: false,
            parent: null,
            entries: drives.map((letter) => ({
              name: `${letter}:`,
              path: driveRoot(letter),
              isDirectory: true,
            })),
          },
        });
      }

      const resolvedPath = pathTools.resolve(expandedPath);
      const entries = await readdir(resolvedPath, { withFileTypes: true });
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: joinEntryPath(pathTools, resolvedPath, entry.name),
          isDirectory: true,
        }))
        .sort((a, b) => {
          const aStartsWithDot = a.name.startsWith('.');
          const bStartsWithDot = b.name.startsWith('.');
          if (aStartsWithDot !== bStartsWithDot) {
            return aStartsWithDot ? 1 : -1;
          }
          return a.name.localeCompare(b.name);
        });

      return c.json({
        success: true,
        data: {
          path: resolvedPath,
          parent: browseParentOf(platform, resolvedPath),
          selectable: true,
          entries: directories,
        },
      });
    } catch (error: unknown) {
      // This is the project-creation folder picker, so it is on the first-run
      // path: the message here is the whole diagnosis a new user gets.
      const failure = pathAccessFailure(error, 'Folder');
      if (failure.status === 500) {
        logger.error('Directory browse failed', {
          error: error instanceof Error ? error.message : 'non-Error thrown',
        });
      }
      return c.json({ success: false, error: failure.error }, failure.status);
    }
  });

  return app;
}
