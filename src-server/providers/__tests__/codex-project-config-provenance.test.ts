/**
 * #3800: which `.codex` directories a non-host Codex start refuses. Real
 * Git repositories in temp directories; the start-path wiring and the live
 * plant are covered in `codex-project-config.process.test.ts`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ConfinementRefusedError } from '../../security/confinement/confinement-provider.js';
import {
  SESSION_CONFINEMENT_ROOT_METADATA_KEY,
  sessionConfinementRoot,
} from '../../services/orchestration/session-project-identity.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import { findUnaccountedCodexConfig } from '../adapters/codex-project-config-provenance.js';

const makeTempDir = trackTempDirs();

function execGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'probe',
      GIT_AUTHOR_EMAIL: 'probe@example.invalid',
      GIT_COMMITTER_NAME: 'probe',
      GIT_COMMITTER_EMAIL: 'probe@example.invalid',
    },
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

/** Commits everything in `dir`; `upstream` also records it as fetched. */
function commitAll(dir: string, upstream = true): void {
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
  if (upstream) git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
}

/** A repository whose `sub/pkg` holds a committed `.codex/config.toml`. */
function repository(): { root: string; pkg: string; config: string } {
  const root = realpathSync(makeTempDir('codex-provenance-'));
  const pkg = join(root, 'sub', 'pkg');
  const config = join(pkg, '.codex');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'config.toml'), '# checked in\n');
  writeFileSync(join(root, 'README.md'), 'fixture\n');
  commitAll(root);
  return { root, pkg, config };
}

const check = (cwd: string, root?: string) =>
  findUnaccountedCodexConfig(cwd, root ? { root } : {});

