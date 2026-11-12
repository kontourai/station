/**
 * #4828: which tool calls reach a location an injected instruction would
 * outlive the conversation from. The staged evaluator applies the verdict;
 * see the Claude adapter and Station engine tests for that.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  acpPersistenceTarget,
  isPersistenceRelevantTool,
  isUntrustedPersistencePath,
  untrustedPersistenceTarget,
} from '../untrusted-persistence-protection.js';

describe('isUntrustedPersistencePath', () => {
  test.each([
    'CLAUDE.md',
    'AGENTS.md',
    '/repo/packages/app/AGENTS.md',
    'docs/claude.md',
    'CLAUDE.local.md',
    'AGENTS.override.md',
    '.mcp.json',
    '.claude/settings.json',
    '/repo/sub/.claude/skills/x/SKILL.md',
    '.agents/skills/deslop/SKILL.md',
    '.codex/config.toml',
    '.claude',
    '.git/hooks/pre-commit',
    '/repo/.git/hooks',
    '.git/config',
    '/repo/.git/worktrees/lane/config',
    '/repo/.git/modules/vendor/hooks/post-checkout',
    'C:\\repo\\.git\\hooks\\pre-push',
    'src/../CLAUDE.md',
  ])('%s is protected', (candidate) => {
    expect(isUntrustedPersistencePath(candidate)).toBe(true);
  });

  test.each([
    '',
    'README.md',
    'src/config',
    'config/settings.json',
    '.gitconfig',
    '.github/workflows/ci.yml',
    'docs/AGENTS.md.bak',
    'notes/claude-md.txt',
    '.git',
    '.git/HEAD',
    '.git/refs/heads/main',
    'src/my.claude.ts',
  ])('%s is not', (candidate) => {
    expect(isUntrustedPersistencePath(candidate)).toBe(false);
  });
});

describe('untrustedPersistenceTarget', () => {
  test('file-write tools report the protected target', () => {
    expect(
      untrustedPersistenceTarget('Write', { file_path: '/r/CLAUDE.md' }),
    ).toEqual({ kind: 'write', target: '/r/CLAUDE.md' });
    expect(
      untrustedPersistenceTarget('NotebookEdit', {
        notebook_path: '/r/.claude/n.ipynb',
      }),
    ).toEqual({ kind: 'write', target: '/r/.claude/n.ipynb' });
    expect(
      untrustedPersistenceTarget('write_file', { path: '.git/config' }),
    ).toEqual({ kind: 'write', target: '.git/config' });
  });

  test('an apply_patch envelope is read for every file it touches', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      '-a',
      '+b',
      '*** Add File: .git/hooks/post-merge',
      '+#!/bin/sh',
      '*** End Patch',
    ].join('\n');
    expect(untrustedPersistenceTarget('apply_patch', { input: patch })).toEqual(
      { kind: 'write', target: '.git/hooks/post-merge' },
    );
    expect(untrustedPersistenceTarget('apply_patch', patch)).toEqual({
      kind: 'write',
      target: '.git/hooks/post-merge',
    });
    expect(
      untrustedPersistenceTarget('apply_patch', {
        input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch',
      }),
    ).toBeUndefined();
  });

  test("the Station file editor's view is a read", () => {
    expect(
      untrustedPersistenceTarget('fileEditor', {
        command: 'view',
        path: 'CLAUDE.md',
      }),
    ).toBeUndefined();
    expect(
      untrustedPersistenceTarget('fileEditor', {
        command: 'str_replace',
        path: 'CLAUDE.md',
      }),
    ).toEqual({ kind: 'write', target: 'CLAUDE.md' });
  });

  test.each([
    ['echo x >> CLAUDE.md', 'CLAUDE.md'],
    ["printf 'y' >.git/hooks/pre-commit", '.git/hooks/pre-commit'],
    ['cp /tmp/x "sub dir/AGENTS.md"', 'sub dir/AGENTS.md'],
    ['tee --output=.claude/settings.json', '.claude/settings.json'],
    ['git config core.hooksPath /tmp/hooks', '.git/config'],
    ['git -C repo config --global user.name x', '.git/config'],
  ])('shell %s names %s', (command, target) => {
    expect(untrustedPersistenceTarget('Bash', { command })).toEqual({
      kind: 'shell',
      target,
    });
  });

  test.each([
    'ls -la',
    'git config --get user.name',
    'git config -l',
    'git commit -m config',
    'npm test',
  ])('shell %s names nothing protected', (command) => {
    expect(untrustedPersistenceTarget('bash', { command })).toBeUndefined();
  });

  test('a Codex-style argv command is read too', () => {
    expect(
      untrustedPersistenceTarget('shell', {
        command: ['bash', '-lc', 'echo x > AGENTS.md'],
      }),
    ).toEqual({ kind: 'shell', target: 'AGENTS.md' });
  });

  test('read tools are never protected', () => {
    expect(
      untrustedPersistenceTarget('Read', { file_path: 'CLAUDE.md' }),
    ).toBeUndefined();
    expect(
      untrustedPersistenceTarget('Grep', { path: '.git/config' }),
    ).toBeUndefined();
  });
});

describe('fix round 1 (#4828)', () => {
  const makeTempDir = trackTempDirs();

  test("a worktree's effective hooks folder is read from the common config", () => {
    const main = makeTempDir('wru-main-');
    mkdirSync(join(main, '.git', 'worktrees', 'lane'), { recursive: true });
    writeFileSync(
      join(main, '.git', 'config'),
      '[core]\n\thooksPath = "ci/hooks"\n',
    );
    writeFileSync(
      join(main, '.git', 'worktrees', 'lane', 'commondir'),
      '../..\n',
    );
    const lane = makeTempDir('wru-lane-');
    writeFileSync(
      join(lane, '.git'),
      `gitdir: ${join(main, '.git', 'worktrees', 'lane')}\n`,
    );
    expect(
      untrustedPersistenceTarget('Write', {
        file_path: join(lane, 'ci/hooks/pre-push'),
      }),
    ).toEqual({ kind: 'write', target: join(lane, 'ci/hooks/pre-push') });
    expect(
      untrustedPersistenceTarget('Write', {
        file_path: join(lane, 'ci/build.sh'),
      }),
    ).toBeUndefined();
  });

  test('every path a move, rename or copy names is checked, lists included', () => {
    expect(
      untrustedPersistenceTarget('copy_file', {
        src: 'notes.md',
        dest: 'pkg/CLAUDE.md',
      }),
    ).toEqual({ kind: 'write', target: 'pkg/CLAUDE.md' });
    expect(
      untrustedPersistenceTarget('write_file', {
        paths: ['a.md', '.husky/pre-commit'],
      }),
    ).toEqual({ kind: 'write', target: '.husky/pre-commit' });
  });

  test('only an editor whose view reads is exempt by `command: "view"`', () => {
    for (const tool of ['Write', 'write_file', 'move_file'])
      expect(
        untrustedPersistenceTarget(tool, {
          command: 'view',
          path: 'CLAUDE.md',
        }),
      ).toEqual({ kind: 'write', target: 'CLAUDE.md' });
    expect(
      untrustedPersistenceTarget('str_replace_editor', {
        command: 'view',
        path: 'CLAUDE.md',
      }),
    ).toBeUndefined();
  });

  test('tool names compare without case or separators', () => {
    expect(isPersistenceRelevantTool('writeFile')).toBe(true);
    expect(isPersistenceRelevantTool('MoveFile')).toBe(true);
    expect(isPersistenceRelevantTool('filesystem_writeFile')).toBe(false);
  });

  test('ACP: an edit, move or delete is read from its kind and locations', () => {
    expect(
      acpPersistenceTarget({
        kind: 'edit',
        locations: [{ path: '/r/.git/hooks/pre-commit' }],
      }),
    ).toEqual({ kind: 'write', target: '/r/.git/hooks/pre-commit' });
    expect(
      acpPersistenceTarget({
        kind: 'move',
        rawInput: { source: '/r/a.md', destination: '/r/AGENTS.md' },
      }),
    ).toEqual({ kind: 'write', target: '/r/AGENTS.md' });
    expect(
      acpPersistenceTarget({
        kind: 'read',
        locations: [{ path: '/r/CLAUDE.md' }],
      }),
    ).toBeUndefined();
  });
});
