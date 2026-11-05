/**
 * #3994 terminal journals are private to their owner wherever history lives.
 * On Windows the journal's POSIX modes set no ACL, so these tests read the
 * real DACL of journals written into a shared location (one that grants
 * Authenticated Users Modify, as a non-system drive's root commonly does) and
 * into Station's own location. A location where privacy cannot be
 * established refuses the open and the settings change.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { terminalScopeAllows } from '@kontourai/station-contracts/terminal-transport';
import { windowsSystemUtilityPath } from '@kontourai/station-shared/windows-path-trust';
import { afterEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { IPtyProcess } from '../../../domain/pty-adapter.js';
import type { ShellHost } from '../shell-host.js';
import { TerminalJournalPrivacy } from '../terminal-journal-privacy.js';
import { defaultTerminalJournalDirectory } from '../terminal-retention.js';
import { TerminalSessions } from '../terminal-sessions.js';

const temp = trackTempDirs();
const scope = { projectId: 'alpha', bindingKey: 'project' };
const windows = process.platform === 'win32';
const AUTHENTICATED_USERS = 'S-1-5-11';
const USERS = 'S-1-5-32-545';

/** Prints what it is sent, so each write reaches the journal. */
class EchoPty implements IPtyProcess {
  pid = 4242;
  private data = new Set<(data: string) => void>();
  private exits = new Set<
    (event: { exitCode: number; signal: number | null }) => void
  >();
  write(data: string) {
    queueMicrotask(() => {
      for (const listener of this.data) listener(`echo:${data}`);
    });
  }
  resize() {}
  kill() {
    for (const exit of this.exits) exit({ exitCode: 0, signal: null });
  }
  onData(cb: (data: string) => void) {
    this.data.add(cb);
    return () => this.data.delete(cb);
  }
  onExit(cb: (event: { exitCode: number; signal: number | null }) => void) {
    this.exits.add(cb);
    return () => this.exits.delete(cb);
  }
}

function powershell(script: string, env: Record<string, string> = {}) {
  return execFileSync(
    windowsSystemUtilityPath('powershell'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      env: { ...process.env, ...env },
    },
  ).trim();
}

const currentUser = () =>
  powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');

/** The SIDs a path's DACL allows, as the filesystem reports them. */
function allowedSids(path: string): string[] {
  const out = powershell(
    "$ErrorActionPreference = 'Stop'; (Get-Acl -LiteralPath $env:STATION_ACL_PATH).Access | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }",
    { STATION_ACL_PATH: path },
  );
  return [...new Set(out.split(/\r?\n/).filter(Boolean))].sort();
}

/** A folder anyone signed in may modify, inherited by what is made in it. */
function shareWithAuthenticatedUsers(path: string) {
  powershell(
    "$ErrorActionPreference = 'Stop'; $acl = Get-Acl -LiteralPath $env:STATION_ACL_PATH; $sid = New-Object Security.Principal.SecurityIdentifier($env:STATION_ACL_SID); $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:STATION_ACL_PATH -AclObject $acl",
    { STATION_ACL_PATH: path, STATION_ACL_SID: AUTHENTICATED_USERS },
  );
}

