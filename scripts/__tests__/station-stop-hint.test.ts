/**
 * #2805 — the stop hint an archive's `station start` prints must survive the
 * trip through the platform's shell. Windows printed `--home='C:\...'`; cmd.exe
 * keeps single quotes, so the pasted command named a home that does not
 * exist and `station stop` exited 0 with the server still running.
 */
import { describe, expect, it } from 'vitest';
import { homeFlag } from '../../packages/cli/src/commands/lifecycle.js';
import { parseStopHint } from '../lib/station-stop-hint.mjs';

const hint = (home: string, platform: NodeJS.Platform) =>
  `\n  Stop with: station stop${homeFlag(home, platform)} --instance=instance-1\n`;

describe('homeFlag quotes for the platform shell', () => {
  it('leaves a path of safe characters bare on every platform', () => {
    expect(homeFlag('/tmp/station/dev-home-a', 'linux')).toBe(
      ' --home=/tmp/station/dev-home-a',
    );
    expect(homeFlag('C:/Users/a', 'win32')).toBe(' --home=C:/Users/a');
  });

  it('single-quotes on POSIX, escaping a quote', () => {
    expect(homeFlag('/tmp/dev home', 'darwin')).toBe(" --home='/tmp/dev home'");
    expect(homeFlag("/tmp/it's", 'linux')).toBe(" --home='/tmp/it'\\''s'");
  });

  it('double-quotes a Windows path, which cmd.exe and PowerShell both honor', () => {
    expect(homeFlag('C:\\Users\\RUNNER~1\\Temp\\dev-home-a', 'win32')).toBe(
      ' --home="C:\\Users\\RUNNER~1\\Temp\\dev-home-a"',
    );
    expect(homeFlag('C:\\Users\\Ada Lovelace\\station', 'win32')).toBe(
      ' --home="C:\\Users\\Ada Lovelace\\station"',
    );
  });
});

describe('parseStopHint', () => {
  it('recovers the exact home and instance from each platform form', () => {
    for (const [home, platform] of [
      ['/tmp/station/dev-home-a', 'linux'],
      ['/tmp/dev home', 'darwin'],
      ["/tmp/it's here", 'linux'],
      ['C:\\Users\\RUNNER~1\\Temp\\dev-home-a', 'win32'],
      ['C:\\Users\\Ada Lovelace\\station', 'win32'],
    ] as const) {
      expect(parseStopHint(hint(home, platform), platform)).toEqual({
        home,
        instanceId: 'instance-1',
      });
    }
  });

  it("refuses the other platform's quoting", () => {
    expect(() =>
      parseStopHint(
        "Stop with: station stop --home='C:\\Users\\a b' --instance=i",
        'win32',
      ),
    ).toThrow(/single-quotes its home on Windows/);
    expect(() =>
      parseStopHint(
        'Stop with: station stop --home="/tmp/a b" --instance=i',
        'linux',
      ),
    ).toThrow(/double-quotes its home on POSIX/);
  });

  it('returns null when no stop hint was printed', () => {
    expect(parseStopHint('Station home: /tmp/x (--temp-home)', 'linux')).toBe(
      null,
    );
  });
});
