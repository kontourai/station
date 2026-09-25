import { describe, expect, test, vi } from 'vitest';
import { runOpenCommand } from '../commands/local-browser.js';

describe('packaged local browser open', () => {
  const instance = {
    type: 'sidecar' as const,
    port: 3492,
    uiPort: 5492,
    pid: 123,
  };
  test('opens only the selected instance and never logs its one-time capability', async () => {
    const token = 'a'.repeat(43);
    const mintToken = vi.fn().mockResolvedValue(token);
    const open = vi.fn().mockResolvedValue(true);
    const stdout = vi.fn();
    await runOpenCommand(['--instance=preview'], {
      readRegistry: () => ({
        version: 1,
        instances: { preview: instance, other: { ...instance, port: 3496 } },
      }),
      isLive: () => true,
      mintToken,
      open,
      stdout,
    });
    expect(mintToken).toHaveBeenCalledWith(
      3492,
      expect.any(String),
      expect.any(String),
    );
    expect(open).toHaveBeenCalledWith(
      `http://localhost:5492/#station-ui-bootstrap=${token}`,
    );
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(token);
  });
  test('--print hands over the one-time link instead of launching a browser (#2612)', async () => {
    const token = 'b'.repeat(43);
    const open = vi.fn().mockResolvedValue(true);
    const stdout = vi.fn();
    await runOpenCommand(['--instance=preview', '--print'], {
      readRegistry: () => ({ version: 1, instances: { preview: instance } }),
      isLive: () => true,
      mintToken: vi.fn().mockResolvedValue(token),
      open,
      stdout,
    });
    expect(open).not.toHaveBeenCalled();
    const lines = stdout.mock.calls.map(([line]) => line);
    expect(lines).toContain(
      `http://localhost:5492/#station-ui-bootstrap=${token}`,
    );
    // Minting replaced any unspent link; the output says so.
    expect(lines.join('\n')).toContain('replaces any earlier unspent link');
  });
  test('--print takes no value', async () => {
    await expect(
      runOpenCommand(['--print=yes'], {
        readRegistry: () => ({ version: 1, instances: { preview: instance } }),
        isLive: () => true,
      }),
    ).rejects.toThrow('Usage: station open');
  });
  test('a browser that cannot launch points at --print', async () => {
    await expect(
      runOpenCommand([], {
        readRegistry: () => ({ version: 1, instances: { preview: instance } }),
        isLive: () => true,
        mintToken: vi.fn().mockResolvedValue('c'.repeat(43)),
        open: vi.fn().mockResolvedValue(false),
      }),
    ).rejects.toThrow('station open --print');
  });
  test('requires a selection when multiple live instances exist', async () => {
    const open = vi.fn();
    await expect(
      runOpenCommand([], {
        readRegistry: () => ({
          version: 1,
          instances: { a: instance, b: instance },
        }),
        isLive: () => true,
        open,
      }),
    ).rejects.toThrow('More than one');
    expect(open).not.toHaveBeenCalled();
  });
  test('failed local authorization does not send the user to a misleading unpaired screen', async () => {
    const open = vi.fn();
    await expect(
      runOpenCommand([], {
        readRegistry: () => ({ version: 1, instances: { a: instance } }),
        isLive: () => true,
        mintToken: async () => null,
        open,
      }),
    ).rejects.toThrow('could not authorize');
    expect(open).not.toHaveBeenCalled();
  });
});
