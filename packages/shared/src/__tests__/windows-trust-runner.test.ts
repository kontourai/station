/**
 * #2805 — the shared default runner for Windows trust commands. Every
 * production caller (the server's local-grant file, the CLI profile store,
 * triage, the desktop companion) uses it, so the budget it applies is the one
 * a cold, saturated Windows host gets. spawnSync is mocked at the module seam
 * the runner calls through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync,
}));

import {
  runWindowsTrustCommand,
  WINDOWS_TRUST_COMMAND_TIMEOUT_MS,
} from '../windows-path-trust.js';

beforeEach(() => {
  spawnSync.mockReset();
  spawnSync.mockReturnValue({
    status: 0,
    stdout: '{"trusted":true}',
    stderr: '',
  });
});

describe('runWindowsTrustCommand', () => {
  it('kills a trust command only after the cold-host budget by default', () => {
    // Pinned beside the constant under test.
    expect(WINDOWS_TRUST_COMMAND_TIMEOUT_MS).toBe(120_000);
    runWindowsTrustCommand('powershell.exe', ['-NoProfile']);
    expect(spawnSync).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile'],
      expect.objectContaining({
        timeout: 120_000,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
      }),
    );
  });

  it('honors the budget the trust operation passes', () => {
    runWindowsTrustCommand('powershell.exe', [], { timeout: 5 });
    expect(spawnSync.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ timeout: 5 }),
    );
  });

  it('reports a timeout as an error, never as success', () => {
    const error = Object.assign(
      new Error('spawnSync powershell.exe ETIMEDOUT'),
      {
        code: 'ETIMEDOUT',
      },
    );
    spawnSync.mockReturnValue({ status: null, error, stdout: '', stderr: '' });
    expect(runWindowsTrustCommand('powershell.exe', [])).toEqual({
      error,
      status: null,
      stdout: '',
      stderr: '',
    });
  });
});
