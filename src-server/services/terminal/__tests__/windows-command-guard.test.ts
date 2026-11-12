/**
 * #4624 a command started through the Job guard is found and quoted as Node
 * would start it directly: the same executable, the same command line.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  resolveWindowsExecutable,
  windowsCommandLine,
} from '../windows-command-guard.js';

const makeTempDir = trackTempDirs();

describe('the command line', () => {
  it('quotes each argument as libuv does', () => {
    expect(
      windowsCommandLine(
        'C:\\Program Files\\node.exe',
        ['plain', 'a b', '', 'q"x', 'dir\\ end\\', 'c:\\no\\spaces\\'],
        false,
      ),
    ).toBe(
      '"C:\\Program Files\\node.exe" plain "a b" "" "q\\"x" "dir\\ end\\\\" c:\\no\\spaces\\',
    );
  });

  it('passes cmd.exe its line verbatim', () => {
    expect(
      windowsCommandLine(
        'cmd.exe',
        ['/d', '/s', '/c', '"npm run "a b""'],
        true,
      ),
    ).toBe('cmd.exe /d /s /c "npm run "a b""');
  });
});

describe.runIf(process.platform === 'win32')('the executable', () => {
  function tree() {
    const root = makeTempDir('station-command-guard-');
    const cwd = join(root, 'cwd');
    const bin = join(root, 'bin');
    const later = join(root, 'later');
    for (const directory of [cwd, bin, later]) mkdirSync(directory);
    return { cwd, bin, later };
  }

  it('looks in the working directory, then each PATH entry in order', () => {
    const { cwd, bin, later } = tree();
    writeFileSync(join(bin, 'tool.exe'), '');
    writeFileSync(join(later, 'tool.exe'), '');
    const env = { Path: `${bin};"${later}"` };
    expect(resolveWindowsExecutable('tool', cwd, env)).toBe(
      join(bin, 'tool.exe'),
    );
    writeFileSync(join(cwd, 'tool.exe'), '');
    expect(resolveWindowsExecutable('tool', cwd, env)).toBe(
      join(cwd, 'tool.exe'),
    );
  });

  it('tries a name with an extension as is, then appends .com and .exe', () => {
    const { cwd, bin } = tree();
    const env = { PATH: bin };
    writeFileSync(join(bin, 'run.cmd.exe'), '');
    expect(resolveWindowsExecutable('run.cmd', cwd, env)).toBe(
      join(bin, 'run.cmd.exe'),
    );
    writeFileSync(join(bin, 'run.cmd'), '');
    expect(resolveWindowsExecutable('run.cmd', cwd, env)).toBe(
      join(bin, 'run.cmd'),
    );
    writeFileSync(join(bin, 'app.com'), '');
    writeFileSync(join(bin, 'app.exe'), '');
    expect(resolveWindowsExecutable('app', cwd, env)).toBe(
      join(bin, 'app.com'),
    );
  });

  it('looks up a name with a directory only there, and reports a missing one', () => {
    const { cwd, bin } = tree();
    writeFileSync(join(bin, 'tool.exe'), '');
    expect(resolveWindowsExecutable(join(bin, 'tool'), cwd, {})).toBe(
      join(bin, 'tool.exe'),
    );
    expect(resolveWindowsExecutable('tool', cwd, { PATH: '' })).toBeNull();
    // A directory is never an executable.
    mkdirSync(join(bin, 'folder.exe'));
    expect(resolveWindowsExecutable('folder', cwd, { PATH: bin })).toBeNull();
  });
});
