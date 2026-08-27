import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareOwnedNightlySourceCheckout } from './owned-source-checkout.mjs';

const roots = [];

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function ownedGit(args, checkout) {
  return git([`--git-dir=${join(checkout, '.git')}`, ...args], checkout);
}

function commit(directory, message, contents) {
  writeFileSync(join(directory, 'version.txt'), contents);
  git(['add', 'version.txt'], directory);
  git(['commit', '-m', message], directory);
  return git(['rev-parse', 'HEAD'], directory);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station nightly owned source-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const cachedRemote = join(root, 'cached-remote.git');
  const publisher = join(root, 'publisher');
  const source = join(root, 'user-checkout');
  const ownedRoot = join(root, 'nightly-cache');
  const owned = join(ownedRoot, 'build-checkout-v2');
  git(['init', '--bare', remote]);
  git(['init', '--bare', cachedRemote]);
  git(['init', '--initial-branch=main', publisher]);
  git(['config', 'user.email', 'fixture@example.test'], publisher);
  git(['config', 'user.name', 'Fixture'], publisher);
  git(['remote', 'add', 'origin', remote], publisher);
  const first = commit(publisher, 'first', 'one\n');
  git(['push', '-u', 'origin', 'main'], publisher);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  git(['clone', remote, source]);
  git(['config', 'user.email', 'fixture@example.test'], source);
  git(['config', 'user.name', 'Fixture'], source);
  git(['checkout', '-b', 'user-work'], source);
  writeFileSync(join(source, 'version.txt'), 'user dirty edit\n');
  mkdirSync(ownedRoot);
  return {
    first,
    cachedRemote,
    owned,
    ownedRoot,
    publisher,
    remote,
    root,
    source,
    advance() {
      const next = commit(publisher, 'second', 'two\n');
      git(['push', 'origin', 'main'], publisher);
      return next;
    },
  };
}

afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

