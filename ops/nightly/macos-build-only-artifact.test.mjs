import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  assertSafeArchiveEntries,
  assertSafeArchiveFile,
  createExclusiveDirectory,
  validateBuildOnlyOutput,
} from './macos-build-only-artifact.mjs';

describe('macOS Nightly build-only artifact boundary', () => {
  const realpath = (path) =>
    ({ '/link': '/Applications', '/repo-link': '/repo' })[path] ?? path;
  it('canonicalizes relative paths and rejects application, source, and staging overlap', () => {
    expect(
      validateBuildOnlyOutput({
        outputDir: 'out',
        invocationCwd: '/work',
        forbiddenRoots: ['/Applications', '/repo', '/cache/staging'],
        realpath,
      }),
    ).toBe('/work/out');
    for (const outputDir of ['/link', '/repo-link', '/cache/staging/out'])
      expect(() =>
        validateBuildOnlyOutput({
          outputDir,
          invocationCwd: '/work',
          forbiddenRoots: ['/Applications', '/repo', '/cache/staging'],
          realpath,
        }),
      ).toThrow(/overlaps protected/);
  });
  it('acquires the final output directory exclusively', () => {
    expect(() =>
      createExclusiveDirectory('/out', {
        mkdir: () => {
          const error = new Error('exists');
          error.code = 'EEXIST';
          throw error;
        },
      }),
    ).toThrow(/already exists/);
  });
  it('rejects archive paths that disclose homes or private keys before publication', () => {
    expect(() =>
      assertSafeArchiveEntries([
        'Station Nightly.app/Contents/Resources/node_modules/openai/resources/admin/organization/users/index.mjs',
        'Station Nightly.app/Contents/Resources/node_modules/openai/resources/projects/users/index.mjs',
      ]),
    ).not.toThrow();
    expect(() =>
      assertSafeArchiveEntries(['Station Nightly.app/Users/a/.ssh/id_rsa']),
    ).toThrow(/user-home/);
    expect(() =>
      assertSafeArchiveEntries(['Station Nightly.app/home/a/.aws/credentials']),
    ).toThrow(/user-home/);
    for (const credentialPath of [
      'Station Nightly.app/.ssh/id_rsa',
      'Station Nightly.app/.aws/credentials',
      'Station Nightly.app/.SSH/id_rsa',
    ]) {
      expect(() => assertSafeArchiveEntries([credentialPath])).toThrow(
        /private-key/,
      );
    }
    for (const extension of ['PEM', 'P12', 'P8', 'KEY']) {
      expect(() =>
        assertSafeArchiveEntries([
          `Station Nightly.app/Contents/credential.${extension}`,
        ]),
      ).toThrow(/private-key/);
    }
    expect(() =>
      assertSafeArchiveEntries(['Station Nightly.app/Contents/key.pem']),
    ).toThrow(/private-key/);
  });
  it('uses a bounded large listing and fails closed without listing output', () => {
    const runner = (source) => (_command, _args, options) =>
      execFileSync(process.execPath, ['-e', source], options);
    expect(
      assertSafeArchiveFile('/archive', {
        run: runner(
          'process.stdout.write("Station Nightly.app/Contents/file\\n".repeat(40000))',
        ),
      }),
    ).toBeUndefined();
    expect(() =>
      assertSafeArchiveFile('/archive', {
        run: runner(
          'process.stdout.write("Station Nightly.app/Contents/file\\n".repeat(40000) + "Users/none\\n")',
        ),
      }),
    ).toThrow(/user-home/);
    expect(() =>
      assertSafeArchiveFile('/archive', {
        run: runner('process.stdout.write("x".repeat(2000000))'),
        maxBuffer: 1,
      }),
    ).toThrow('Nightly archive listing could not be validated.');
    expect(() =>
      assertSafeArchiveFile('/archive', {
        run: () => {
          throw new Error('secret stdout');
        },
      }),
    ).toThrow('Nightly archive listing could not be validated.');
  });
});
