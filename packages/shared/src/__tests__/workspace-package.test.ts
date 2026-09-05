import { execFileSync } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createWorkspacePackageKey,
  inspectWorkspacePackage,
  packWorkspace,
  unpackWorkspace,
} from '../workspace-package.js';
import * as packageIo from '../workspace-package-io.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, args: string[]): Buffer {
  return execFileSync(
    'git',
    [
      '-c',
      `core.hooksPath=${devNull}`,
      '-c',
      'core.fsmonitor=false',
      '-C',
      cwd,
      ...args,
    ],
    { windowsHide: true, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}
function fixture(format: 'sha1' | 'sha256' = 'sha1') {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-workspace-package-test-')),
  );
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, [
    'init',
    '--template=',
    '--initial-branch=main',
    `--object-format=${format}`,
  ]);
  git(source, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(source, '.gitignore'), 'ignored-secret\n');
  writeFileSync(join(source, 'a.txt'), 'committed\n');
  writeFileSync(join(source, 'delete.txt'), 'delete me\n');
  git(source, ['add', '.']);
  git(source, [
    '-c',
    'user.name=Workspace test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'Initial',
  ]);
  const keyFile = join(root, 'key');
  const output = join(root, 'workspace.enc');
  createWorkspacePackageKey(keyFile);
  const pack = () =>
    packWorkspace({ workspace: source, keyFile, output, sourcePaused: true });
  const destination = join(root, 'imported');
  const unpack = () =>
    unpackWorkspace({ archive: output, keyFile, destination });
  return { root, source, keyFile, output, destination, pack, unpack };
}
function rewriteAuthenticated(
  output: string,
  keyFile: string,
  change: (payload: any) => void,
) {
  const raw = readFileSync(output);
  const magic = Buffer.from('station-workspace-package/v1\0');
  const key = readFileSync(keyFile);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    raw.subarray(magic.length, magic.length + 12),
  );
  decipher.setAAD(magic);
  decipher.setAuthTag(raw.subarray(magic.length + 12, magic.length + 28));
  const payload = JSON.parse(
    gunzipSync(
      Buffer.concat([
        decipher.update(raw.subarray(magic.length + 28)),
        decipher.final(),
      ]),
    ).toString(),
  );
  change(payload);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(magic);
  const encrypted = Buffer.concat([
    cipher.update(gzipSync(Buffer.from(JSON.stringify(payload)))),
    cipher.final(),
  ]);
  writeFileSync(
    output,
    Buffer.concat([magic, iv, cipher.getAuthTag(), encrypted]),
  );
}