describe('owned Nightly source checkout', () => {
  it('advances twice from remote main without switching or cleaning the user checkout', () => {
    const subject = fixture();
    const userHead = git(['rev-parse', 'HEAD'], subject.source);
    const cli = join(subject.root, 'owned source checkout cli.mjs');
    copyFileSync(
      resolve(import.meta.dirname, 'owned-source-checkout.mjs'),
      cli,
    );
    const first = execFileSync(
      process.execPath,
      [cli, subject.source, subject.owned, subject.ownedRoot],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    ).trim();
    expect(first).toBe(subject.first);
    expect(git(['rev-parse', 'HEAD'], subject.owned)).toBe(subject.first);

    const second = subject.advance();
    expect(
      prepareOwnedNightlySourceCheckout({
        sourceCheckout: subject.source,
        ownedCheckout: subject.owned,
        ownedRoot: subject.ownedRoot,
      }),
    ).toBe(second);
    expect(git(['rev-parse', 'HEAD'], subject.owned)).toBe(second);
    expect(
      existsSync(join(subject.ownedRoot, 'build-checkout.owner.json')),
    ).toBe(false);
    expect(git(['branch', '--show-current'], subject.source)).toBe('user-work');
    expect(git(['rev-parse', 'HEAD'], subject.source)).toBe(userHead);
    expect(git(['status', '--porcelain'], subject.source)).toContain(
      'M version.txt',
    );
    expect(readFileSync(join(subject.source, 'version.txt'), 'utf8')).toBe(
      'user dirty edit\n',
    );
  });

  it('leaves legacy unmarked build-checkout untouched while v2 refreshes', () => {
    const subject = fixture();
    const legacy = join(subject.ownedRoot, 'build-checkout');
    git(['clone', subject.remote, legacy]);
    git(['checkout', '-b', 'legacy-user-work'], legacy);
    writeFileSync(join(legacy, 'version.txt'), 'legacy dirty edit\n');
    const branch = git(['branch', '--show-current'], legacy);
    const head = git(['rev-parse', 'HEAD'], legacy);
    const origin = git(['remote', 'get-url', 'origin'], legacy);
    const contents = readFileSync(join(legacy, 'version.txt'), 'utf8');

    expect(
      prepareOwnedNightlySourceCheckout({
        sourceCheckout: subject.source,
        ownedCheckout: subject.owned,
        ownedRoot: subject.ownedRoot,
      }),
    ).toBe(subject.first);
    expect(
      existsSync(join(subject.ownedRoot, 'build-checkout-v2.owner.json')),
    ).toBe(true);
    expect(
      existsSync(join(subject.ownedRoot, 'build-checkout.owner.json')),
    ).toBe(false);
    const second = subject.advance();
    expect(
      prepareOwnedNightlySourceCheckout({
        sourceCheckout: subject.source,
        ownedCheckout: subject.owned,
        ownedRoot: subject.ownedRoot,
      }),
    ).toBe(second);
    expect(git(['rev-parse', 'HEAD'], subject.owned)).toBe(second);
    expect(
      existsSync(join(subject.ownedRoot, 'build-checkout.owner.json')),
    ).toBe(false);
    expect(git(['branch', '--show-current'], legacy)).toBe(branch);
    expect(git(['rev-parse', 'HEAD'], legacy)).toBe(head);
    expect(git(['remote', 'get-url', 'origin'], legacy)).toBe(origin);
    expect(readFileSync(join(legacy, 'version.txt'), 'utf8')).toBe(contents);
  });

  it('rejects a ..cache child of the source checkout before clone or mutation', () => {
    const subject = fixture();
    const ownedRoot = join(subject.source, '..cache');
    const ownedCheckout = join(ownedRoot, 'build-checkout-v2');
    mkdirSync(ownedRoot);
    const branch = git(['branch', '--show-current'], subject.source);
    const head = git(['rev-parse', 'HEAD'], subject.source);
    const origin = git(['remote', 'get-url', 'origin'], subject.source);
    const contents = readFileSync(join(subject.source, 'version.txt'), 'utf8');

    expect(() =>
      prepareOwnedNightlySourceCheckout({
        sourceCheckout: subject.source,
        ownedCheckout,
        ownedRoot,
      }),
    ).toThrow(/must not overlap/);
    expect(existsSync(ownedCheckout)).toBe(false);
    expect(git(['branch', '--show-current'], subject.source)).toBe(branch);
    expect(git(['rev-parse', 'HEAD'], subject.source)).toBe(head);
    expect(git(['remote', 'get-url', 'origin'], subject.source)).toBe(origin);
    expect(readFileSync(join(subject.source, 'version.txt'), 'utf8')).toBe(
      contents,
    );
  });

  it.each(['source', 'sibling'])(
    'refuses an owned-checkout symlink to a %s user repository before Git mutation',
    (target) => {
      const subject = fixture();
      const sibling = join(subject.root, 'sibling-user-repository');
      git(['clone', subject.remote, sibling]);
      git(['checkout', '-b', 'sibling-work'], sibling);
      writeFileSync(join(sibling, 'version.txt'), 'sibling dirty edit\n');
      rmSync(subject.owned, { recursive: true, force: true });
      symlinkSync(
        target === 'source' ? subject.source : sibling,
        subject.owned,
      );
      const protectedCheckout = target === 'source' ? subject.source : sibling;
      const branch = git(['branch', '--show-current'], protectedCheckout);
      const head = git(['rev-parse', 'HEAD'], protectedCheckout);
      const origin = git(['remote', 'get-url', 'origin'], protectedCheckout);
      const contents = readFileSync(
        join(protectedCheckout, 'version.txt'),
        'utf8',
      );

      expect(() =>
        prepareOwnedNightlySourceCheckout({
          sourceCheckout: subject.source,
          ownedCheckout: subject.owned,
          ownedRoot: subject.ownedRoot,
        }),
      ).toThrow(/symbolic link/);
      expect(git(['branch', '--show-current'], protectedCheckout)).toBe(branch);
      expect(git(['rev-parse', 'HEAD'], protectedCheckout)).toBe(head);
      expect(git(['remote', 'get-url', 'origin'], protectedCheckout)).toBe(
        origin,
      );
      expect(readFileSync(join(protectedCheckout, 'version.txt'), 'utf8')).toBe(
        contents,
      );
    },
  );

  it('refuses an unmarked sibling repository at the owned cache path', () => {
    const subject = fixture();
    git(['clone', subject.remote, subject.owned]);
    git(['checkout', '-b', 'sibling-work'], subject.owned);
    writeFileSync(join(subject.owned, 'version.txt'), 'sibling dirty edit\n');
    const branch = git(['branch', '--show-current'], subject.owned);
    const head = git(['rev-parse', 'HEAD'], subject.owned);
    const origin = git(['remote', 'get-url', 'origin'], subject.owned);
    const contents = readFileSync(join(subject.owned, 'version.txt'), 'utf8');

    expect(() =>
      prepareOwnedNightlySourceCheckout({
        sourceCheckout: subject.source,
        ownedCheckout: subject.owned,
        ownedRoot: subject.ownedRoot,
      }),
    ).toThrow(/ownership marker/);
    expect(git(['branch', '--show-current'], subject.owned)).toBe(branch);
    expect(git(['rev-parse', 'HEAD'], subject.owned)).toBe(head);
    expect(git(['remote', 'get-url', 'origin'], subject.owned)).toBe(origin);
    expect(readFileSync(join(subject.owned, 'version.txt'), 'utf8')).toBe(
      contents,
    );
  });

  it('refuses a linked-worktree git file before remote or checkout mutation', () => {
    const subject = fixture();
    git(
      ['worktree', 'add', '-b', 'linked-user-work', subject.owned],
      subject.source,
    );
    writeFileSync(join(subject.owned, 'version.txt'), 'linked dirty edit\n');
    const branch = git(['branch', '--show-current'], subject.owned);
    const head = git(['rev-parse', 'HEAD'], subject.owned);
    const origin = git(['remote', 'get-url', 'origin'], subject.owned);
    const contents = readFileSync(join(subject.owned, 'version.txt'), 'utf8');

    expect(() =>
      prepareOwnedNightlySourceCheckout({
        sourceCheckout: subject.source,
        ownedCheckout: subject.owned,
        ownedRoot: subject.ownedRoot,
      }),
    ).toThrow(/standalone Git checkout/);
    expect(git(['branch', '--show-current'], subject.owned)).toBe(branch);
    expect(git(['rev-parse', 'HEAD'], subject.owned)).toBe(head);
    expect(git(['remote', 'get-url', 'origin'], subject.owned)).toBe(origin);
    expect(readFileSync(join(subject.owned, 'version.txt'), 'utf8')).toBe(
      contents,
    );
  });

  it('refuses a configured external Git worktree before remote or checkout mutation', () => {
    const subject = fixture();
    prepareOwnedNightlySourceCheckout({
      sourceCheckout: subject.source,
      ownedCheckout: subject.owned,
      ownedRoot: subject.ownedRoot,
    });
    const sibling = join(subject.root, 'configured-user-worktree');
    git(['clone', subject.remote, sibling]);
    git(['checkout', '-b', 'configured-user-work'], sibling);
    writeFileSync(join(sibling, 'version.txt'), 'configured dirty edit\n');
    git(['remote', 'set-url', 'origin', subject.cachedRemote], subject.owned);
    const ownedHead = ownedGit(['rev-parse', 'HEAD'], subject.owned);
    const ownedOrigin = ownedGit(
      ['config', '--get', 'remote.origin.url'],
      subject.owned,
    );
    git(['config', 'core.worktree', sibling], subject.owned);
    const branch = git(['branch', '--show-current'], sibling);
    const head = git(['rev-parse', 'HEAD'], sibling);
    const origin = git(['remote', 'get-url', 'origin'], sibling);
    const contents = readFileSync(join(sibling, 'version.txt'), 'utf8');

    expect(() =>
      prepareOwnedNightlySourceCheckout({
        sourceCheckout: subject.source,
        ownedCheckout: subject.owned,
        ownedRoot: subject.ownedRoot,
      }),
    ).toThrow(/Git worktree escapes/);
    expect(ownedGit(['rev-parse', 'HEAD'], subject.owned)).toBe(ownedHead);
    expect(
      ownedGit(['config', '--get', 'remote.origin.url'], subject.owned),
    ).toBe(ownedOrigin);
    expect(git(['branch', '--show-current'], sibling)).toBe(branch);
    expect(git(['rev-parse', 'HEAD'], sibling)).toBe(head);
    expect(git(['remote', 'get-url', 'origin'], sibling)).toBe(origin);
    expect(readFileSync(join(sibling, 'version.txt'), 'utf8')).toBe(contents);
  });

  it('does not write an ownership marker when a fresh clone has escaped topology', () => {
    const subject = fixture();
    const sibling = join(subject.root, 'fresh-clone-external-worktree');
    git(['clone', subject.remote, sibling]);
    git(['checkout', '-b', 'fresh-clone-external'], sibling);
    writeFileSync(join(sibling, 'version.txt'), 'fresh clone dirty edit\n');
    const branch = git(['branch', '--show-current'], sibling);
    const head = git(['rev-parse', 'HEAD'], sibling);
    const origin = git(['remote', 'get-url', 'origin'], sibling);
    const contents = readFileSync(join(sibling, 'version.txt'), 'utf8');
    let cloned = false;
    const run = (args) => {
      const output = git(args);
      if (!cloned && args[0] === 'clone') {
        cloned = true;
        git(['config', 'core.worktree', sibling], subject.owned);
      }
      return output;
    };

    expect(() =>
      prepareOwnedNightlySourceCheckout({
        sourceCheckout: subject.source,
        ownedCheckout: subject.owned,
        ownedRoot: subject.ownedRoot,
        run,
      }),
    ).toThrow(/Git worktree escapes/);
    expect(cloned).toBe(true);
    expect(
      existsSync(join(subject.ownedRoot, 'build-checkout-v2.owner.json')),
    ).toBe(false);
    expect(git(['branch', '--show-current'], sibling)).toBe(branch);
    expect(git(['rev-parse', 'HEAD'], sibling)).toBe(head);
    expect(git(['remote', 'get-url', 'origin'], sibling)).toBe(origin);
    expect(readFileSync(join(sibling, 'version.txt'), 'utf8')).toBe(contents);
  });
});
