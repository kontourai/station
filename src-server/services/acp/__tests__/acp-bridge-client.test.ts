import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirSyncRetrying } from '@kontourai/station-shared/fs-windows-compat';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import {
  createACPBridgeClient,
  handleACPBridgeCreateTerminal,
  handleACPBridgePermissionRequest,
  splitComposedShellLine,
} from '../acp-bridge-client.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('handleACPBridgePermissionRequest', () => {
  test('emits approval event and selects allow option when approved', async () => {
    const registry = new ApprovalRegistry(mockLogger);
    const writer = vi.fn(async () => {});
    vi.spyOn(ApprovalRegistry, 'generateId').mockReturnValue('acp-fixed');

    const pending = handleACPBridgePermissionRequest(
      {
        toolCall: {
          title: 'Edit file',
          rawInput: { path: 'README.md' },
        },
        options: [
          { kind: 'allow_once', optionId: 'allow-1' },
          { kind: 'reject_once', optionId: 'reject-1' },
        ],
      } as any,
      {
        approvalRegistry: registry,
        getActiveWriter: () => writer,
      },
    );

    expect(writer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool-approval-request',
        approvalId: 'acp-fixed',
        toolName: 'Edit file',
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.has('acp-fixed')).toBe(true);
    registry.resolve('acp-fixed', true);

    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-1' },
    });
  });

  test('selects reject_always rather than an allow option when denied', async () => {
    const registry = new ApprovalRegistry(mockLogger);
    vi.spyOn(ApprovalRegistry, 'generateId').mockReturnValue('acp-fixed');

    const pending = handleACPBridgePermissionRequest(
      {
        options: [
          { kind: 'reject_always', optionId: 'reject-always' },
          { kind: 'allow_always', optionId: 'allow-always' },
        ],
      } as any,
      {
        approvalRegistry: registry,
        getActiveWriter: () => null,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    registry.resolve('acp-fixed', false);

    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-always' },
    });
  });

  test('cancels a denial when the agent offered no reject option', async () => {
    const registry = new ApprovalRegistry(mockLogger);
    vi.spyOn(ApprovalRegistry, 'generateId').mockReturnValue('acp-fixed');

    const pending = handleACPBridgePermissionRequest(
      {
        options: [{ kind: 'allow_always', optionId: 'allow-always' }],
      } as any,
      {
        approvalRegistry: registry,
        getActiveWriter: () => null,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    registry.resolve('acp-fixed', false);

    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});

describe('handleACPBridgeCreateTerminal', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acp-bridge-client-'));
  });

  afterEach(() => {
    rmDirSyncRetrying(dir);
  });

  test('creates and tracks a managed terminal', async () => {
    const terminals = new Map();
    const scriptPath = join(dir, 'echo.js');
    writeFileSync(scriptPath, "console.log('hello from acp');");

    const result = await handleACPBridgeCreateTerminal(
      {
        command: process.execPath,
        args: [scriptPath],
      } as any,
      {
        cwd: dir,
        terminals: terminals as any,
        nextTerminalId: () => 'term-1',
      },
    );

    expect(result).toEqual({ terminalId: 'term-1' });
    expect(terminals.has('term-1')).toBe(true);

    const terminal = terminals.get('term-1');
    const exited = new Promise((resolve) =>
      terminal?.process.once('exit', resolve),
    );
    terminal?.process.kill();
    // kill() only requests termination; on Windows the process (and its
    // handle on `dir`) can still be alive when afterEach's cleanup runs,
    // unlike POSIX where the effect is closer to immediate.
    await exited;
  });

  test('a failed spawn is a failed terminal, not a crashed server', async () => {
    // The 2026-09-18 live crash: a spawn failure emitted `error` with no
    // listener, the uncaughtException killed the sidecar mid-turn, and every
    // session on it died with `session.exited: orchestration_shutdown`. The
    // discriminating property of this test is that the test process itself
    // SURVIVES the failed spawn — under the old code this file dies with an
    // uncaught exception.
    const terminals = new Map();
    const client = createACPBridgeClient({
      cwd: dir,
      terminals: terminals as any,
      approvalRegistry: new ApprovalRegistry(mockLogger),
      getActiveWriter: () => null,
      nextTerminalId: () => 'term-failed-spawn',
      onSessionUpdate: async () => {},
      onExtNotification: () => {},
      onExtMethod: async () => ({}),
    });
    const created = await client.createTerminal?.({
      command: `${process.execPath}-no-such-binary`,
      args: [],
    } as never);
    expect(created).toEqual({ terminalId: 'term-failed-spawn' });

    await expect(
      client.waitForTerminalExit?.({
        terminalId: 'term-failed-spawn',
      } as never),
    ).resolves.toEqual({ exitCode: 127, signal: null });
  });

  test('a waiter arriving before the error event still resolves for a failed spawn', async () => {
    const terminals = new Map();
    await handleACPBridgeCreateTerminal(
      {
        command: `${process.execPath}-no-such-binary`,
        args: [],
      } as any,
      {
        cwd: dir,
        terminals: terminals as any,
        nextTerminalId: () => 'term-race',
      },
    );
    // Attached before the spawn failure lands: only `error` will ever fire,
    // never `exit`, so the waiter must resolve through the failure marker.
    const client = createACPBridgeClient({
      cwd: dir,
      terminals: terminals as any,
      approvalRegistry: new ApprovalRegistry(mockLogger),
      getActiveWriter: () => null,
      nextTerminalId: () => 'unused',
      onSessionUpdate: async () => {},
      onExtNotification: () => {},
      onExtMethod: async () => ({}),
    });
    await expect(
      client.waitForTerminalExit?.({ terminalId: 'term-race' } as never),
    ).resolves.toMatchObject({ exitCode: 127, signal: null });
  });

  test('terminalOutput reports the spawn failure through the shell failure channel', async () => {
    const terminals = new Map();
    await handleACPBridgeCreateTerminal(
      {
        command: `${process.execPath}-no-such-binary`,
        args: [],
      } as any,
      {
        cwd: dir,
        terminals: terminals as any,
        nextTerminalId: () => 'term-output',
      },
    );
    const client = createACPBridgeClient({
      cwd: dir,
      terminals: terminals as any,
      approvalRegistry: new ApprovalRegistry(mockLogger),
      getActiveWriter: () => null,
      nextTerminalId: () => 'unused',
      onSessionUpdate: async () => {},
      onExtNotification: () => {},
      onExtMethod: async () => ({}),
    });
    await vi.waitFor(async () => {
      const out = (await client.terminalOutput?.({
        terminalId: 'term-output',
      } as never)) as {
        output: string;
        exitStatus: { exitCode: number | null; signal: string | null } | null;
      };
      // The empty-output-success fabrication would leave `exitStatus` null
      // forever — the agent reads a dead terminal as still running.
      expect(out.exitStatus).toEqual({ exitCode: 127, signal: null });
      expect(out.output).toContain('spawn failed');
      expect(out.output).toContain('ENOENT');
    });
  });

  test('a composed shell line with empty args is split and runs', async () => {
    // The exact shape from the 2026-09-18 incident: the whole command line
    // arrived in `command` with no `args`, and the raw string was used as
    // the executable path.
    if (process.platform === 'win32') return; // POSIX shell quoting
    const terminals = new Map();
    const client = createACPBridgeClient({
      cwd: dir,
      terminals: terminals as any,
      approvalRegistry: new ApprovalRegistry(mockLogger),
      getActiveWriter: () => null,
      nextTerminalId: () => 'term-split',
      onSessionUpdate: async () => {},
      onExtNotification: () => {},
      onExtMethod: async () => ({}),
    });
    await client.createTerminal?.({
      command: `${process.execPath} -p "40 + 2"`,
      args: [],
    } as never);
    // Await the exit BEFORE reading output: `terminalOutput` returns an
    // output snapshot, so an immediate read would race the child.
    await client.waitForTerminalExit?.({ terminalId: 'term-split' } as never);
    const out = (await client.terminalOutput?.({
      terminalId: 'term-split',
    } as never)) as { output: string };
    expect(out.output.trim()).toBe('42');
  });

  test('a space-bearing command that names a real file is not split', async () => {
    if (process.platform === 'win32') return; // shebang resolution
    const scriptPath = join(dir, 'my tool.js');
    writeFileSync(
      scriptPath,
      "#!/usr/bin/env node\nconsole.log('space-path-ok');\n",
    );
    chmodSync(scriptPath, 0o755);
    const terminals = new Map();
    const client = createACPBridgeClient({
      cwd: dir,
      terminals: terminals as any,
      approvalRegistry: new ApprovalRegistry(mockLogger),
      getActiveWriter: () => null,
      nextTerminalId: () => 'term-space-path',
      onSessionUpdate: async () => {},
      onExtNotification: () => {},
      onExtMethod: async () => ({}),
    });
    await client.createTerminal?.({
      command: scriptPath,
      args: [],
    } as never);
    await client.waitForTerminalExit?.({
      terminalId: 'term-space-path',
    } as never);
    const out = (await client.terminalOutput?.({
      terminalId: 'term-space-path',
    } as never)) as { output: string };
    expect(out.output).toContain('space-path-ok');
  });

  test('an unambiguous split failure keeps the raw command and fails honestly', async () => {
    const terminals = new Map();
    await handleACPBridgeCreateTerminal(
      {
        // Unbalanced quote: no unambiguous shell reading, so the raw string
        // goes to spawn and the failure is reported, never fabricated.
        command: `/no-such-dir-9x 'open-quote -lc pwd`,
        args: [],
      } as any,
      {
        cwd: dir,
        terminals: terminals as any,
        nextTerminalId: () => 'term-unbalanced',
      },
    );
    const term = terminals.get('term-unbalanced');
    await vi.waitFor(() => expect(term.exited).toBe(true));
    expect(term.exitCode).toBe(127);
    expect(term.output).toContain('spawn failed');
  });
});