// These cases execute real Git processes; budget includes Windows process startup.
describe('encrypted workspace package', { timeout: 30000 }, () => {
  test('preserves HEAD, staged/unstaged changes, deletion and untracked binary files without copying machine configuration', () => {
    const f = fixture();
    writeFileSync(join(f.source, 'a.txt'), 'staged\n');
    git(f.source, ['add', 'a.txt']);
    writeFileSync(join(f.source, 'a.txt'), 'unstaged\n');
    rmSync(join(f.source, 'delete.txt'));
    writeFileSync(join(f.source, 'new.bin'), Buffer.from([0, 1, 255, 2]));
    writeFileSync(join(f.source, 'ignored-secret'), 'DO-NOT-COPY');
    git(f.source, [
      'config',
      'remote.origin.url',
      'https://user:PRIVATE-CREDENTIAL@example.invalid/repo',
    ]);
    mkdirSync(join(f.source, '.git', 'hooks'));
    writeFileSync(
      join(f.source, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\ntouch hook-executed\n',
      { mode: 0o755 },
    );
    const head = git(f.source, ['rev-parse', 'HEAD']).toString();
    const index = git(f.source, ['ls-files', '--stage']).toString();
    const status = git(f.source, ['status', '--porcelain=v1']).toString();
    f.pack();
    const result = f.unpack();
    expect(git(result.workspace, ['rev-parse', 'HEAD']).toString()).toBe(head);
    expect(git(result.workspace, ['ls-files', '--stage']).toString()).toBe(
      index,
    );
    expect(git(result.workspace, ['status', '--porcelain=v1']).toString()).toBe(
      status,
    );
    expect(readFileSync(join(result.workspace, 'a.txt'), 'utf8')).toBe(
      'unstaged\n',
    );
    expect(readFileSync(join(result.workspace, 'new.bin'))).toEqual(
      Buffer.from([0, 1, 255, 2]),
    );
    expect(existsSync(join(result.workspace, 'ignored-secret'))).toBe(false);
    expect(existsSync(join(result.workspace, 'hook-executed'))).toBe(false);
    expect(
      readFileSync(join(result.workspace, '.git', 'config'), 'utf8'),
    ).not.toContain('PRIVATE-CREDENTIAL');
    expect(git(f.source, ['status', '--porcelain=v1']).toString()).toBe(status);
    expect(git(f.source, ['ls-files', '--stage']).toString()).toBe(index);
    expect(
      inspectWorkspacePackage({ archive: f.output, keyFile: f.keyFile })
        .executionAuthorityTransferred,
    ).toBe(false);
  });
  test('retains staged new blob objects and supports linked worktree metadata without copying its absolute gitdir', () => {
    const f = fixture();
    const linked = join(f.root, 'linked');
    git(f.source, ['worktree', 'add', '-b', 'feature/linked', linked]);
    writeFileSync(join(linked, 'staged.txt'), 'staged new blob\n');
    git(linked, ['add', 'staged.txt']);
    writeFileSync(join(linked, 'staged.txt'), 'later working bytes\n');
    packWorkspace({
      workspace: linked,
      output: f.output,
      keyFile: f.keyFile,
      sourcePaused: true,
    });
    const result = f.unpack();
    expect(git(result.workspace, ['show', ':staged.txt']).toString()).toBe(
      'staged new blob\n',
    );
    expect(readFileSync(join(result.workspace, 'staged.txt'), 'utf8')).toBe(
      'later working bytes\n',
    );
    expect(
      git(result.workspace, ['branch', '--show-current']).toString().trim(),
    ).toBe('feature/linked');
    expect(
      readFileSync(join(result.workspace, '.git', 'config'), 'utf8'),
    ).not.toContain(f.source);
  });
  test('refuses package and key paths inside a linked worktree backing Git directory', () => {
    const f = fixture();
    const linked = join(f.root, 'linked');
    git(f.source, ['worktree', 'add', '-b', 'feature/linked', linked]);
    const hiddenKey = join(f.source, '.git', 'package.key');
    createWorkspacePackageKey(hiddenKey);
    expect(() =>
      packWorkspace({
        workspace: linked,
        output: f.output,
        keyFile: hiddenKey,
        sourcePaused: true,
      }),
    ).toThrow('backing Git directory');
    expect(() =>
      packWorkspace({
        workspace: linked,
        output: join(f.source, '.git', 'package.enc'),
        keyFile: f.keyFile,
        sourcePaused: true,
      }),
    ).toThrow('backing Git directory');
    expect(existsSync(f.output)).toBe(false);
  });
  test('rejects a source write after bundle capture before publishing an archive', () => {
    const f = fixture();
    const original = packageIo.packageGit;
    const spy = vi
      .spyOn(packageIo, 'packageGit')
      .mockImplementation((cwd, args, input, policy) => {
        const result = original(cwd, args, input, policy);
        if (args[0] === 'bundle')
          writeFileSync(join(f.source, 'a.txt'), 'concurrent write\n');
        return result;
      });
    try {
      expect(f.pack).toThrow('Source changed during capture');
      expect(existsSync(f.output)).toBe(false);
      expect(readFileSync(join(f.source, 'a.txt'), 'utf8')).toBe(
        'concurrent write\n',
      );
    } finally {
      spy.mockRestore();
    }
  });
  test.skipIf(process.platform === 'win32')(
    'preserves executable file intent on POSIX',
    () => {
      const f = fixture();
      git(f.source, ['config', 'core.filemode', 'true']);
      chmodSync(join(f.source, 'a.txt'), 0o700);
      git(f.source, ['add', 'a.txt']);
      f.pack();
      const result = f.unpack();
      expect(
        git(result.workspace, ['ls-files', '--stage', 'a.txt']).toString(),
      ).toMatch(/^100755 /);
      expect(
        packageIo
          .readBoundedFile(join(result.workspace, 'a.txt'), 100)
          .toString(),
      ).toBe('committed\n');
      expect(git(result.workspace, ['diff', '--raw']).toString()).toBe('');
    },
  );
  test('preserves detached HEAD and reviewed CRLF policy', () => {
    const f = fixture();
    git(f.source, ['checkout', '--detach']);
    git(f.source, ['config', 'core.autocrlf', 'true']);
    writeFileSync(join(f.source, 'a.txt'), 'committed\r\n');
    f.pack();
    const result = f.unpack();
    expect(result.branch).toBeNull();
    expect(
      git(result.workspace, ['config', 'core.autocrlf']).toString().trim(),
    ).toBe('true');
    expect(
      git(result.workspace, [
        'diff',
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
      ]).toString(),
    ).toBe(
      git(f.source, [
        'diff',
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
      ]).toString(),
    );
  });
  test('honors source global ignores without transporting their machine-specific configuration', () => {
    const f = fixture();
    const global = join(f.root, 'gitconfig');
    const ignore = join(f.root, 'ignore');
    writeFileSync(ignore, 'global-secret\n');
    git(f.source, ['config', '--file', global, 'core.excludesFile', ignore]);
    writeFileSync(join(f.source, 'global-secret'), 'PRIVATE-GLOBAL');
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    try {
      f.pack();
      const result = f.unpack();
      expect(existsSync(join(result.workspace, 'global-secret'))).toBe(false);
      expect(
        readFileSync(join(result.workspace, '.git', 'config'), 'utf8'),
      ).not.toContain(ignore);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  test('refuses external attribute policy instead of silently changing content interpretation', () => {
    const f = fixture();
    const global = join(f.root, 'gitconfig');
    const attributes = join(f.root, 'attributes');
    writeFileSync(attributes, '* -text\n');
    git(f.source, [
      'config',
      '--file',
      global,
      'core.attributesFile',
      attributes,
    ]);
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    try {
      expect(f.pack).toThrow('External Git attribute policy');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  test('authenticates before creating any destination and refuses overwrite', () => {
    const f = fixture();
    f.pack();
    const original = readFileSync(f.output);
    const wrong = join(f.root, 'wrong-key');
    createWorkspacePackageKey(wrong);
    expect(() =>
      unpackWorkspace({
        archive: f.output,
        keyFile: wrong,
        destination: f.destination,
      }),
    ).toThrow('authentication');
    expect(existsSync(f.destination)).toBe(false);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] ^= 1;
    writeFileSync(f.output, tampered);
    expect(f.unpack).toThrow('authentication');
    expect(existsSync(f.destination)).toBe(false);
    writeFileSync(f.output, original);
    mkdirSync(f.destination);
    writeFileSync(join(f.destination, 'preserve'), 'existing');
    expect(f.unpack).toThrow();
    expect(readFileSync(join(f.destination, 'preserve'), 'utf8')).toBe(
      'existing',
    );
    expect(f.pack).toThrow('already exists');
  });
  test.each([
    '../escape',
    '/absolute',
    'C:/escape',
    'a\\b',
    '.git/config',
    'CON.txt',
    'git~1/hooks/run',
    '.g\u200cit/config',
    'trailing.',
  ])(
    'rejects authenticated unsafe path %s before creating a destination',
    (path) => {
      const f = fixture();
      f.pack();
      rewriteAuthenticated(f.output, f.keyFile, (payload) => {
        payload.files[0].path = path;
      });
      expect(f.unpack).toThrow();
      expect(existsSync(f.destination)).toBe(false);
    },
  );
  test('rejects authenticated config injection and case collisions', () => {
    const f = fixture();
    f.pack();
    const original = readFileSync(f.output);
    rewriteAuthenticated(f.output, f.keyFile, (payload) => {
      payload.policy.hooksPath = '/attacker/hooks';
    });
    expect(f.unpack).toThrow('content policy');
    expect(existsSync(f.destination)).toBe(false);
    writeFileSync(f.output, original);
    rewriteAuthenticated(f.output, f.keyFile, (payload) => {
      payload.files.push({
        ...payload.files[0],
        path: payload.files[0].path.toUpperCase(),
      });
    });
    expect(f.unpack).toThrow('colliding');
    expect(existsSync(f.destination)).toBe(false);
  });
  test('rejects a corrupt authenticated pack before creating the destination', () => {
    const f = fixture();
    f.pack();
    rewriteAuthenticated(f.output, f.keyFile, (payload) => {
      payload.bundle = Buffer.from('not a Git bundle').toString('base64');
    });
    expect(f.unpack).toThrow('Git bundle header');
    expect(existsSync(f.destination)).toBe(false);
  });
  test('cleans its fresh destination if staged object references cannot be resolved', () => {
    const f = fixture();
    f.pack();
    rewriteAuthenticated(f.output, f.keyFile, (payload) => {
      payload.index[0].oid = 'f'.repeat(40);
    });
    expect(f.unpack).toThrow('Invalid staged object');
    expect(existsSync(f.destination)).toBe(false);
  });
  test.skipIf(process.platform === 'win32')(
    'rejects nonportable and overly long branches before publishing a package',
    () => {
      for (const name of ['feature/CON', 'a'.repeat(201)]) {
        const f = fixture();
        git(f.source, ['checkout', '-b', name]);
        expect(f.pack).toThrow();
        expect(existsSync(f.output)).toBe(false);
      }
    },
  );
  test('round-trips SHA-256 Git objects', () => {
    const f = fixture('sha256');
    f.pack();
    const result = f.unpack();
    expect(result.head).toHaveLength(64);
    expect(git(result.workspace, ['rev-parse', 'HEAD']).toString().trim()).toBe(
      result.head,
    );
  });
  test('admits real delta-compressed history within the expanded byte budget', () => {
    const f = fixture();
    for (let revision = 0; revision < 8; revision++) {
      writeFileSync(
        join(f.source, 'history.txt'),
        `${'repeated text\n'.repeat(10000)}${revision}\n`,
      );
      git(f.source, ['add', 'history.txt']);
      git(f.source, [
        '-c',
        'user.name=Workspace test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-m',
        `Revision ${revision}`,
      ]);
    }
    f.pack();
    const result = f.unpack();
    expect(
      git(result.workspace, ['rev-list', '--count', 'HEAD']).toString(),
    ).toBe('9\n');
    expect(readFileSync(join(result.workspace, 'history.txt'))).toEqual(
      readFileSync(join(f.source, 'history.txt')),
    );
  });
  test('refuses oversized historical objects during export even when current files are small', () => {
    const f = fixture();
    writeFileSync(
      join(f.source, 'old-large'),
      Buffer.alloc(8 * 1024 * 1024 + 1),
    );
    git(f.source, ['add', 'old-large']);
    git(f.source, [
      '-c',
      'user.name=Workspace test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'Old blob',
    ]);
    git(f.source, ['rm', 'old-large']);
    git(f.source, [
      '-c',
      'user.name=Workspace test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'Remove blob',
    ]);
    expect(f.pack).toThrow('expanded size limit');
    expect(existsSync(f.output)).toBe(false);
  });
  test.each(['blob', 'delta', 'delta-budget'] as const)(
    'rejects authenticated %s expansion before invoking Git or creating a destination',
    (kind) => {
      const f = fixture();
      f.pack();
      rewriteAuthenticated(f.output, f.keyFile, (payload) => {
        const encode = (value: number, firstBits = 7, type = 0) => {
          const out: number[] = [];
          let first = (type << 4) | (value % 2 ** firstBits);
          value = Math.floor(value / 2 ** firstBits);
          if (value) first |= 128;
          out.push(first);
          while (value) {
            let byte = value % 128;
            value = Math.floor(value / 128);
            if (value) byte |= 128;
            out.push(byte);
          }
          return Buffer.from(out);
        };
        const count = kind === 'delta-budget' ? 9 : 1;
        const header = Buffer.alloc(12);
        header.write('PACK');
        header.writeUInt32BE(2, 4);
        header.writeUInt32BE(count, 8);
        const content =
          kind === 'blob'
            ? Buffer.alloc(8 * 1024 * 1024 + 1)
            : kind === 'delta'
              ? Buffer.concat([encode(0), encode(8 * 1024 * 1024 + 1)])
              : Buffer.alloc(8 * 1024 * 1024);
        const object = Buffer.concat([
          encode(content.length, 4, kind === 'blob' ? 3 : 7),
          ...(kind === 'blob' ? [] : [Buffer.alloc(20)]),
          deflateSync(content),
        ]);
        const pack = Buffer.concat([
          header,
          ...Array.from({ length: count }, () => object),
        ]);
        payload.bundle = Buffer.concat([
          Buffer.from(`# v2 git bundle\n${payload.head} HEAD\n\n`),
          pack,
          createHash('sha1').update(pack).digest(),
        ]).toString('base64');
      });
      expect(() =>
        inspectWorkspacePackage({ archive: f.output, keyFile: f.keyFile }),
      ).toThrow(
        kind === 'delta-budget' ? 'expanded byte limit' : 'expanded size limit',
      );
      expect(existsSync(f.destination)).toBe(false);
    },
  );
  test('refuses unpaused capture, keys inside the workspace, and unsupported filter/intent-to-add state', () => {
    const f = fixture();
    expect(() =>
      packWorkspace({
        workspace: f.source,
        output: f.output,
        keyFile: f.keyFile,
        sourcePaused: false,
      }),
    ).toThrow('Pause');
    const inside = join(f.source, 'key');
    createWorkspacePackageKey(inside);
    expect(() =>
      packWorkspace({
        workspace: f.source,
        output: f.output,
        keyFile: inside,
        sourcePaused: true,
      }),
    ).toThrow('outside');
    rmSync(inside);
    writeFileSync(join(f.source, '.gitattributes'), '*.txt filter=custom\n');
    expect(f.pack).toThrow('External Git filters');
    rmSync(join(f.source, '.gitattributes'));
    writeFileSync(join(f.source, 'ita.txt'), 'intent');
    git(f.source, ['add', '-N', 'ita.txt']);
    expect(f.pack).toThrow('Intent-to-add');
  });
  test.skipIf(process.platform === 'win32')(
    'refuses symbolic links and non-private keys',
    () => {
      const f = fixture();
      symlinkSync(
        join(f.source, 'a.txt'),
        join(f.source, 'link'),
        process.platform === 'win32' ? 'file' : undefined,
      );
      expect(f.pack).toThrow('regular file');
      rmSync(join(f.source, 'link'));
      if (process.platform !== 'win32') {
        chmodSync(f.keyFile, 0o644);
        expect(f.pack).toThrow('private file permissions');
      }
    },
  );
});
