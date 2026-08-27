import { describe, expect, test } from 'vitest';
import { resolveTerminalShellCandidates } from '../terminal-shells.js';

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
