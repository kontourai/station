import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { prepareManagedAcpWorkspace } from '../../services/acp/managed-acp-workspace.js';

const homes: string[] = [];
function testHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'station-acp-workspace-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('managed ACP session workspace (#1403)', () => {
  test('keeps session and probe identities in disjoint namespaces', async () => {
    const home = testHome();
    const session = await prepareManagedAcpWorkspace(
      { kind: 'session', connectionId: 'shared', threadId: 'shared' },
      home,
    );
    const probe = await prepareManagedAcpWorkspace(
      { kind: 'probe', connectionId: 'shared' },
      home,
    );

    expect(session).not.toBe(probe);
    expect(session).toContain('/runtime/acp-workspaces/session/');
    expect(probe).toContain('/runtime/acp-workspaces/probe/');
  });

  test('isolates concurrent threads and reuses the same identity across resume/restart', async () => {
    const home = testHome();
    const [first, resumed, concurrent] = await Promise.all([
      prepareManagedAcpWorkspace(
        { kind: 'session', connectionId: 'cursor-agent', threadId: 'thread-a' },
        home,
      ),
      prepareManagedAcpWorkspace(
        { kind: 'session', connectionId: 'cursor-agent', threadId: 'thread-a' },
        home,
      ),
      prepareManagedAcpWorkspace(
        { kind: 'session', connectionId: 'cursor-agent', threadId: 'thread-b' },
        home,
      ),
    ]);

    expect(resumed).toBe(first);
    expect(concurrent).not.toBe(first);
    expect(
      first.startsWith(`${realpathSync(home)}/runtime/acp-workspaces/session/`),
    ).toBe(true);
    expect(lstatSync(first).mode & 0o777).toBe(0o700);
  });

  test('rejects a symlinked managed root instead of traversing it', async () => {
    const home = testHome();
    const outside = testHome();
    const root = join(home, 'runtime', 'acp-workspaces');
    mkdirSync(dirname(root), { recursive: true });
    symlinkSync(outside, root, 'dir');

    await expect(
      prepareManagedAcpWorkspace(
        { kind: 'session', connectionId: 'cursor-agent', threadId: 'thread' },
        home,
      ),
    ).rejects.toThrow('must not be a symbolic link');
  });

  test('rejects a replaced session workspace symlink instead of traversing it', async () => {
    const home = testHome();
    const outside = testHome();
    const workspace = await prepareManagedAcpWorkspace(
      { kind: 'session', connectionId: 'cursor-agent', threadId: 'thread' },
      home,
    );
    rmSync(workspace, { recursive: true });
    symlinkSync(outside, workspace, 'dir');

    await expect(
      prepareManagedAcpWorkspace(
        { kind: 'session', connectionId: 'cursor-agent', threadId: 'thread' },
        home,
      ),
    ).rejects.toThrow('must not be a symbolic link');
  });

  test('fails closed when Station home cannot be prepared', async () => {
    const home = testHome();
    const file = join(home, 'not-a-directory');
    mkdirSync(file);
    const impossible = join(file, 'child');
    rmSync(file, { recursive: true });
    // A file at the requested home makes recursive workspace creation fail.
    writeFileSync(file, 'occupied');

    await expect(
      prepareManagedAcpWorkspace(
        { kind: 'session', connectionId: 'cursor-agent', threadId: 'thread' },
        impossible,
      ),
    ).rejects.toThrow();
  });
});
