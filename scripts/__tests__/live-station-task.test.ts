import { beforeEach, describe, expect, test, vi } from 'vitest';

const fs = vi.hoisted(() => ({
  mkdtempSync: vi.fn(),
  realpathSync: vi.fn(),
  nativeRealpathSync: vi.fn(),
}));
const ports = vi.hoisted(() => ({
  findFreePortBlock: vi.fn(),
  findFreePortOutside: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdtempSync: fs.mkdtempSync,
    realpathSync: Object.assign(fs.realpathSync, {
      native: fs.nativeRealpathSync,
    }),
  };
});
vi.mock('../lib/free-ports.mjs', () => ports);

import { allocateLiveStation } from '../../tests/helpers/live-station-task';

describe('allocateLiveStation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ports.findFreePortBlock.mockResolvedValue(43100);
    ports.findFreePortOutside.mockResolvedValue(43110);
  });

  test('uses native realpath for a temporary home before it crosses the Station CLI boundary', async () => {
    const shortHome = 'C:\\WINDOWS\\SERVIC~1\\NETWOR~1\\Temp\\station-home-a';
    const canonicalHome =
      'C:\\Windows\\ServiceProfiles\\NetworkService\\AppData\\Local\\Temp\\station-home-a';
    fs.mkdtempSync.mockReturnValue(shortHome);
    fs.realpathSync.mockReturnValue('plain-realpath-must-not-be-used');
    fs.nativeRealpathSync.mockReturnValue(canonicalHome);

    const live = await allocateLiveStation('station-home-', 'test');

    expect(fs.nativeRealpathSync).toHaveBeenCalledExactlyOnceWith(shortHome);
    expect(fs.realpathSync).not.toHaveBeenCalled();
    expect(live.home).toBe(canonicalHome);
  });
});