describe('findUnaccountedCodexConfig (#3800)', () => {
  test('a start with no authorized root trusts no .codex', () => {
    const { root, pkg, config } = repository();
    expect(check(pkg, root)).toBeUndefined();
    expect(check(pkg)).toBe(config);
    // The stamp for a folder outside every Project.
    expect(findUnaccountedCodexConfig(pkg, { root: '' })).toBe(config);
  });

  test('a nested repository ends trust even where the outer upstream holds the same bytes', () => {
    // The outer upstream commits `sub/vendored/.codex/config.toml`; then a
    // repository of its own appears at `sub/vendored` (unregistered).
    const { root } = repository();
    const nested = join(root, 'sub', 'vendored');
    mkdirSync(join(nested, '.codex'), { recursive: true });
    writeFileSync(join(nested, '.codex', 'config.toml'), '# outer upstream\n');
    git(root, 'add', '-A');
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'vendored');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(check(nested, root)).toBeUndefined();
    git(nested, 'init', '-q');
    expect(check(nested, root)).toBe(join(nested, '.codex'));
  });

  test('a repository an agent built and moved into a Project with no repository anchors nothing', () => {
    // The Project folder is in no repository; the agent's `proj` carries
    // its own commit and remote-tracking ref (round 4 of the review).
    const project = realpathSync(makeTempDir('codex-provenance-self-anchor-'));
    const proj = join(project, 'proj');
    mkdirSync(join(proj, '.codex'), { recursive: true });
    writeFileSync(join(proj, '.codex', 'config.toml'), '[mcp_servers.x]\n');
    commitAll(proj);
    expect(check(proj, project)).toBe(join(proj, '.codex'));
    // Inside a Project that is a repository, the same moved-in one ends trust.
    const { root } = repository();
    const moved = join(root, 'sub', 'moved');
    mkdirSync(join(moved, '.codex'), { recursive: true });
    writeFileSync(join(moved, '.codex', 'config.toml'), '[mcp_servers.x]\n');
    commitAll(moved);
    expect(check(moved, root)).toBe(join(moved, '.codex'));
  });

  test('a Project inside another repository trusts its own, innermost one', () => {
    const home = realpathSync(makeTempDir('codex-provenance-dotfiles-'));
    writeFileSync(join(home, 'README.md'), 'dotfiles\n');
    commitAll(home);
    const project = join(home, 'dev', 'proj');
    mkdirSync(join(project, 'pkg', '.codex'), { recursive: true });
    writeFileSync(join(project, 'pkg', '.codex', 'config.toml'), '# ok\n');
    commitAll(project);
    expect(check(join(project, 'pkg'), project)).toBeUndefined();
  });

  test("a nested .codex whose bytes are on the upstream ref is the repository's own", () => {
    const { root, pkg } = repository();
    expect(check(pkg, root)).toBeUndefined();
  });

  test('a workspace with no .codex on the path has nothing to report', () => {
    const { root } = repository();
    mkdirSync(join(root, 'other'));
    expect(check(join(root, 'other'), root)).toBeUndefined();
  });

  test('an uncommitted nested .codex is reported, at the cwd or any directory above it', () => {
    const { root } = repository();
    const planted = join(root, 'sub', 'new', '.codex');
    mkdirSync(join(planted), { recursive: true });
    writeFileSync(join(planted, 'config.toml'), '[mcp_servers.x]\n');
    mkdirSync(join(root, 'sub', 'new', 'deeper'));
    expect(check(join(root, 'sub', 'new'), root)).toBe(planted);
    expect(check(join(root, 'sub', 'new', 'deeper'), root)).toBe(planted);
  });

  test('an uncommitted .codex at the repository root is reported too', () => {
    const { root, pkg } = repository();
    mkdirSync(join(root, '.codex'));
    writeFileSync(join(root, '.codex', 'config.toml'), '# local\n');
    expect(check(pkg, root)).toBe(join(root, '.codex'));
  });

  test('a committed .codex that was changed, or gained a file, is reported', () => {
    const changed = repository();
    appendFileSync(join(changed.config, 'config.toml'), '[mcp_servers.x]\n');
    expect(check(changed.pkg, changed.root)).toBe(changed.config);
    const added = repository();
    writeFileSync(join(added.config, 'hooks.json'), '{}\n');
    expect(check(added.pkg, added.root)).toBe(added.config);
  });

  test('a .codex committed only in a nested repository is reported', () => {
    const { root } = repository();
    const nested = join(root, 'sub', 'vendored');
    mkdirSync(join(nested, '.codex'), { recursive: true });
    writeFileSync(join(nested, '.codex', 'config.toml'), '[mcp_servers.x]\n');
    commitAll(nested);
    expect(check(nested, root)).toBe(join(nested, '.codex'));
  });

  test('a .codex in a workspace with no repository is reported', () => {
    const root = realpathSync(makeTempDir('codex-provenance-plain-'));
    mkdirSync(join(root, '.codex'));
    expect(check(root, root)).toBe(join(root, '.codex'));
  });

  test('a symlinked .codex, or a cwd reached through a symlink, is reported', () => {
    const { root } = repository();
    const outside = realpathSync(makeTempDir('codex-provenance-outside-'));
    mkdirSync(join(outside, 'pkg', '.codex'), { recursive: true });
    mkdirSync(join(root, 'sub', 'linked'));
    symlinkSync(
      join(outside, 'pkg', '.codex'),
      join(root, 'sub', 'linked', '.codex'),
    );
    expect(check(join(root, 'sub', 'linked'), root)).toBe(
      join(root, 'sub', 'linked', '.codex'),
    );
    symlinkSync(join(outside, 'pkg'), join(root, 'sub', 'via'));
    expect(check(join(root, 'sub', 'via'), root)).toBeDefined();
  });

  test('a cwd that resolves into another repository is checked there too', () => {
    const { root } = repository();
    const other = realpathSync(makeTempDir('codex-provenance-other-'));
    mkdirSync(join(other, 'inner'), { recursive: true });
    writeFileSync(join(other, 'README.md'), 'other\n');
    commitAll(other);
    mkdirSync(join(other, '.codex'));
    symlinkSync(join(other, 'inner'), join(root, 'sub', 'elsewhere'));
    // Nothing on the lexical path; the resolved one has an uncommitted root.
    expect(check(join(root, 'sub', 'elsewhere'), root)).toBe(
      join(other, '.codex'),
    );
  });

  test('a symlink inside .codex is reported, even to a file with the upstream bytes', () => {
    const root = realpathSync(makeTempDir('codex-provenance-symlink-'));
    const config = join(root, 'pkg', '.codex');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'config.toml'), '# checked in\n');
    writeFileSync(join(config, 'linked.toml'), '# upstream\n');
    commitAll(root);
    // The same bytes, reached through a link: hashing would follow it and match.
    writeFileSync(join(root, 'target.toml'), '# upstream\n');
    rmSync(join(config, 'linked.toml'));
    symlinkSync(join(root, 'target.toml'), join(config, 'linked.toml'));
    expect(check(join(root, 'pkg'), root)).toBe(config);
  });

  test('a .codex committed only locally, not on any remote-tracking ref, is reported', () => {
    const { root, pkg, config } = repository();
    appendFileSync(join(config, 'config.toml'), '[mcp_servers.x]\n');
    git(root, 'add', '-A');
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'local');
    expect(check(pkg, root)).toBe(config);
    // Pushed and fetched, the same bytes are upstream content.
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(check(pkg, root)).toBeUndefined();
  });

  test('a repository with no remote-tracking refs trusts no .codex', () => {
    const root = realpathSync(makeTempDir('codex-provenance-no-remote-'));
    mkdirSync(join(root, '.codex'));
    writeFileSync(join(root, '.codex', 'config.toml'), '# committed\n');
    commitAll(root, false);
    expect(check(root, root)).toBe(join(root, '.codex'));
  });

  test('a forged object under the upstream commit id is not believed', () => {
    const { root, pkg, config } = repository();
    const upstream = execGit(root, 'rev-parse', 'refs/remotes/origin/main');
    appendFileSync(join(config, 'config.toml'), '[mcp_servers.x]\n');
    git(root, 'add', '-A');
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'planted');
    const planted = execGit(root, 'rev-parse', 'HEAD');
    // What a session that can write the object store could do: store the
    // planted commit's bytes under the upstream commit's name.
    const objectPath = (id: string) =>
      join(root, '.git', 'objects', id.slice(0, 2), id.slice(2));
    chmodSync(objectPath(upstream), 0o644);
    copyFileSync(objectPath(planted), objectPath(upstream));
    expect(execGit(root, 'cat-file', '-p', upstream)).toContain('planted');
    expect(check(pkg, root)).toBe(config);
  });

  /** A repository with a committed root `.codex` and a linked worktree inside it. */
  function repositoryWithInnerWorktree(): { root: string; lane: string } {
    const root = realpathSync(makeTempDir('codex-provenance-worktree-'));
    mkdirSync(join(root, '.codex'));
    writeFileSync(join(root, '.codex', 'config.toml'), '# checked in\n');
    writeFileSync(join(root, '.gitignore'), '.worktrees/\n');
    commitAll(root);
    const lane = join(root, '.worktrees', 'lane');
    git(root, 'worktree', 'add', '-q', '-b', 'lane', lane);
    return { root, lane };
  }

  test('a linked worktree inside its repository is judged by its own path', () => {
    const { root, lane } = repositoryWithInnerWorktree();
    expect(check(lane, root)).toBeUndefined();
    appendFileSync(join(lane, '.codex', 'config.toml'), '[mcp_servers.x]\n');
    expect(check(lane, root)).toBe(join(lane, '.codex'));
  });

  test('a gitfile borrowing a registered worktree entry is not that worktree', () => {
    const { root, lane } = repositoryWithInnerWorktree();
    const fake = join(root, '.worktrees', 'fake');
    mkdirSync(join(fake, '.codex'), { recursive: true });
    writeFileSync(join(fake, '.codex', 'config.toml'), '# checked in\n');
    writeFileSync(
      join(fake, '.git'),
      `gitdir: ${join(root, '.git', 'worktrees', 'lane')}\n`,
    );
    expect(check(lane, root)).toBeUndefined();
    expect(check(fake, root)).toBe(join(fake, '.codex'));
  });

  test("the user's own Codex home is configuration, not a project layer", () => {
    const home = realpathSync(makeTempDir('codex-provenance-home-'));
    mkdirSync(join(home, '.codex'));
    expect(
      findUnaccountedCodexConfig(home, {
        root: home,
        codexHome: join(home, '.codex'),
      }),
    ).toBeUndefined();
    expect(check(home, home)).toBe(join(home, '.codex'));
  });
});

