import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trust = vi.hoisted(() => ({ directories: vi.fn(), files: vi.fn() }));
vi.mock('@kontourai/station-shared/windows-path-trust', () => ({
  ensureWindowsDirectoriesTrusted: trust.directories,
  hardenWindowsPathsTrusted: trust.files,
}));

import { writeLocalGrantSecretFile } from '../local-grant-file';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'station-local-grant-'));
  trust.directories.mockReset();
  trust.files.mockReset();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('local grant secret publication', () => {
  it('establishes the directory and empty-file trust boundaries before publishing secret bytes', () => {
    const file = join(home, 'runtime', 'local-grant.secret');
    const steps: string[] = [];
    trust.directories.mockImplementation((_run, paths) => {
      expect(paths).toEqual([join(home, 'runtime')]);
      steps.push('directory');
    });
    trust.files.mockImplementation((_run, targets) => {
      expect(targets).toHaveLength(1);
      expect(targets[0].kind).toBe('file');
      expect(readFileSync(targets[0].path, 'utf8')).toBe('');
      steps.push('empty-file');
    });
    const secret = writeLocalGrantSecretFile(file);
    expect(steps).toEqual(['directory', 'empty-file']);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(file, 'utf8')).toBe(secret);
    expect(readdirSync(join(home, 'runtime'))).toEqual(['local-grant.secret']);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, 'runtime')).mode & 0o777).toBe(0o700);
    }
  });

  it('retains the prior boot secret and removes the empty temporary file when ACL setup fails', () => {
    const file = join(home, 'runtime', 'local-grant.secret');
    const prior = writeLocalGrantSecretFile(file);
    trust.files.mockImplementation(() => {
      throw new Error('ACL denied');
    });
    expect(() => writeLocalGrantSecretFile(file)).toThrow('ACL denied');
    expect(readFileSync(file, 'utf8')).toBe(prior);
    expect(readdirSync(join(home, 'runtime'))).toEqual(['local-grant.secret']);
  });
});
