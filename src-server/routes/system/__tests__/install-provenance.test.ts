import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { writeNightlySourceStamp } from '../../../../ops/nightly/macos-source-stamp.mjs';
import {
  DEFAULT_REPOSITORY,
  fetchChannelLatestSha,
  NIGHTLY_SOURCE_STAMP_FILENAME,
  normalizeOriginUrl,
  readNightlySourceStamp,
  refspecFromStampRef,
  resolveInstallProvenance,
  resolveSelfUpdateEligibility,
} from '../install-provenance.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

// The real resolver falls back to process.cwd(), which in this test run IS a
// git checkout — every non-checkout scenario must inject a throwing resolver
// or the walk under test is never reached.
const notACheckout = () => {
  throw new Error('Not a git repository');
};

function validStamp(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    channel: 'nightly',
    ref: 'origin/main',
    sha: SHA,
    createdAt: '2026-08-02T00:00:00Z',
    ...overrides,
  };
}

let roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'install-provenance-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('readNightlySourceStamp', () => {
  test('accepts the shape the nightly installer writes', () => {
    const root = tempRoot();
    const path = join(root, NIGHTLY_SOURCE_STAMP_FILENAME);
    writeFileSync(path, JSON.stringify(validStamp()));
    expect(readNightlySourceStamp(path)).toEqual({
      channel: 'nightly',
      ref: 'origin/main',
      sha: SHA,
      repository: DEFAULT_REPOSITORY,
      createdAt: '2026-08-02T00:00:00Z',
      sourceCheckout: null,
    });
  });

  test('carries an explicit repository field through', () => {
    const root = tempRoot();
    const path = join(root, NIGHTLY_SOURCE_STAMP_FILENAME);
    writeFileSync(
      path,
      JSON.stringify(validStamp({ repository: 'https://example.test/r.git' })),
    );
    expect(readNightlySourceStamp(path)?.repository).toBe(
      'https://example.test/r.git',
    );
  });

  test.each([
    ['wrong schemaVersion', validStamp({ schemaVersion: 2 })],
    ['non-hex sha', validStamp({ sha: 'not-a-sha' })],
    ['short sha', validStamp({ sha: 'abc1234' })],
    ['empty channel', validStamp({ channel: '  ' })],
    ['missing ref', validStamp({ ref: undefined })],
    ['empty repository', validStamp({ repository: '' })],
    ['array payload', [validStamp()]],
    // repository/ref reach git argv — option-like and command-running
    // transport values must invalidate the stamp (CWE-88).
    [
      'option-injection repository',
      validStamp({ repository: '--upload-pack=touch /tmp/pwned' }),
    ],
    ['ext transport repository', validStamp({ repository: 'ext::sh -c id' })],
    [
      'ssh repository',
      validStamp({ repository: 'ssh://git@github.com/x/y.git' }),
    ],
    ['option-injection ref', validStamp({ ref: '--upload-pack=id' })],
    ['ref with spaces', validStamp({ ref: 'origin/main extra' })],
  ])('fails closed on %s', (_label, payload) => {
    const root = tempRoot();
    const path = join(root, NIGHTLY_SOURCE_STAMP_FILENAME);
    writeFileSync(path, JSON.stringify(payload));
    expect(readNightlySourceStamp(path)).toBeNull();
  });

  test('fails closed on unparseable JSON', () => {
    const root = tempRoot();
    const path = join(root, NIGHTLY_SOURCE_STAMP_FILENAME);
    writeFileSync(path, '{nope');
    expect(readNightlySourceStamp(path)).toBeNull();
  });
});

