import { describe, expect, test, vi } from 'vitest';
import {
  createOpenCodeVersionProbe,
  openCodeServesNatively,
  parseOpenCodeVersion,
} from '../adapters/opencode-version-probe.js';

describe('parseOpenCodeVersion', () => {
  test('reads what 2.3.0 prints and a bare 1.x version', () => {
    // `opencode --version` on 2.3.0 (the binary the serve captures used).
    expect(parseOpenCodeVersion('opencode v2.3.0\n')).toEqual({
      major: 2,
      minor: 3,
      patch: 0,
      text: '2.3.0',
    });
    expect(parseOpenCodeVersion('1.18.18\n')?.text).toBe('1.18.18');
  });

  test('anything else is unknown, never guessed', () => {
    expect(parseOpenCodeVersion('')).toBeUndefined();
    expect(parseOpenCodeVersion('opencode dev')).toBeUndefined();
    expect(parseOpenCodeVersion('v2.3')).toBeUndefined();
    expect(parseOpenCodeVersion('1.2.3.4')).toBeUndefined();
    // A version somewhere in other text is not the binary's version.
    expect(
      parseOpenCodeVersion(
        'warning: config from 1.2.3 is old\nopencode v2.3.0',
      ),
    ).toBeUndefined();
    expect(parseOpenCodeVersion('node v22.1.0 required')).toBeUndefined();
    expect(parseOpenCodeVersion('opencode v2.3.0 (build abc)')).toBeUndefined();
    expect(parseOpenCodeVersion('02.3.0')).toBeUndefined();
  });

  test('blank lines around the version line and a pre-release are read', () => {
    expect(parseOpenCodeVersion('\n  2.3.0  \n')?.text).toBe('2.3.0');
    expect(parseOpenCodeVersion('opencode 2.3.0')?.text).toBe('2.3.0');
    // Kept whole, so it never matches the release's allowlist entry.
    expect(parseOpenCodeVersion('opencode v2.4.0-beta.1')?.text).toBe(
      '2.4.0-beta.1',
    );
  });

  test('only 2.x and later serve natively', () => {
    expect(openCodeServesNatively(parseOpenCodeVersion('2.0.0')!)).toBe(true);
    expect(openCodeServesNatively(parseOpenCodeVersion('1.99.9')!)).toBe(false);
  });
});

describe('createOpenCodeVersionProbe', () => {
  test('runs a binary once per identity, and again when the binary changes', async () => {
    let identity = 'a';
    const run = vi.fn(async () => 'opencode v2.3.0');
    const probe = createOpenCodeVersionProbe({
      run,
      identity: async () => identity,
    });
    await expect(probe.probe('/bin/opencode')).resolves.toMatchObject({
      text: '2.3.0',
    });
    await probe.probe('/bin/opencode');
    expect(run).toHaveBeenCalledTimes(1);
    identity = 'b';
    await probe.probe('/bin/opencode');
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('an unreadable answer is not kept', async () => {
    const run = vi
      .fn<(binary: string) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('1.18.18');
    const probe = createOpenCodeVersionProbe({
      run,
      identity: async () => 'same',
    });
    await expect(probe.probe('/bin/opencode')).resolves.toBeUndefined();
    await expect(probe.probe('/bin/opencode')).resolves.toMatchObject({
      text: '1.18.18',
    });
  });

  test('a binary that cannot be identified is unknown and not run', async () => {
    const run = vi.fn(async () => '2.3.0');
    const probe = createOpenCodeVersionProbe({
      run,
      identity: async () => {
        throw new Error('ENOENT');
      },
    });
    await expect(probe.probe('/missing')).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
});
