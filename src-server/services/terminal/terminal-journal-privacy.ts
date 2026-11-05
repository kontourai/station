/**
 * Terminal journals hold everything a shell printed, so only their owner may
 * read them (#3994). On POSIX the journal's 0700 directories and 0600 files
 * establish that. On Windows those modes set no ACL: a journal inherits its
 * location's ACL, which on a non-system drive or a shared folder commonly
 * admits Authenticated Users or Users. This establishes the same protected,
 * current-user-only DACL Station uses for its other private files
 * (`windows-path-trust`) before a journal is written, and refuses a location
 * where it cannot.
 *
 * A location Station owns (the default, or one it created) is protected once
 * and its journals inherit that. An existing folder the person chose keeps its
 * own ACL, which may cover unrelated files; each journal directory in it is
 * protected instead.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildWindowsTrustCommand,
  parseWindowsTrustResult,
  WINDOWS_TRUST_COMMAND_TIMEOUT_MS,
  windowsSystemUtilityPath,
} from '@kontourai/station-shared/windows-path-trust';

/** Runs one trust operation on directories; rejects unless it is proven. */
export type JournalAclRunner = (
  operation: 'ensure' | 'verify',
  directories: readonly string[],
) => Promise<void>;

/** The production runner: the shared trust program, off the event loop. */
const runTrustProgram: JournalAclRunner = (operation, directories) =>
  new Promise((resolve, reject) => {
    let command: string;
    try {
      command = windowsSystemUtilityPath('powershell');
    } catch (error) {
      reject(error);
      return;
    }
    execFile(
      command,
      buildWindowsTrustCommand(
        operation,
        directories.map((path) => ({ kind: 'directory' as const, path })),
      ),
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: WINDOWS_TRUST_COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        try {
          parseWindowsTrustResult(stdout);
          resolve();
        } catch (failure) {
          reject(failure);
        }
      },
    );
  });

export class TerminalHistoryLocationUnavailable extends Error {}

function unavailable(directory: string, cause: unknown) {
  return new TerminalHistoryLocationUnavailable(
    `Terminal history can't be kept private in ${directory}. Choose a folder on a drive that supports Windows permissions.`,
    { cause },
  );
}

export class TerminalJournalPrivacy {
  /** Per root: whether its journals inherit a private ACL. */
  private readonly roots = new Map<string, Promise<boolean>>();
  private readonly directories = new Map<string, Promise<void>>();

  constructor(
    /** The default location, which Station owns. */
    private readonly ownedRoot: string,
    private readonly run: JournalAclRunner = runTrustProgram,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /**
   * Creates `directory` (one journal) under `root`, private to this user,
   * before anything is written to it. Rejects when that cannot be made true.
   */
  async ensure(root: string, directory: string): Promise<void> {
    if (this.platform !== 'win32') {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return;
    }
    if (await this.privateRoot(root)) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return;
    }
    let pending = this.directories.get(directory);
    if (!pending) {
      pending = (async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        try {
          await this.run('ensure', [directory]);
        } catch (error) {
          throw unavailable(root, error);
        }
      })();
      this.directories.set(directory, pending);
      pending.catch(() => this.directories.delete(directory));
    }
    return pending;
  }

  /**
   * Protects one journal directory explicitly, whatever its location: a
   * journal moved by rename keeps the ACL it had where it was, which may
   * not be private. Creates it when absent.
   */
  async protect(root: string, directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (this.platform !== 'win32') return;
    try {
      await this.run('ensure', [directory]);
    } catch (error) {
      throw unavailable(root, error);
    }
  }

  /**
   * Null when terminal history can be kept private under `root`, or the
   * reason it can't: for a settings change, before any journal moves there.
   */
  async problem(root: string): Promise<string | null> {
    if (this.platform !== 'win32') return null;
    const probe = join(root, `.station-history-probe-${randomUUID()}`);
    try {
      await this.ensure(root, probe);
      return null;
    } catch (error) {
      return error instanceof TerminalHistoryLocationUnavailable
        ? error.message
        : unavailable(root, error).message;
    } finally {
      this.directories.delete(probe);
      await rm(probe, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private privateRoot(root: string): Promise<boolean> {
    let state = this.roots.get(root);
    if (!state) {
      state = (async () => {
        const created = await mkdir(root, { recursive: true, mode: 0o700 });
        if (created !== undefined || root === this.ownedRoot) {
          // Station's own folder: protect it once; its journals inherit.
          try {
            await this.run('ensure', [root]);
          } catch (error) {
            throw unavailable(root, error);
          }
          return true;
        }
        // A folder the person chose: use it as is only if already private.
        return this.run('verify', [root]).then(
          () => true,
          () => false,
        );
      })();
      this.roots.set(root, state);
      state.catch(() => this.roots.delete(root));
    }
    return state;
  }
}
