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