describe('splitComposedShellLine', () => {
  test('splits plain words', () => {
    expect(splitComposedShellLine('bash -lc pwd')).toEqual([
      'bash',
      '-lc',
      'pwd',
    ]);
  });

  test('single-quoted segments keep spaces and drop the quotes', () => {
    expect(splitComposedShellLine("bash -lc 'pwd && ls -la'")).toEqual([
      'bash',
      '-lc',
      'pwd && ls -la',
    ]);
  });

  test('double-quoted segments honor escaped quotes only', () => {
    expect(splitComposedShellLine('sh -c "echo \\"hi there\\""')).toEqual([
      'sh',
      '-c',
      'echo "hi there"',
    ]);
  });

  test('backslashes inside double quotes stay literal unless escaping a quote or backslash', () => {
    // A Windows path inside double quotes must not lose its separators.
    expect(splitComposedShellLine('"C:\\tools\\x y" --flag')).toEqual([
      'C:\\tools\\x y',
      '--flag',
    ]);
  });

  test('unquoted backslash escapes the next character', () => {
    expect(splitComposedShellLine('/opt/my\\ tool/bin/x')).toEqual([
      '/opt/my tool/bin/x',
    ]);
  });

  test('an unbalanced quote is not split', () => {
    expect(splitComposedShellLine("bash -lc 'pwd")).toBeNull();
    expect(splitComposedShellLine('bash -lc "pwd')).toBeNull();
    expect(splitComposedShellLine('bash trailing\\')).toBeNull();
  });

  test('empty and whitespace-only lines are not split', () => {
    expect(splitComposedShellLine('')).toBeNull();
    expect(splitComposedShellLine('   \t  ')).toBeNull();
  });
});

