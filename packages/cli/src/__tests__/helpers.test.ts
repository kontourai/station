import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROJECT_HOME,
  extractPluginName,
  isGitUrl,
  normalizeHomePath,
  parseGitSource,
  resolveLifecycleHomeTarget,
} from '../commands/helpers.js';

afterEach(() => vi.unstubAllEnvs());

describe('channel lifecycle homes', () => {
  it('resolves stable and beta homes independently when STATION_HOME is absent', () => {
    expect(
      resolveLifecycleHomeTarget({ env: { STATION_CHANNEL: 'stable' } }),
    ).toMatchObject({
      projectHome: join(process.env.HOME!, '.station', 'instances', 'stable'),
      source: 'default',
    });
    expect(
      resolveLifecycleHomeTarget({ env: { STATION_CHANNEL: 'beta' } }),
    ).toMatchObject({
      projectHome: join(process.env.HOME!, '.station', 'instances', 'beta'),
      source: 'default',
    });
  });

  it('keeps an explicit STATION_HOME ahead of a channel home', () => {
    expect(
      resolveLifecycleHomeTarget({
        env: { STATION_CHANNEL: 'beta', STATION_HOME: '/tmp/explicit-home' },
      }),
    ).toMatchObject({
      projectHome: normalizeHomePath('/tmp/explicit-home'),
      source: 'env',
    });
  });

  // station#4299: `--home` is the flag that makes "isolated but persistent"
  // expressible without ambient environment, so it has to beat the ambient
  // environment.
  it('keeps --home ahead of STATION_HOME and reports it as the chooser', () => {
    expect(
      resolveLifecycleHomeTarget({
        homeDir: '/tmp/flag-home',
        env: { STATION_HOME: '/tmp/ambient-home' },
      }),
    ).toMatchObject({
      projectHome: normalizeHomePath('/tmp/flag-home'),
      source: '--home',
    });
  });

  it('marks a --home that resolves to the default home as the default home', () => {
    // `isDefaultHome` gates the destructive-clean refusal. Spelling the real
    // home out by hand must not buy a way past it.
    expect(
      resolveLifecycleHomeTarget({ homeDir: DEFAULT_PROJECT_HOME }),
    ).toMatchObject({
      projectHome: normalizeHomePath(DEFAULT_PROJECT_HOME),
      isDefaultHome: true,
      source: '--home',
    });
  });

  it.each(['homeDir', 'baseDir', 'env'] as const)(
    'recognizes the supplied root default through %s',
    (kind) => {
      const root = '/tmp/station-helper-root';
      const home = `${root}/instances/stable`;
      const env = {
        STATION_ROOT: root,
        STATION_CHANNEL: 'stable',
      } as NodeJS.ProcessEnv;
      const options =
        kind === 'env'
          ? { env: { ...env, STATION_HOME: home } }
          : { env, [kind]: home };
      expect(resolveLifecycleHomeTarget(options)).toMatchObject({
        isDefaultHome: true,
      });
    },
  );

  it('still lets --temp-home mint its own home ahead of --home', () => {
    // Combining them is refused at the CLI boundary; this pins that the
    // resolver never silently starts a throwaway home at a path the operator
    // named and expects to keep.
    const target = resolveLifecycleHomeTarget({
      homeDir: '/tmp/flag-home',
      tempHome: true,
    });
    expect(target.source).toBe('--temp-home');
    expect(target.projectHome).not.toBe('/tmp/flag-home');
  });

  it('rejects shared-root and container selections before CLI lifecycle work', () => {
    const sharedRoot = mkdtempSync(join(tmpdir(), 'station-cli-shared-root-'));
    try {
      const env = { STATION_ROOT: sharedRoot } as NodeJS.ProcessEnv;
      for (const selection of [
        { homeDir: sharedRoot },
        { baseDir: join(sharedRoot, 'instances') },
      ]) {
        expect(() => resolveLifecycleHomeTarget({ ...selection, env })).toThrow(
          /not admissible/,
        );
      }
      expect(() =>
        resolveLifecycleHomeTarget({
          env: { ...env, STATION_HOME: join(sharedRoot, 'config') },
        }),
      ).toThrow(/not admissible/);
      expect(existsSync(join(sharedRoot, '.station-home-schema.json'))).toBe(
        false,
      );
    } finally {
      rmSync(sharedRoot, { recursive: true, force: true });
    }
  });
});