describe('resolveInstallProvenance', () => {
  test.each([
    ['built server root', '/repo/dist-server'],
    ['per-instance build root', '/repo/dist-server-phone'],
    ['tsx dev module dir', '/repo/src-server/routes/system'],
  ])('classifies %s as source-checkout', (_label, moduleDir) => {
    const provenance = resolveInstallProvenance(moduleDir, {
      resolveGit: () => ({
        gitRoot: '/repo',
        branch: 'main',
        hash: 'abc1234',
      }),
    });
    expect(provenance).toEqual({
      installKind: 'source-checkout',
      gitRoot: '/repo',
      branch: 'main',
      sha: 'abc1234',
    });
  });

  test('a stampless bundle nested in a checkout is unknown, never source-checkout', () => {
    // The realistic reviewer-reproduced case: a locally built .app under
    // src-desktop/target/ has NO stamp (only the installer writes one), and
    // git resolves the surrounding repo. Classifying it source-checkout
    // would arm `git pull` + rebuild against that repo from the apply path.
    const moduleDir =
      '/repo/src-desktop/target/aarch64-apple-darwin/release/bundle/macos/Station Nightly.app/Contents/Resources/dist-server';
    const provenance = resolveInstallProvenance(moduleDir, {
      resolveGit: () => ({
        gitRoot: '/repo',
        branch: 'feat/some-branch',
        hash: 'abc1234',
      }),
    });
    expect(provenance.installKind).toBe('unknown');
    if (provenance.installKind === 'unknown') {
      expect(provenance.detail).toContain('not at that checkout');
    }
  });

  test('a repo resolved from cwd/argv fallbacks (not an ancestor) is unknown', () => {
    // resolveGitInfo falls back to process.cwd(); a /Applications bundle
    // launched from a terminal cd'd into some git repo must not classify as
    // that repo's source checkout.
    const provenance = resolveInstallProvenance(
      '/Applications/Station.app/Contents/Resources/dist-server-x',
      {
        resolveGit: () => ({
          gitRoot: '/Users/dev/some-repo',
          branch: 'main',
          hash: 'abc1234',
        }),
      },
    );
    expect(provenance.installKind).toBe('unknown');
  });

  test('finds the bundle stamp above the server dir (Resources layout)', () => {
    const root = tempRoot();
    const serverDir = join(root, 'Resources', 'dist-server');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(root, 'Resources', NIGHTLY_SOURCE_STAMP_FILENAME),
      JSON.stringify(validStamp()),
    );
    const provenance = resolveInstallProvenance(serverDir, {
      resolveGit: notACheckout,
    });
    expect(provenance.installKind).toBe('desktop-bundle');
    if (provenance.installKind === 'desktop-bundle') {
      expect(provenance.channel).toBe('nightly');
      expect(provenance.sha).toBe(SHA);
    }
  });

  test('a malformed stamp is unknown, never a fabricated channel', () => {
    const root = tempRoot();
    writeFileSync(
      join(root, NIGHTLY_SOURCE_STAMP_FILENAME),
      JSON.stringify(validStamp({ sha: 'garbage' })),
    );
    const provenance = resolveInstallProvenance(root, {
      resolveGit: notACheckout,
    });
    expect(provenance.installKind).toBe('unknown');
    if (provenance.installKind === 'unknown') {
      expect(provenance.detail).toContain('malformed');
    }
  });

  test('no checkout and no stamp is unknown with a detail naming both', () => {
    const root = tempRoot();
    const provenance = resolveInstallProvenance(root, {
      resolveGit: notACheckout,
    });
    expect(provenance.installKind).toBe('unknown');
    if (provenance.installKind === 'unknown') {
      expect(provenance.detail).toContain(NIGHTLY_SOURCE_STAMP_FILENAME);
    }
  });

  test('the upward walk is bounded', () => {
    const root = tempRoot();
    const deep = join(root, ...Array.from({ length: 4 }, (_, i) => `d${i}`));
    mkdirSync(deep, { recursive: true });
    writeFileSync(
      join(root, NIGHTLY_SOURCE_STAMP_FILENAME),
      JSON.stringify(validStamp()),
    );
    const provenance = resolveInstallProvenance(deep, {
      resolveGit: notACheckout,
    });
    // 4 levels above the stamp is past the 3-level bound.
    expect(provenance.installKind).toBe('unknown');
  });

  test('the stamp wins over git resolution (bundle built inside a checkout)', () => {
    // src-desktop/target/…/Station Nightly.app sits inside the repo, so git
    // resolves the SURROUNDING checkout. Classifying by git first would arm
    // the git-pull apply path against that unrelated repo — the stamp must
    // take precedence.
    const root = tempRoot();
    const serverDir = join(root, 'Resources', 'dist-server');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(root, 'Resources', NIGHTLY_SOURCE_STAMP_FILENAME),
      JSON.stringify(validStamp()),
    );
    const provenance = resolveInstallProvenance(serverDir, {
      resolveGit: () => ({
        gitRoot: '/Users/dev/station',
        branch: 'feat/some-branch',
        hash: 'abc1234',
      }),
    });
    expect(provenance.installKind).toBe('desktop-bundle');
  });
});

