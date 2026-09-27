import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  desktopInstallationId,
  resetDesktopInstallationId,
} from '../platform/native/installationId';

const PERSISTED = '6f1c2d3e-aaaa-4bbb-8ccc-111122223333';

describe('desktopInstallationId (#2587)', () => {
  beforeEach(() => resetDesktopInstallationId());

  test('asks the host once per document and is stable across reloads', async () => {
    // The host persists the id; every document reads the same value back.
    const invoke = vi.fn(async () => PERSISTED);
    expect(await desktopInstallationId(invoke)).toBe(PERSISTED);
    expect(await desktopInstallationId(invoke)).toBe(PERSISTED);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('desktop_installation_id');

    resetDesktopInstallationId(); // a reload
    expect(await desktopInstallationId(invoke)).toBe(PERSISTED);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test('never invents an id: no command or a malformed value yields none', async () => {
    expect(
      await desktopInstallationId(async () => {
        throw new Error('unknown command');
      }),
    ).toBeUndefined();
    resetDesktopInstallationId();
    expect(await desktopInstallationId(async () => 'desktop')).toBeUndefined();
    resetDesktopInstallationId();
    expect(
      await desktopInstallationId(async () => PERSISTED.toUpperCase()),
    ).toBeUndefined();
  });
});