/**
 * Round 6 of the #3962 review: the root the server stamps is compared and
 * returned canonically. An adopted place is canonical; a Project configured
 * through a symlink or in another case must still contain it, or the place
 * becomes its own root and a repository planted there anchors itself.
 */
describe('a canonical confinement root (#3800)', () => {
  /** A Project folder with a self-anchoring repository planted at `D`. */
  function plantedProject(): { real: string; planted: string } {
    const real = realpathSync(makeTempDir('codex-canonical-project-'));
    const planted = join(real, 'D');
    mkdirSync(join(planted, '.codex'), { recursive: true });
    writeFileSync(join(planted, '.codex', 'config.toml'), '[mcp_servers.x]\n');
    commitAll(planted);
    return { real, planted };
  }

  test.each(['an ordinary start', 'an adoption'] as const)(
    'a Project configured through a symlink still roots %s at the Project',
    (kind) => {
      const { real, planted } = plantedProject();
      const link = join(
        realpathSync(makeTempDir('codex-canonical-link-')),
        'P',
      );
      symlinkSync(real, link);
      const root = sessionConfinementRoot(
        planted,
        [{ slug: 'p', workingDirectory: link }],
        kind === 'an adoption'
          ? { projectSlug: 'p', admittedCwd: planted }
          : {},
      );
      expect(root).toBe(real);
      expect(findUnaccountedCodexConfig(planted, { root })).toBe(
        join(planted, '.codex'),
      );
    },
  );

  const caseInsensitive = (() => {
    const probe = realpathSync(makeTempDir('codex-case-probe-'));
    return existsSync(probe.toUpperCase());
  })();
  if (!caseInsensitive)
    console.warn(
      'SKIPPED (#3800): the temp volume is case-sensitive; the case-variant Project probe did not run.',
    );

  test
    .skipIf(!caseInsensitive)
    .each(['an ordinary start', 'an adoption'] as const)(
    'a Project configured in another case still roots %s at the Project',
    (kind) => {
      const { real, planted } = plantedProject();
      const variant = real.toUpperCase();
      expect(variant).not.toBe(real);
      const root = sessionConfinementRoot(
        planted,
        [{ slug: 'p', workingDirectory: variant }],
        kind === 'an adoption'
          ? { projectSlug: 'p', admittedCwd: planted }
          : {},
      );
      expect(root).toBe(real);
      expect(findUnaccountedCodexConfig(planted, { root })).toBe(
        join(planted, '.codex'),
      );
    },
  );

  test('a repository that exists only on the lexical path, above a link into the Project, is not trusted', () => {
    // The Project folder is in no repository; an agent-built repository at
    // `/x`, with its own `.codex` and remote-tracking ref, holds the link
    // `/x/L` to it (round 7 of the #3962 review).
    const project = realpathSync(makeTempDir('codex-lexical-project-'));
    mkdirSync(join(project, 'sub'));
    const outer = realpathSync(makeTempDir('codex-lexical-outer-'));
    mkdirSync(join(outer, '.codex'));
    writeFileSync(join(outer, '.codex', 'config.toml'), '[mcp_servers.x]\n');
    commitAll(outer);
    symlinkSync(project, join(outer, 'L'));
    const cwd = join(outer, 'L', 'sub');
    expect(findUnaccountedCodexConfig(cwd, { root: project })).toBe(
      join(outer, '.codex'),
    );
  });

  test('a cwd reached through a symlink to the Project is judged from the Project', () => {
    const { root, pkg } = repository();
    const link = join(realpathSync(makeTempDir('codex-canonical-cwd-')), 'L');
    symlinkSync(root, link);
    const linkedPkg = join(link, 'sub', 'pkg');
    expect(findUnaccountedCodexConfig(linkedPkg, { root })).toBeUndefined();
    expect(findUnaccountedCodexConfig(pkg, { root })).toBeUndefined();
  });
});