describe('refspecFromStampRef', () => {
  test.each([
    ['origin/main', 'refs/heads/main'],
    ['main', 'refs/heads/main'],
    ['origin/release/v2', 'refs/heads/release/v2'],
    ['refs/tags/v1.0.0', 'refs/tags/v1.0.0'],
  ])('%s → %s', (input, expected) => {
    expect(refspecFromStampRef(input)).toBe(expected);
  });
});

describe('fetchChannelLatestSha', () => {
  test('returns the sha ls-remote reports', async () => {
    const exec = async () => ({
      stdout: `${OTHER_SHA}\trefs/heads/main\n`,
      stderr: '',
    });
    await expect(
      fetchChannelLatestSha(DEFAULT_REPOSITORY, 'origin/main', {
        exec: exec as never,
      }),
    ).resolves.toBe(OTHER_SHA);
  });

  test('throws when ls-remote returns nothing (unknown ref)', async () => {
    const exec = async () => ({ stdout: '', stderr: '' });
    await expect(
      fetchChannelLatestSha(DEFAULT_REPOSITORY, 'origin/main', {
        exec: exec as never,
      }),
    ).rejects.toThrow(/no sha/);
  });

  test('propagates exec failure (no network, no git binary)', async () => {
    const exec = async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    };
    await expect(
      fetchChannelLatestSha(DEFAULT_REPOSITORY, 'origin/main', {
        exec: exec as never,
      }),
    ).rejects.toThrow(/ENOTFOUND/);
  });

  test.each([
    ['option-injection url', '--upload-pack=touch /tmp/pwned', 'origin/main'],
    ['ext transport url', 'ext::sh -c id', 'origin/main'],
    ['ssh url', 'ssh://git@github.com/x/y.git', 'origin/main'],
    ['option-injection ref', DEFAULT_REPOSITORY, '--upload-pack=id'],
  ])('refuses %s before spawning git', async (_label, repository, ref) => {
    const exec = vi.fn();
    await expect(
      fetchChannelLatestSha(repository, ref, { exec: exec as never }),
    ).rejects.toThrow(/refusing/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('sourceCheckout stamp field (#1624)', () => {
  test('round-trips production portable and installed source stamps', () => {
    const root = tempRoot();
    const portable = join(root, 'portable.json');
    const installed = join(root, 'installed.json');
    const input = {
      sha: 'a'.repeat(40),
      createdAt: '2026-01-01T00:00:00Z',
      originUrl: 'git@github.com:kontourai/station.git',
    };
    writeNightlySourceStamp(portable, { ...input, sourceCheckout: '' });
    writeNightlySourceStamp(installed, {
      ...input,
      sourceCheckout: '/Users/dev/station',
    });
    expect(readNightlySourceStamp(portable)).toMatchObject({
      channel: 'nightly',
      sha: 'a'.repeat(40),
      sourceCheckout: null,
    });
    expect(readNightlySourceStamp(installed)?.sourceCheckout).toBe(
      '/Users/dev/station',
    );
  });
  test('carries an absolute sourceCheckout through and defaults to null', () => {
    const root = tempRoot();
    const path = join(root, NIGHTLY_SOURCE_STAMP_FILENAME);
    writeFileSync(
      path,
      JSON.stringify(validStamp({ sourceCheckout: '/Users/dev/station' })),
    );
    expect(readNightlySourceStamp(path)?.sourceCheckout).toBe(
      '/Users/dev/station',
    );
    writeFileSync(path, JSON.stringify(validStamp()));
    expect(readNightlySourceStamp(path)?.sourceCheckout).toBeNull();
  });

  test.each([
    ['relative path', validStamp({ sourceCheckout: 'dev/station' })],
    ['non-string', validStamp({ sourceCheckout: 42 })],
  ])('fails closed on %s sourceCheckout', (_label, payload) => {
    const root = tempRoot();
    const path = join(root, NIGHTLY_SOURCE_STAMP_FILENAME);
    writeFileSync(path, JSON.stringify(payload));
    expect(readNightlySourceStamp(path)).toBeNull();
  });
});

describe('resolveSelfUpdateEligibility (#1624)', () => {
  const REPO = 'https://github.com/kontourai/station.git';

  function checkoutWithInstaller(): string {
    const root = tempRoot();
    mkdirSync(join(root, 'ops', 'nightly'), { recursive: true });
    writeFileSync(
      join(root, 'ops', 'nightly', 'install-macos.zsh'),
      '#!/bin/zsh\n',
    );
    return root;
  }

  test('eligible when the checkout exists, origin matches, installer present', async () => {
    const checkout = checkoutWithInstaller();
    const exec = vi.fn().mockResolvedValue({
      stdout: 'git@github.com:kontourai/station.git\n',
      stderr: '',
    });
    const result = await resolveSelfUpdateEligibility(
      { repository: REPO, sourceCheckout: checkout },
      { exec: exec as never, platform: 'darwin' },
    );
    expect(result).toEqual({
      eligible: true,
      checkoutPath: checkout,
      installerPath: join(checkout, 'ops', 'nightly', 'install-macos.zsh'),
    });
    // Origin was asked of the checkout itself — identity is proven live,
    // never taken from the stamp.
    expect(exec).toHaveBeenCalledWith(
      ['remote', 'get-url', 'origin'],
      expect.objectContaining({ cwd: checkout }),
    );
  });

  test.each([
    ['no recorded checkout', null, undefined, 'no source checkout recorded'],
    ['absent path', '/nonexistent/station-checkout', undefined, 'absent'],
  ])('ineligible: %s', async (_label, sourceCheckout, _x, reason) => {
    const result = await resolveSelfUpdateEligibility(
      { repository: REPO, sourceCheckout },
      { platform: 'darwin' },
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain(reason);
  });

  test('ineligible when the checkout origin names a different repository', async () => {
    const checkout = checkoutWithInstaller();
    const exec = vi.fn().mockResolvedValue({
      stdout: 'https://github.com/attacker/evil.git\n',
      stderr: '',
    });
    const result = await resolveSelfUpdateEligibility(
      { repository: REPO, sourceCheckout: checkout },
      { exec: exec as never, platform: 'darwin' },
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toContain('does not match');
    }
  });

  test('ineligible when the checkout exists but the installer script is absent', async () => {
    // The executed file is always <checkout>/ops/nightly/install-macos.zsh;
    // a checkout without it must fail closed BEFORE any git call.
    const root = tempRoot();
    mkdirSync(join(root, 'ops', 'nightly'), { recursive: true });
    const exec = vi.fn();
    const result = await resolveSelfUpdateEligibility(
      { repository: REPO, sourceCheckout: root },
      { exec: exec as never, platform: 'darwin' },
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain('absent');
    expect(exec).not.toHaveBeenCalled();
  });

  test('ineligible when the path is not a git checkout', async () => {
    const checkout = checkoutWithInstaller();
    const exec = vi.fn().mockRejectedValue(new Error('not a git repository'));
    const result = await resolveSelfUpdateEligibility(
      { repository: REPO, sourceCheckout: checkout },
      { exec: exec as never, platform: 'darwin' },
    );
    expect(result.eligible).toBe(false);
  });

  test('macOS-only', async () => {
    const result = await resolveSelfUpdateEligibility(
      { repository: REPO, sourceCheckout: checkoutWithInstaller() },
      { platform: 'linux' },
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.reason).toContain('macOS');
  });
});

describe('normalizeOriginUrl', () => {
  test.each([
    [
      'git@github.com:kontourai/station.git',
      'https://github.com/kontourai/station',
    ],
    [
      'ssh://git@github.com:2222/kontourai/station.git',
      'https://github.com/kontourai/station',
    ],
    [
      'https://github.com/kontourai/station',
      'https://github.com/kontourai/station',
    ],
    [
      'https://github.com/kontourai/station.git',
      'https://github.com/kontourai/station',
    ],
  ])('%s → %s', (input, expected) => {
    expect(normalizeOriginUrl(input)).toBe(expected);
  });
});
