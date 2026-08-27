import { beforeEach, describe, expect, test, vi } from 'vitest';
import { activeTerminalWriter } from '../activeTerminal';

beforeEach(() => {
  // Reset to no active terminal between tests.
  activeTerminalWriter.clearActive('a');
  activeTerminalWriter.clearActive('b');
});

describe('activeTerminalWriter', () => {
  test('write returns false and is a no-op when nothing is active', () => {
    expect(activeTerminalWriter.hasActive()).toBe(false);
    expect(activeTerminalWriter.write('ls')).toBe(false);
  });

  test('forwards writes to the active terminal', () => {
    const writer = vi.fn(() => true);
    activeTerminalWriter.setActive('a', writer);
    expect(activeTerminalWriter.hasActive()).toBe(true);
    expect(activeTerminalWriter.write('src/app.ts ')).toBe(true);
    expect(writer).toHaveBeenCalledWith('src/app.ts ');
  });

  test('a newly active terminal replaces the previous one', () => {
    const a = vi.fn(() => true);
    const b = vi.fn(() => true);
    activeTerminalWriter.setActive('a', a);
    activeTerminalWriter.setActive('b', b);
    activeTerminalWriter.write('x');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith('x');
  });

  test('clearActive only clears when the id still owns the slot', () => {
    const a = vi.fn(() => true);
    const b = vi.fn(() => true);
    activeTerminalWriter.setActive('a', a);
    activeTerminalWriter.setActive('b', b);
    // A stale unmount from the previous tab must not unregister the new one.
    activeTerminalWriter.clearActive('a');
    expect(activeTerminalWriter.hasActive()).toBe(true);
    expect(activeTerminalWriter.write('y')).toBe(true);
    expect(b).toHaveBeenCalledWith('y');
  });

  test('propagates a false result when the terminal is not ready', () => {
    activeTerminalWriter.setActive('a', () => false);
    expect(activeTerminalWriter.write('z')).toBe(false);
  });
});
