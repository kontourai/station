import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  credentialValuesFromNpmrc,
  publishNpmrcSuccess,
  runPublishNpmrcCredentialCheck,
  scanPublishNpmrcCredentials,
} from '../check-publish-npmrc-credentials.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-publish-npmrc-'));
  const home = join(root, 'home');
  const osHome = join(root, 'os-home');
  const runner = join(root, 'runner');
  const workspace = join(root, 'workspace');
  for (const directory of [home, osHome, runner, workspace])
    mkdirSync(directory);
  return {
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    env: {
      GITHUB_WORKSPACE: workspace,
      HOME: home,
      NPM_CONFIG_USERCONFIG: join(root, 'user.npmrc'),
      RUNNER_TEMP: runner,
    },
    home,
    osHome,
    root,
    runner,
    workspace,
  };
}

function scan(fixtureValue: ReturnType<typeof fixture>, overrides = {}) {
  return scanPublishNpmrcCredentials({
    cwd: fixtureValue.root,
    env: { ...fixtureValue.env, ...overrides },
    homeDir: fixtureValue.osHome,
  });
}

describe('Publish npmrc credential verifier', () => {
  it('parses CRLF/LF canonical registry keys with whitespace, ports, and paths', () => {
    expect(
      credentialValuesFromNpmrc(
        ' //registry.example.test:4873/acme/:_authToken = token-a\r\n//registry.npmjs.org/:_AUTH = token-b\n',
      ),
    ).toEqual({
      malformedCredentialKey: false,
      values: ['token-a', 'token-b'],
    });
    expect(
      credentialValuesFromNpmrc(
        '//registry.example.test/:_authToken/extra = token\n',
      ),
    ).toEqual({ malformedCredentialKey: true, values: [] });
  });

  it('accepts literal and defined exact references while rejecting empty and unsafe expansions', () => {
    const item = fixture();
    try {
      writeFileSync(
        item.env.NPM_CONFIG_USERCONFIG,
        [
          '//registry.npmjs.org/:_authToken = literal-value',
          `//registry.example.test:4873/acme/:_auth=${'${'}DEFINED_TOKEN}`,
        ].join('\n'),
      );
      expect(scan(item, { DEFINED_TOKEN: 'provided' })).toMatchObject({
        credentialEntries: 2,
        errors: [],
        scannedFiles: 1,
      });

      for (const value of [
        '',
        '   ',
        '; comment-only value',
        '# comment-only value',
        '""',
        "''",
        `${'${'}UNDEFINED_TOKEN}`,
        `prefix-${'${'}UNDEFINED_TOKEN}`,
        `${'${'}UNDEFINED_TOKEN?}`,
      ]) {
        writeFileSync(
          item.env.NPM_CONFIG_USERCONFIG,
          `//registry.npmjs.org/:_authToken = ${value}\n`,
        );
        expect(scan(item).errors).toEqual([
          'A registry credential is empty or uses an unsupported expansion.',
        ]);
      }
    } finally {
      item.cleanup();
    }
  });

  it('deduplicates canonical candidates and handles option-shaped relative input as a path', () => {
    const item = fixture();
    try {
      const homeNpmrc = join(item.home, '.npmrc');
      writeFileSync(homeNpmrc, '//registry.npmjs.org/:_authToken=literal\n');
      expect(scan(item, { NPM_CONFIG_USERCONFIG: homeNpmrc })).toMatchObject({
        credentialEntries: 1,
        errors: [],
        scannedFiles: 1,
      });

      const linkedHome = join(item.root, 'linked-home');
      symlinkSync(item.home, linkedHome, 'dir');
      expect(
        scan(item, { HOME: linkedHome, NPM_CONFIG_USERCONFIG: homeNpmrc }),
      ).toMatchObject({ credentialEntries: 1, errors: [], scannedFiles: 1 });

      const optionShaped = join(item.root, '-userconfig.npmrc');
      writeFileSync(optionShaped, '//registry.npmjs.org/:_authToken=literal\n');
      expect(
        scan(item, {
          HOME: join(item.root, 'absent-home'),
          NPM_CONFIG_USERCONFIG: '-userconfig.npmrc',
        }),
      ).toMatchObject({ credentialEntries: 1, errors: [], scannedFiles: 1 });
    } finally {
      item.cleanup();
    }
  });

  it('matches npm HOME-state and slash expansion rules without evaluating unsupported syntax', () => {
    const item = fixture();
    try {
      const custom = join(item.home, 'custom.npmrc');
      writeFileSync(custom, '//registry.npmjs.org/:_authToken=literal\n');
      for (const configured of [
        `~/custom.npmrc`,
        `${'${'}HOME}/custom.npmrc`,
        `~/nested/../custom.npmrc`,
      ]) {
        expect(scan(item, { NPM_CONFIG_USERCONFIG: configured })).toMatchObject(
          {
            credentialEntries: 1,
            errors: [],
            scannedFiles: 1,
          },
        );
      }
      writeFileSync(
        custom,
        `//registry.npmjs.org/:_authToken=${'${'}MISSING_REPEATED_SEPARATOR}\n`,
      );
      for (const configured of [
        `~/custom.npmrc`,
        `${'${'}HOME}//custom.npmrc`,
        `${'${'}HOME}///custom.npmrc`,
      ]) {
        expect(
          scan(item, { NPM_CONFIG_USERCONFIG: configured }).errors,
        ).toEqual([
          'A registry credential is empty or uses an unsupported expansion.',
        ]);
      }
      // npm maps ~//<absolute> and ~///<absolute> to the root-absolute target,
      // unlike ${HOME}// which remains home-relative. Both forms must inspect
      // the actual target rather than accidentally clearing a bad HOME config.
      for (const configured of [`~//${custom}`, `~///${custom}`]) {
        expect(
          scan(item, { NPM_CONFIG_USERCONFIG: configured }).errors,
        ).toEqual([
          'A registry credential is empty or uses an unsupported expansion.',
        ]);
      }
      const literalHomeSegment = `${'${'}HOME}`;
      const literalHome = join(item.root, literalHomeSegment, 'custom.npmrc');
      mkdirSync(join(item.root, literalHomeSegment));
      writeFileSync(
        literalHome,
        `//registry.npmjs.org/:_authToken=${'${'}MISSING_UNSET_HOME}\n`,
      );
      // With HOME unset, npm leaves ${HOME} literal and resolves it from cwd.
      for (const configured of [
        `${'${'}HOME}/custom.npmrc`,
        `${'${'}HOME}//custom.npmrc`,
      ]) {
        expect(
          scan(item, { HOME: undefined, NPM_CONFIG_USERCONFIG: configured })
            .errors,
        ).toEqual([
          'A registry credential is empty or uses an unsupported expansion.',
        ]);
      }
      const literalTilde = join(item.root, '~', 'custom.npmrc');
      mkdirSync(join(item.root, '~'));
      writeFileSync(
        literalTilde,
        `//registry.npmjs.org/:_authToken=${'${'}MISSING_EMPTY_HOME}\n`,
      );
      // With HOME explicitly empty, npm leaves ~/ forms cwd-relative.
      for (const configured of ['~/custom.npmrc', '~//custom.npmrc']) {
        expect(
          scan(item, { HOME: '', NPM_CONFIG_USERCONFIG: configured }).errors,
        ).toEqual([
          'A registry credential is empty or uses an unsupported expansion.',
        ]);
      }
      // An explicitly empty HOME substitutes to root for ${HOME}/ forms.
      for (const configured of [
        `${'${'}HOME}/${custom}`,
        `${'${'}HOME}//${custom}`,
      ]) {
        expect(
          scan(item, { HOME: '', NPM_CONFIG_USERCONFIG: configured }).errors,
        ).toEqual([
          'A registry credential is empty or uses an unsupported expansion.',
        ]);
      }
      for (const configured of [
        '$HOME/custom.npmrc',
        '~other/custom.npmrc',
        `${'${'}OTHER_HOME}/custom.npmrc`,
      ]) {
        expect(
          scan(item, { NPM_CONFIG_USERCONFIG: configured }).errors,
        ).toEqual(['NPM_CONFIG_USERCONFIG has an unsupported path expansion.']);
      }
    } finally {
      item.cleanup();
    }
  });

  it('uses the injected OS home for default candidates without reading host config', () => {
    const item = fixture();
    try {
      writeFileSync(
        join(item.osHome, '.npmrc'),
        '//registry.npmjs.org/:_authToken=home-token\n',
      );
      writeFileSync(
        join(item.root, '.npmrc'),
        '//registry.example.test/:_authToken=cwd-token\n',
      );
      expect(
        scan(item, {
          GITHUB_WORKSPACE: item.root,
          HOME: undefined,
          NPM_CONFIG_USERCONFIG: undefined,
          RUNNER_TEMP: join(item.root, 'absent-runner'),
        }),
      ).toMatchObject({ credentialEntries: 2, errors: [], scannedFiles: 2 });
      const emptyHomeNpmrc = join(item.root, '~', '.npmrc');
      mkdirSync(join(item.root, '~'));
      writeFileSync(
        emptyHomeNpmrc,
        '//registry.example.test/:_authToken=empty-home-token\n',
      );
      expect(
        scan(item, {
          GITHUB_WORKSPACE: item.root,
          HOME: '',
          NPM_CONFIG_USERCONFIG: undefined,
          RUNNER_TEMP: join(item.root, 'absent-runner'),
        }),
      ).toMatchObject({ credentialEntries: 2, errors: [], scannedFiles: 2 });
    } finally {
      item.cleanup();
    }
  });

  it('counts every unique readable file and credential entry without leaking their contents', () => {
    const item = fixture();
    try {
      writeFileSync(
        item.env.NPM_CONFIG_USERCONFIG,
        '//registry.npmjs.org/:_authToken=private-a\r\n//registry.example.test/:_auth=private-b\n',
      );
      writeFileSync(
        join(item.workspace, '.npmrc'),
        '//registry.example.test:4873/:_authToken=private-c\n',
      );
      const result = scan(item);
      expect(result).toMatchObject({
        credentialEntries: 3,
        errors: [],
        scannedFiles: 2,
      });
      const success = publishNpmrcSuccess(result);
      expect(success).toContain('scanned 2 unique readable regular file(s)');
      expect(success).toContain(
        'inspected 3 registry credential entry/entries',
      );
      expect(success).toContain(
        'NPM_CONFIG_USERCONFIG, HOME/.npmrc, RUNNER_TEMP/.npmrc, and GITHUB_WORKSPACE/.npmrc',
      );
      expect(success).not.toContain('private-a');
      expect(success).not.toContain('private-b');
      expect(success).not.toContain('private-c');
    } finally {
      item.cleanup();
    }
  });

  it('fails closed before reading symlinks, dangling links, directories, FIFOs, unreadable files, and read errors', () => {
    const item = fixture();
    try {
      const path = item.env.NPM_CONFIG_USERCONFIG;
      writeFileSync(path, '//registry.npmjs.org/:_authToken=literal\n');
      rmSync(path);
      symlinkSync(join(item.root, 'target.npmrc'), path, 'file');
      expect(scan(item).errors).toEqual([
        'A configured npmrc candidate is a symlink.',
      ]);

      rmSync(path);
      symlinkSync(join(item.root, 'missing.npmrc'), path, 'file');
      expect(scan(item).errors).toEqual([
        'A configured npmrc candidate is a symlink.',
      ]);

      rmSync(path);
      mkdirSync(path);
      expect(scan(item).errors).toEqual([
        'A configured npmrc candidate is not a regular file.',
      ]);

      const fifoFs = {
        accessSync: () => {
          throw new Error('must not access FIFO');
        },
        lstatSync: (candidate: string) => {
          if (candidate === path) {
            return {
              isFile: () => false,
              isSymbolicLink: () => false,
            };
          }
          throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        },
        readFileSync: () => {
          throw new Error('must not read FIFO');
        },
        realpathSync: (candidate: string) => resolve(candidate),
      };
      const fifo = scanPublishNpmrcCredentials({
        cwd: item.root,
        env: {
          ...item.env,
          HOME: join(item.root, 'absent-home'),
          RUNNER_TEMP: join(item.root, 'absent-runner'),
          GITHUB_WORKSPACE: join(item.root, 'absent-workspace'),
        },
        fs: fifoFs as never,
      });
      expect(fifo.errors).toEqual([
        'A configured npmrc candidate is not a regular file.',
      ]);

      rmSync(path, { recursive: true });
      writeFileSync(path, '//registry.npmjs.org/:_authToken=literal\n');
      const unreadable = scanPublishNpmrcCredentials({
        cwd: item.root,
        env: item.env,
        fs: {
          closeSync,
          fstatSync,
          lstatSync,
          openSync: () => {
            throw new Error('permission denied');
          },
          readFileSync,
          realpathSync,
        } as never,
      });
      expect(unreadable.errors).toEqual([
        'A configured npmrc candidate could not be opened safely.',
      ]);

      const readFailure = scanPublishNpmrcCredentials({
        cwd: item.root,
        env: item.env,
        fs: {
          closeSync,
          fstatSync,
          lstatSync,
          openSync,
          readFileSync: () => {
            throw new Error('read failure');
          },
          realpathSync,
        } as never,
      });
      expect(readFailure.errors).toEqual([
        'A configured npmrc candidate could not be opened safely.',
      ]);
    } finally {
      item.cleanup();
    }
  });

  it('never follows or blocks on a leaf swapped after canonicalization', () => {
    const item = fixture();
    try {
      const path = item.env.NPM_CONFIG_USERCONFIG;
      writeFileSync(path, '//registry.npmjs.org/:_authToken=literal\n');
      const noOtherCandidates = {
        GITHUB_WORKSPACE: join(item.root, 'absent-workspace'),
        HOME: join(item.root, 'absent-home'),
        RUNNER_TEMP: join(item.root, 'absent-runner'),
      };
      const expectedFlags =
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
      const symlinkRace = scanPublishNpmrcCredentials({
        cwd: item.root,
        env: { ...item.env, ...noOtherCandidates },
        fs: {
          closeSync: () => {
            throw new Error('no descriptor should be closed');
          },
          fstatSync: () => {
            throw new Error('must not stat a refused symlink');
          },
          lstatSync,
          openSync: (_candidate: string, flags: number) => {
            expect(flags).toBe(expectedFlags);
            throw Object.assign(new Error('symlink race'), { code: 'ELOOP' });
          },
          readFileSync: () => {
            throw new Error('must not read a refused symlink');
          },
          realpathSync,
        } as never,
      });
      expect(symlinkRace.errors).toEqual([
        'A configured npmrc candidate could not be opened safely.',
      ]);

      const closed: number[] = [];
      const fifoRace = scanPublishNpmrcCredentials({
        cwd: item.root,
        env: { ...item.env, ...noOtherCandidates },
        fs: {
          closeSync: (descriptor: number) => closed.push(descriptor),
          fstatSync: () => ({ isFile: () => false }),
          lstatSync,
          openSync: (_candidate: string, flags: number) => {
            expect(flags).toBe(expectedFlags);
            return 73;
          },
          readFileSync: () => {
            throw new Error('must not read a FIFO');
          },
          realpathSync,
        } as never,
      });
      expect(fifoRace.errors).toEqual([
        'A configured npmrc candidate is not a regular file.',
      ]);
      expect(closed).toEqual([73]);
    } finally {
      item.cleanup();
    }
  });

  it('keeps CLI failures generic and redacted', () => {
    const item = fixture();
    try {
      writeFileSync(
        item.env.NPM_CONFIG_USERCONFIG,
        `//registry.npmjs.org/:_authToken=${'${'}MISSING_PRIVATE_VALUE}\n`,
      );
      const output: string[] = [];
      const errors: string[] = [];
      expect(
        runPublishNpmrcCredentialCheck({
          cwd: item.root,
          env: item.env,
          writeError: (message: string) => errors.push(message),
          writeOutput: (message: string) => output.push(message),
        }),
      ).toBe(1);
      expect(output).toEqual([]);
      expect(errors).toEqual([
        'Publish npmrc credential preflight failed. Correct the npmrc configuration before publishing.',
      ]);
      expect(errors.join('\n')).not.toContain('MISSING_PRIVATE_VALUE');
    } finally {
      item.cleanup();
    }
  });
});