describe('createACPBridgeClient', () => {
  test('delegates extension and session callbacks', async () => {
    const onSessionUpdate = vi.fn(async () => {});
    const onExtNotification = vi.fn();
    const onExtMethod = vi.fn(() => ({ ok: true }));

    const client = createACPBridgeClient({
      cwd: '/tmp',
      terminals: new Map(),
      approvalRegistry: new ApprovalRegistry(mockLogger),
      getActiveWriter: () => null,
      nextTerminalId: () => 'term-1',
      onSessionUpdate,
      onExtNotification,
      onExtMethod,
    });

    await client.sessionUpdate?.({ update: {} } as any);
    await client.extNotification?.('_kiro.dev/test', { x: 1 });
    await expect(
      client.extMethod?.('_kiro.dev/test', { x: 1 }),
    ).resolves.toEqual({
      ok: true,
    });

    expect(onSessionUpdate).toHaveBeenCalled();
    expect(onExtNotification).toHaveBeenCalledWith('_kiro.dev/test', { x: 1 });
    expect(onExtMethod).toHaveBeenCalledWith('_kiro.dev/test', { x: 1 });
  });
});

describe('createACPBridgeClient terminal handlers do not fabricate results', () => {
  test('terminalOutput for an unknown terminal is an error, not empty output', async () => {
    const client = createACPBridgeClient({
      cwd: '/tmp',
      terminals: new Map(),
      approvalRegistry: new ApprovalRegistry(mockLogger),
      getActiveWriter: () => null,
      nextTerminalId: () => 'term-1',
      onSessionUpdate: async () => {},
      onExtNotification: () => {},
      onExtMethod: async () => ({}),
    });

    // Previously `{ output: '', truncated: false }` — a JSON-RPC success the
    // agent reads as "the command ran and printed nothing."
    await expect(
      client.terminalOutput?.({ terminalId: 'never-created' } as never),
    ).rejects.toMatchObject({ code: -32602 });
  });

  test('waitForTerminalExit for an unknown terminal is an error too', async () => {
    const client = createACPBridgeClient({
      cwd: '/tmp',
      terminals: new Map(),
      approvalRegistry: new ApprovalRegistry(mockLogger),
      getActiveWriter: () => null,
      nextTerminalId: () => 'term-1',
      onSessionUpdate: async () => {},
      onExtNotification: () => {},
      onExtMethod: async () => ({}),
    });

    // Previously `{ exitCode: -1 }`. Independent review was right that the
    // original version of this test PINNED a fabrication as intended:
    // `-1` is not a real POSIX exit code, but it is a plausible-looking one,
    // and an agent cannot tell it apart from a command that genuinely
    // failed. Same class as `terminalOutput` 34 lines above, so it gets the
    // same answer.
    await expect(
      client.waitForTerminalExit?.({ terminalId: 'never-created' } as never),
    ).rejects.toMatchObject({ code: -32602 });
  });

  test('a signal-killed terminal reports the signal, not a made-up exit code', async () => {
    // The live-path bug: Station itself sends the signal (`releaseTerminal`
    // and `killTerminal` both call `kill()`), and `code ?? -1` reported
    // every terminal Station tore down as a process that ran and exited -1.
    // ACP models the two outcomes separately (`exitCode` XOR `signal`).
    const terminals = new Map();
    const client = createACPBridgeClient({
      cwd: '/tmp',
      terminals,
      approvalRegistry: new ApprovalRegistry(mockLogger),
      getActiveWriter: () => null,
      nextTerminalId: () => 'term-signal',
      onSessionUpdate: async () => {},
      onExtNotification: () => {},
      onExtMethod: async () => ({}),
    });

    await client.createTerminal?.({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
    } as never);

    const pending = client.waitForTerminalExit?.({
      terminalId: 'term-signal',
    } as never);
    terminals.get('term-signal')?.process.kill('SIGTERM');

    const result = (await pending) as {
      exitCode: number | null;
      signal: string | null;
    };
    expect(result.signal).toBe('SIGTERM');
    expect(result.exitCode).toBeNull();
    expect(result.exitCode).not.toBe(-1);
  });

  test('terminalOutput reports the exit status of a signal-killed terminal', async () => {
    // Sibling of the above: `exitCode !== null` used to decide whether an
    // exit status existed, so a signal-killed terminal was reported as
    // STILL RUNNING (`exitStatus: null`) forever.
    const terminals = new Map();
    const client = createACPBridgeClient({
      cwd: '/tmp',
      terminals,
      approvalRegistry: new ApprovalRegistry(mockLogger),
      getActiveWriter: () => null,
      nextTerminalId: () => 'term-out',
      onSessionUpdate: async () => {},
      onExtNotification: () => {},
      onExtMethod: async () => ({}),
    });

    await client.createTerminal?.({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
    } as never);
    const term = terminals.get('term-out');
    const exited = new Promise((resolve) => term.process.once('exit', resolve));
    term.process.kill('SIGTERM');
    await exited;

    const out = (await client.terminalOutput?.({
      terminalId: 'term-out',
    } as never)) as {
      exitStatus: { exitCode: number | null; signal: string | null } | null;
    };
    expect(out.exitStatus).not.toBeNull();
    expect(out.exitStatus?.signal).toBe('SIGTERM');
    expect(out.exitStatus?.exitCode).toBeNull();
  });
});
