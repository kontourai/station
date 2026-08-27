import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  fileTreeOps: { add: vi.fn() },
}));

const { FileTreeService } = await import('../file-tree-service.js');

describe('FileTreeService', () => {
  let dir: string;
  let svc: InstanceType<typeof FileTreeService>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'filetree-test-'));
    svc = new FileTreeService();
    // Create test structure
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'index.ts'), 'export {}');
    writeFileSync(join(dir, 'src', 'app.ts'), 'const x = 1;');
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('listDirectory returns files and directories', () => {
    const entries = svc.listDirectory(dir);
    const names = entries.map((e) => e.name);
    expect(names).toContain('index.ts');
    expect(names).toContain('src');
  });

  test('listDirectory skips node_modules', () => {
    const entries = svc.listDirectory(dir, { depth: 3 });
    const allPaths = JSON.stringify(entries);
    expect(allPaths).not.toContain('node_modules');
  });

  test('readFile returns content', () => {
    expect(svc.readFile(join(dir, 'index.ts'))).toBe('export {}');
  });

  test('readFile throws for missing file', () => {
    expect(() => svc.readFile(join(dir, 'nope.ts'))).toThrow('File not found');
  });

  test('searchFiles finds matching files', () => {
    const results = svc.searchFiles(dir, 'index');
    expect(results.some((e) => e.name === 'index.ts')).toBe(true);
  });

  describe('mutations', () => {
    test('atomically replaces bounded text inside the workspace', () => {
      const entry = svc.writeTextFileWithin(dir, 'src/app.ts', 'next\n');
      expect(entry.path).toBe(join('src', 'app.ts'));
      expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toBe('next\n');
      expect(() =>
        svc.writeTextFileWithin(dir, '../outside.txt', 'no'),
      ).toThrow('Path escapes workspace');
      expect(() =>
        svc.writeTextFileWithin(dir, 'too-large.txt', 'x'.repeat(513 * 1024)),
      ).toThrow('write budget');
    });

    test('createEntry creates a file and returns a relative entry', () => {
      const entry = svc.createEntry(dir, 'src/new.ts', 'file');
      expect(entry).toMatchObject({
        name: 'new.ts',
        path: join('src', 'new.ts'),
        type: 'file',
      });
      expect(existsSync(join(dir, 'src', 'new.ts'))).toBe(true);
    });

    test('createEntry creates intermediate directories for a nested file', () => {
      svc.createEntry(dir, 'a/b/c/leaf.ts', 'file');
      expect(existsSync(join(dir, 'a', 'b', 'c', 'leaf.ts'))).toBe(true);
    });

    test('createEntry creates a directory', () => {
      const entry = svc.createEntry(dir, 'pkg', 'directory');
      expect(entry.type).toBe('directory');
      expect(existsSync(join(dir, 'pkg'))).toBe(true);
    });

    test('createEntry rejects an existing path', () => {
      expect(() => svc.createEntry(dir, 'index.ts', 'file')).toThrow(
        'Already exists',
      );
    });

    test('renameEntry moves content and removes the source', () => {
      svc.renameEntry(dir, 'index.ts', 'src/renamed.ts');
      expect(existsSync(join(dir, 'index.ts'))).toBe(false);
      expect(readFileSync(join(dir, 'src', 'renamed.ts'), 'utf8')).toBe(
        'export {}',
      );
    });

    test('renameEntry rejects when the destination exists', () => {
      expect(() => svc.renameEntry(dir, 'index.ts', 'src/app.ts')).toThrow(
        'Already exists',
      );
    });

    test('deleteEntry removes a file', () => {
      svc.deleteEntry(dir, 'index.ts');
      expect(existsSync(join(dir, 'index.ts'))).toBe(false);
    });

    test('deleteEntry removes a directory recursively', () => {
      svc.deleteEntry(dir, 'src');
      expect(existsSync(join(dir, 'src'))).toBe(false);
    });

    test('deleteEntry throws for a missing target', () => {
      expect(() => svc.deleteEntry(dir, 'nope.ts')).toThrow('Not found');
    });

    describe('workspace containment', () => {
      test('rejects a final symlink instead of reading outside content', () => {
        const outside = join(dir, '..', `outside-${Date.now()}.txt`);
        writeFileSync(outside, 'outside secret');
        symlinkSync(outside, join(dir, 'outside-link.txt'));

        expect(() => svc.readFileWithin(dir, 'outside-link.txt')).toThrow(
          'Symlink target is not allowed',
        );
        rmSync(outside, { force: true });
      });

      test('rejects a final symlink instead of deleting its in-workspace target', () => {
        writeFileSync(join(dir, 'protected.txt'), 'keep me');
        symlinkSync('protected.txt', join(dir, 'protected-link.txt'));

        expect(() => svc.deleteEntry(dir, 'protected-link.txt')).toThrow(
          'Symlink target is not allowed',
        );
        expect(readFileSync(join(dir, 'protected.txt'), 'utf8')).toBe(
          'keep me',
        );
      });

      test('rejects an intermediate symlink that escapes the workspace', () => {
        const outside = mkdtempSync(join(tmpdir(), 'filetree-outside-'));
        writeFileSync(join(outside, 'secret.txt'), 'outside secret');
        symlinkSync(outside, join(dir, 'outside-directory'));

        expect(() =>
          svc.readFileWithin(dir, 'outside-directory/secret.txt'),
        ).toThrow('Path escapes workspace');
        rmSync(outside, { recursive: true, force: true });
      });

      test('rejects a parent-traversal target', () => {
        expect(() => svc.createEntry(dir, '../escape.ts', 'file')).toThrow(
          'escapes workspace',
        );
        expect(existsSync(join(dir, '..', 'escape.ts'))).toBe(false);
      });

      test('rejects a deep traversal payload', () => {
        expect(() =>
          svc.deleteEntry(dir, '../../../../../../tmp/anything'),
        ).toThrow('escapes workspace');
      });

      test('rejects an absolute target', () => {
        expect(() => svc.createEntry(dir, '/etc/evil', 'file')).toThrow(
          'escapes workspace',
        );
      });

      test('rejects operating on the workspace root itself', () => {
        expect(() => svc.deleteEntry(dir, '.')).toThrow('escapes workspace');
      });

      test('rejects a traversal rename in either operand', () => {
        expect(() => svc.renameEntry(dir, 'index.ts', '../out.ts')).toThrow(
          'escapes workspace',
        );
        expect(() => svc.renameEntry(dir, '../in.ts', 'index2.ts')).toThrow(
          'escapes workspace',
        );
      });
    });
  });
});
