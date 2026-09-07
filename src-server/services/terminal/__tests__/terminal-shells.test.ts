import { describe, expect, test } from 'vitest';
import {
  defaultTerminalShell,
  resolveTerminalShellCandidates,
} from '../terminal-shells.js';

describe('resolveTerminalShellCandidates', () => {
  test('prefers configured and env shells before posix fallbacks', () => {
    expect(
      resolveTerminalShellCandidates({
        configuredShell: '/custom/shell',
        platform: 'linux',
        env: { SHELL: '/env/shell' },
      }),
    ).toEqual([
      { shell: '/custom/shell' },
      { shell: '/env/shell' },
      { shell: '/bin/zsh', args: ['-o', 'nopromptsp'] },
      { shell: '/bin/bash' },
      { shell: '/bin/sh' },
    ]);
  });

  test('adds windows fallbacks after configured shells', () => {
    expect(
      resolveTerminalShellCandidates({
        configuredShell: 'configured.exe',
        platform: 'win32',
        env: {
          SHELL: 'shell.exe',
          COMSPEC: 'comspec.exe',
        },
      }),
    ).toEqual([
      { shell: 'configured.exe' },
      { shell: 'shell.exe' },
      { shell: 'comspec.exe' },
      { shell: 'C:\\Program Files\\Git\\bin\\bash.exe' },
      { shell: 'C:\\Program Files (x86)\\Git\\bin\\bash.exe' },
      { shell: 'C:\\cygwin64\\bin\\bash.exe' },
      { shell: 'C:\\cygwin\\bin\\bash.exe' },
      { shell: 'powershell.exe' },
      { shell: 'cmd.exe' },
    ]);
  });
});

/**
 * #1582 D9: the Settings "Terminal shell" input rendered blank with no hint.
 * The hint has to be derived from the resolver a spawn actually walks — a
 * hard-coded `/bin/zsh` is wrong on any host whose `SHELL` differs and on
 * every Windows one — and it must not claim the environment supplied a value
 * the environment did not.
 */
describe('defaultTerminalShell', () => {
  test('reports the environment shell, attributed to the environment', () => {
    expect(
      defaultTerminalShell({
        platform: 'darwin',
        env: { SHELL: '/opt/homebrew/bin/fish' },
      }),
    ).toEqual({ shell: '/opt/homebrew/bin/fish', source: 'env' });
  });

  test('falls back to the platform default and does not call it environment-set', () => {
    expect(defaultTerminalShell({ platform: 'darwin', env: {} })).toEqual({
      shell: '/bin/zsh',
      source: 'platform-fallback',
    });
    expect(defaultTerminalShell({ platform: 'linux', env: {} })).toEqual({
      shell: '/bin/zsh',
      source: 'platform-fallback',
    });
  });

  test('reports COMSPEC on Windows, attributed to the environment', () => {
    expect(
      defaultTerminalShell({
        platform: 'win32',
        env: { COMSPEC: 'C:\\Windows\\system32\\cmd.exe' },
      }),
    ).toEqual({
      shell: 'C:\\Windows\\system32\\cmd.exe',
      source: 'env',
    });
  });

  test('ignores a configured shell — this is the default, not the current value', () => {
    // The setting's own value is what the input renders; the placeholder must
    // answer "what happens if I leave this empty", so the configured shell
    // must not leak into it.
    const configured = resolveTerminalShellCandidates({
      configuredShell: '/usr/bin/nu',
      platform: 'darwin',
      env: { SHELL: '/bin/bash' },
    });
    expect(configured[0]).toEqual({ shell: '/usr/bin/nu' });
    expect(
      defaultTerminalShell({ platform: 'darwin', env: { SHELL: '/bin/bash' } }),
    ).toEqual({ shell: '/bin/bash', source: 'env' });
  });
});