describe.runIf(windows)('terminal journal privacy on Windows', () => {
  let sessions: TerminalSessions<string> | undefined;
  afterEach(async () => {
    await sessions?.dispose();
    sessions = undefined;
  });

  async function start(directory?: string) {
    const home = temp('terminal-journal-privacy-');
    const root = join(home, 'project');
    await mkdir(root);
    const host: ShellHost = { spawn: async () => new EchoPty() };
    sessions = new TerminalSessions<string>(
      home,
      host,
      {
        authorize: (_principal, _target, operation) =>
          terminalScopeAllows('terminal:operate', operation),
        resolveRoot: async () => root,
      },
      {},
      {},
      directory
        ? async () => ({
            persist: true,
            directory,
            maxAgeMs: Number.POSITIVE_INFINITY,
            maxTerminalBytes: 16 * 1024 * 1024,
            maxTotalBytes: 1024 * 1024 * 1024,
          })
        : undefined,
    );
    const opened = await sessions.open('operator', scope, {
      cols: 80,
      rows: 24,
    });
    await sessions.write('operator', scope, opened.terminalId, 'secret\r');
    // A read seals and writes the pending batch to its segment.
    await expect
      .poll(
        async () =>
          (await sessions!.read('operator', scope, opened.terminalId)).journal
            .records.length,
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    return { home, opened };
  }

  async function journalPaths(directory: string) {
    const segments = (await readdir(directory)).filter((name) =>
      name.endsWith('.jsonl'),
    );
    expect(segments.length).toBeGreaterThan(0);
    return [directory, ...segments.map((name) => join(directory, name))];
  }

  it('keeps a journal in a shared history folder private to its owner', async () => {
    const shared = temp('terminal-journal-shared-');
    shareWithAuthenticatedUsers(shared);
    // The fixture really is shared: a file made there inherits the grant.
    const control = join(shared, 'control.txt');
    await writeFile(control, 'control');
    expect(allowedSids(control)).toContain(AUTHENTICATED_USERS);

    const { opened } = await start(shared);
    const user = currentUser();
    for (const path of await journalPaths(join(shared, opened.terminalId)))
      expect(allowedSids(path), path).toEqual([user]);
    // The person's folder keeps its own ACL; only Station's journal changed.
    expect(allowedSids(shared)).toContain(AUTHENTICATED_USERS);
  }, 180_000);

  it("protects Station's own history folder once, and its journals inherit that", async () => {
    const { home, opened } = await start();
    const root = defaultTerminalJournalDirectory(home);
    const user = currentUser();
    expect(allowedSids(root)).toEqual([user]);
    for (const path of await journalPaths(join(root, opened.terminalId)))
      expect(allowedSids(path), path).toEqual([user]);
    for (const path of [root, join(root, opened.terminalId)]) {
      const sids = allowedSids(path);
      expect(sids).not.toContain(AUTHENTICATED_USERS);
      expect(sids).not.toContain(USERS);
    }
  }, 180_000);
});

describe('a history location that cannot be made private', () => {
  const failing = () =>
    new TerminalJournalPrivacy(
      join(temp('terminal-journal-owned-'), 'terminal-journals'),
      async () => {
        throw new Error('This volume does not support ACLs');
      },
      'win32',
    );

  it('refuses the settings change with a reason', async () => {
    const location = temp('terminal-journal-fat-');
    await expect(failing().problem(location)).resolves.toMatch(
      /can't be kept private/,
    );
    // The probe leaves nothing behind in the person's folder.
    expect(await readdir(location)).toEqual([]);
  });

  it('refuses to open a terminal there instead of writing history', async () => {
    const home = temp('terminal-journal-refused-');
    const root = join(home, 'project');
    await mkdir(root);
    const location = temp('terminal-journal-fat-');
    let spawned = 0;
    const refusing = new TerminalSessions<string>(
      home,
      {
        spawn: async () => {
          spawned++;
          return new EchoPty();
        },
      },
      {
        authorize: () => true,
        resolveRoot: async () => root,
      },
      {},
      {},
      async () => ({
        persist: true,
        directory: location,
        maxAgeMs: Number.POSITIVE_INFINITY,
        maxTerminalBytes: 16 * 1024 * 1024,
        maxTotalBytes: 1024 * 1024 * 1024,
      }),
      failing(),
    );
    try {
      await expect(
        refusing.open('operator', scope, { cols: 80, rows: 24 }),
      ).rejects.toThrow(/can't be kept private/);
      expect(spawned).toBe(0);
    } finally {
      await refusing.dispose();
    }
  });

  it('on POSIX, needs no ACL program at all', async () => {
    const privacy = new TerminalJournalPrivacy(
      'unused',
      async () => {
        throw new Error('must not run');
      },
      'linux',
    );
    const location = temp('terminal-journal-posix-');
    await expect(privacy.problem(location)).resolves.toBeNull();
  });
});
