import { afterEach, describe, expect, test, vi } from 'vitest';
import { pollTerminalSubprocessActivity } from '../terminal-subprocess-state.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const { execSync } = await import('node:child_process');

afterEach(() => {
  vi.clearAllMocks();
});

describe('pollTerminalSubprocessActivity', () => {
  test('emits active state when a running child process is detected', () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from('123\n') as never);
    const emit = vi.fn();
    const entry = {
      pid: 123,
      hasRunningSubprocess: false,
      status: 'running',
    };

    pollTerminalSubprocessActivity({
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

  test('clears active state when polling fails after a subprocess was running', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found');
    });
    const emit = vi.fn();
    const entry = {
      pid: 123,
      hasRunningSubprocess: true,
      status: 'running',
    };

    pollTerminalSubprocessActivity({
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

  test('does nothing for non-running sessions', () => {
    const emit = vi.fn();
    const entry = {
      pid: 123,
      hasRunningSubprocess: false,
      status: 'exited',
    };

    pollTerminalSubprocessActivity({
      sessionId: 'project:term',
      entry,
      emit,
      debug: vi.fn(),
    });

    expect(execSync).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