describe('isGitUrl', () => {
  it('recognises git@ SSH URLs', () => {
    expect(isGitUrl('git@github.com:org/repo.git')).toBe(true);
  });

  it('recognises .git-suffixed HTTPS URLs', () => {
    expect(isGitUrl('https://example.com/org/repo.git')).toBe(true);
  });

  it('recognises GitHub HTTPS URLs without .git suffix', () => {
    expect(isGitUrl('https://github.com/org/repo')).toBe(true);
  });

  it('recognises GitLab HTTPS URLs without .git suffix', () => {
    expect(isGitUrl('https://gitlab.com/org/repo')).toBe(true);
  });

  it('rejects plain HTTPS URLs unrelated to git hosts', () => {
    expect(isGitUrl('https://example.com/plugin')).toBe(false);
  });

  it('rejects unix-style local paths', () => {
    expect(isGitUrl('/home/user/plugins/my-plugin')).toBe(false);
  });

  it('rejects relative local paths', () => {
    expect(isGitUrl('./my-plugin')).toBe(false);
  });

  it('rejects windows-style local paths', () => {
    const p = ['C:', 'Users', 'dev', 'plugins', 'my-plugin'].join('\\');
    expect(isGitUrl(p)).toBe(false);
  });
});

describe('parseGitSource', () => {
  it('splits URL and branch on #', () => {
    const result = parseGitSource(
      'https://github.com/org/repo.git#feat/branch',
    );
    expect(result.url).toBe('https://github.com/org/repo.git');
    expect(result.branch).toBe('feat/branch');
  });

  it('defaults branch to main when no # present', () => {
    const result = parseGitSource('https://github.com/org/repo.git');
    expect(result.url).toBe('https://github.com/org/repo.git');
    expect(result.branch).toBe('main');
  });
});

describe('extractPluginName', () => {
  it('extracts name from unix local path', () => {
    expect(extractPluginName('/home/user/plugins/my-plugin')).toBe('my-plugin');
  });

  it('extracts name from windows local path (backslash)', () => {
    const p = ['C:', 'Users', 'user', 'plugins', 'my-plugin'].join('\\');
    expect(extractPluginName(p)).toBe('my-plugin');
  });

  it('extracts name from git URL with .git suffix', () => {
    expect(extractPluginName('https://github.com/org/awesome-plugin.git')).toBe(
      'awesome-plugin',
    );
  });

  it('extracts name from git URL without .git suffix', () => {
    expect(extractPluginName('https://github.com/org/awesome-plugin')).toBe(
      'awesome-plugin',
    );
  });

  it('extracts name from git URL with branch fragment', () => {
    expect(extractPluginName('https://github.com/org/my-plugin.git#main')).toBe(
      'my-plugin',
    );
  });

  it('extracts name from SSH git URL', () => {
    expect(extractPluginName('git@github.com:org/my-plugin.git')).toBe(
      'my-plugin',
    );
  });

  it('handles trailing slash on local path', () => {
    // basename('foo/bar/') → '' on some impls; we want 'bar'
    // path.basename handles this correctly
    expect(extractPluginName('/home/user/plugins/my-plugin/')).toBe(
      'my-plugin',
    );
  });

  it('resolves the current directory before extracting its name', () => {
    expect(extractPluginName('.', '/home/user/plugins/my-plugin')).toBe(
      'my-plugin',
    );
  });
});
