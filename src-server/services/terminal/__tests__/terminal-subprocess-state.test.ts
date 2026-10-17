import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { pollTerminalSubprocessActivity } from '../terminal-subprocess-state.js';

const probes = vi.hoisted(() => ({ execFile: vi.fn(), execSync: vi.fn() }));
vi.mock('node:child_process', () => probes);

beforeEach(() => {
  probes.execFile.mockImplementation((_file, _args, _options, callback) =>
    callback(null),
  );
  probes.execSync.mockReturnValue(Buffer.from('123\n'));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('pollTerminalSubprocessActivity', () => {
  test('emits active state when a running child process is detected', async () => {
    const emit = vi.fn();
    const entry = {
      pid: 123,
      hasRunningSubprocess: false,
      status: 'running',
    };

    await pollTerminalSubprocessActivity({
      sessionId: 'project:term',
      entry,
      emit,
      debug: vi.fn(),
    });

    expect(entry.hasRunningSubprocess).toBe(true);
    expect(emit).toHaveBeenCalledWith({
      type: 'activity',
      sessionId: 'project:term',
      hasRunningSubprocess: true,
    });
  });

  test('clears active state when polling fails after a subprocess was running', async () => {
    probes.execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(new Error('not found')),
    );
    probes.execSync.mockImplementation(() => {
      throw new Error('not found');
    });
    const emit = vi.fn();
    const entry = {
      pid: 123,
      hasRunningSubprocess: true,
      status: 'running',
    };

    await pollTerminalSubprocessActivity({
      sessionId: 'project:term',
      entry,
      emit,
      debug: vi.fn(),
    });

    expect(entry.hasRunningSubprocess).toBe(false);
    expect(emit).toHaveBeenCalledWith({
      type: 'activity',
      sessionId: 'project:term',
      hasRunningSubprocess: false,
    });
  });

  test('does nothing for non-running sessions', async () => {
    const emit = vi.fn();
    const entry = {
      pid: 123,
      hasRunningSubprocess: false,
      status: 'exited',
    };

    await pollTerminalSubprocessActivity({
      sessionId: 'project:term',
      entry,
      emit,
      debug: vi.fn(),
    });

    expect(probes.execSync).not.toHaveBeenCalled();
    expect(probes.execFile).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
