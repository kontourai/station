import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmDirSyncRetrying } from '@kontourai/station-shared/fs-windows-compat';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import {
  createACPBridgeClient,
  handleACPBridgeCreateTerminal,
  handleACPBridgePermissionRequest,
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