/**
 * The adapter, not only the check: an empty stamp (a folder outside every
 * Project) must reach `findUnaccountedCodexConfig` as no root at all, never
 * as the cwd, or a repository planted at the cwd anchors itself.
 */
describe('the Codex adapter without a trusted confinement root (#3800)', () => {
  test.each([undefined, 42, ''] as const)(
    'a self-anchoring repository with root %j is refused before Codex is spawned',
    async (root) => {
      const dir = realpathSync(makeTempDir('codex-empty-root-'));
      mkdirSync(join(dir, '.codex'));
      writeFileSync(join(dir, '.codex', 'config.toml'), '[mcp_servers.x]\n');
      commitAll(dir);
      // Anchored at itself, the repository would be trusted.
      expect(findUnaccountedCodexConfig(dir, { root: dir })).toBeUndefined();
      let spawned = false;
      const adapter = new CodexAdapter({
        processFactory: () => {
          spawned = true;
          throw new Error('spawned');
        },
      });
      const outcome = await adapter
        .startSession({
          provider: 'codex',
          threadId: 'empty-root',
          cwd: dir,
          confinement: 'workspace',
          metadata:
            root === undefined
              ? {}
              : { [SESSION_CONFINEMENT_ROOT_METADATA_KEY]: root },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(spawned).toBe(false);
      expect(outcome).toBeInstanceOf(ConfinementRefusedError);
      expect((outcome as ConfinementRefusedError).code).toBe(
        'confinement_workspace_incompatible',
      );
      await adapter.stopAll();
    },
  );
});
