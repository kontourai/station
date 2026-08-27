import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { gitEnv } from '../git-exec.js';

describe('gitEnv', () => {
  let savedGitDir: string | undefined;
  let savedGitWorkTree: string | undefined;

  beforeEach(() => {
    savedGitDir = process.env.GIT_DIR;
    savedGitWorkTree = process.env.GIT_WORK_TREE;
  });

  afterEach(() => {
    if (savedGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = savedGitDir;
    if (savedGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = savedGitWorkTree;
  });

  test('removes GIT_DIR and GIT_WORK_TREE even when present in process.env', () => {
    process.env.GIT_DIR = '/some/inherited/.git';
    process.env.GIT_WORK_TREE = '/some/inherited/worktree';

    const env = gitEnv();

    expect('GIT_DIR' in env).toBe(false);
    expect('GIT_WORK_TREE' in env).toBe(false);
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
  });

  test('preserves other environment variables', () => {
    process.env.GIT_DIR = '/inherited/.git';
    const env = gitEnv();

    // PATH is always present in process.env; it must survive sanitization.
    expect(env.PATH).toBe(process.env.PATH);
  });

  test('applies extra vars and lets extra override inherited ones', () => {
    process.env.GIT_DIR = '/inherited/.git';

    const env = gitEnv({ STATION_TEST_VAR: 'hello', PATH: '/custom/path' });

    expect(env.STATION_TEST_VAR).toBe('hello');
    expect(env.PATH).toBe('/custom/path');
    // Sanitization still wins over anything carried in from process.env.
    expect('GIT_DIR' in env).toBe(false);
  });

  test('extra cannot reintroduce GIT_DIR / GIT_WORK_TREE', () => {
    const env = gitEnv({
      GIT_DIR: '/evil/.git',
      GIT_WORK_TREE: '/evil/worktree',
    });

    expect('GIT_DIR' in env).toBe(false);
    expect('GIT_WORK_TREE' in env).toBe(false);
  });
});
