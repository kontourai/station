import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  resolveTerminalCommandLaunch,
  TerminalProgramUnavailable,
} from '../terminal-command-programs.js';

const makeTempDir = trackTempDirs();
const COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
const NPM = 'C:\\Program Files\\nodejs\\npm.cmd';

async function project(scripts: Record<string, string>) {
  const root = makeTempDir('terminal-command-programs-');
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts }));
  return root;
}

function windowsDeps(binary: string) {
  return {
    findBinary: async () => binary,
    path: async () => 'C:\\Program Files\\nodejs',
    platform: 'win32' as const,
    env: { COMSPEC },
  };
}

describe('terminal command launches on Windows (#3994)', () => {
  it('runs a package manager batch shim through cmd.exe, quoted for cmd', async () => {
    const root = await project({ test: 'vitest' });
    // Spawning npm.cmd directly fails with EINVAL; cmd.exe runs it.
    expect(
      await resolveTerminalCommandLaunch(
        { kind: 'script', name: 'test' },
        root,
        windowsDeps(NPM),
      ),
    ).toEqual({
      file: COMSPEC,
      args: ['/d', '/s', '/c', `""${NPM}" run test"`],
      env: { PATH: 'C:\\Program Files\\nodejs' },
    });
  });

  it('refuses a script name cmd.exe would read as syntax', async () => {
    const root = await project({ 'a&b': 'x', 'say %PATH%': 'x' });
    for (const name of ['a&b', 'say %PATH%'])
      await expect(
        resolveTerminalCommandLaunch(
          { kind: 'script', name },
          root,
          windowsDeps(NPM),
        ),
      ).rejects.toThrow(
        new TerminalProgramUnavailable(
          `"${name}" cannot run on Windows: its name has characters the Windows command processor would interpret`,
        ),
      );
  });

  it('runs a native package manager directly', async () => {
    const root = await project({ test: 'vitest' });
    const bun = 'C:\\Users\\me\\.bun\\bin\\bun.exe';
    expect(
      await resolveTerminalCommandLaunch(
        { kind: 'script', name: 'test' },
        root,
        windowsDeps(bun),
      ),
    ).toMatchObject({ file: bun, args: ['run', 'test'] });
  });

  it('hands an approved command to cmd.exe inside the outer quotes /s strips', async () => {
    expect(
      await resolveTerminalCommandLaunch(
        { kind: 'run', command: 'echo "two  words"' },
        'C:\\work',
        windowsDeps(NPM),
      ),
    ).toMatchObject({
      file: COMSPEC,
      args: ['/d', '/s', '/c', '"echo "two  words""'],
    });
  });
});
