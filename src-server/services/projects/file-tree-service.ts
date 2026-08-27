import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileTreeOps } from '../../telemetry/metrics.js';

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
  children?: FileEntry[];
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.cache',
  '__pycache__',
]);
const MAX_ENTRIES = 500;

export class FileTreeService {
  listDirectory(
    dirPath: string,
    opts?: { depth?: number; maxEntries?: number },
  ): FileEntry[] {
    fileTreeOps.add(1, { operation: 'listDirectory' });
    const depth = opts?.depth ?? 3;
    const maxEntries = opts?.maxEntries ?? MAX_ENTRIES;
    const results: FileEntry[] = [];
    const realRoot = this._realWorkspaceRoot(dirPath);
    this._walk(realRoot, realRoot, depth, maxEntries, results);
    return this._buildTree(results);
  }

  private _buildTree(flat: FileEntry[]): FileEntry[] {
    const map = new Map<string, FileEntry>();
    const roots: FileEntry[] = [];
    // Create entries with children arrays for directories
    for (const entry of flat) {
      const node: FileEntry =
        entry.type === 'directory' ? { ...entry, children: [] } : { ...entry };
      map.set(entry.path, node);
    }
    for (const node of map.values()) {
      const sep = node.path.lastIndexOf('/');
      const parentPath = sep > 0 ? node.path.substring(0, sep) : '';
      const parent = parentPath ? map.get(parentPath) : undefined;
      if (parent?.children) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  private _walk(
    base: string,
    current: string,
    depth: number,
    maxEntries: number,
    results: FileEntry[],
  ): void {
    if (depth < 0 || results.length >= maxEntries) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch (e) {
      console.debug('Failed to read directory:', current, e);
      return;
    }
    for (const name of entries) {
      if (results.length >= maxEntries) break;
      const fullPath = join(current, name);
      try {
        if (lstatSync(fullPath).isSymbolicLink()) continue;
      } catch (e) {
        console.debug('Failed to inspect directory entry:', fullPath, e);
        continue;
      }
      let resolvedPath: string;
      try {
        resolvedPath = realpathSync(fullPath);
        this._assertWithin(base, resolvedPath, name);
      } catch (e) {
        // Do not disclose an escaped symlink through the directory listing.
        console.debug('Skipping path outside workspace:', fullPath, e);
        continue;
      }
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(resolvedPath);
      } catch (e) {
        console.debug('Failed to stat file:', fullPath, e);
        continue;
      }
      const isDir = stat.isDirectory();
      if (isDir && SKIP_DIRS.has(name)) continue;
      results.push({
        name,
        path: relative(base, fullPath),
        type: isDir ? 'directory' : 'file',
        size: isDir ? undefined : stat.size,
        modified: stat.mtime.toISOString(),
      });
      if (isDir && depth > 0) {
        this._walk(base, resolvedPath, depth - 1, maxEntries, results);
      }
    }
  }

  searchFiles(dirPath: string, query: string, maxResults = 50): FileEntry[] {
    fileTreeOps.add(1, { operation: 'searchFiles' });
    const lower = query.toLowerCase();
    const all = this.listDirectory(dirPath, {
      depth: 10,
      maxEntries: MAX_ENTRIES,
    });
    return all
      .filter((e) => e.name.toLowerCase().includes(lower))
      .slice(0, maxResults);
  }

  readFile(filePath: string): string {
    fileTreeOps.add(1, { operation: 'readFile' });
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const buf = readFileSync(filePath);
    // Heuristic binary check: look for null bytes in first 8KB
    const sample = buf.slice(0, 8192);
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0)
        throw new Error(`File appears to be binary: ${filePath}`);
    }
    return buf.toString('utf-8');
  }

  /**
   * Read a file at `rel` (a path relative to the workspace `root`), guaranteeing
   * the target stays inside `root`. The file tree emits workspace-relative
   * paths, so previewing/attaching a file must resolve against the project
   * working directory — not the server's process.cwd() — and must reject
   * traversal payloads, exactly like the workspace mutations.
   */
  readFileWithin(root: string, rel: string): string {
    fileTreeOps.add(1, { operation: 'readFileWithin' });
    return this.readFile(this._resolveExistingWithin(root, rel));
  }

  /** Atomic bounded UTF-8 replacement used by server-owned workspace flows. */
  writeTextFileWithin(root: string, rel: string, content: string): FileEntry {
    fileTreeOps.add(1, { operation: 'writeTextFileWithin' });
    if (Buffer.byteLength(content, 'utf8') > 512 * 1024)
      throw new Error('Text file exceeds workspace write budget');
    const lexical = this._lexicalPathWithin(root, rel);
    const existing = existsSync(lexical.abs);
    const target = existing
      ? {
          realRoot: lexical.realRoot,
          abs: this._resolveExistingWithin(root, rel),
        }
      : this._resolveNewWithin(root, rel);
    this._ensureParentWithin(target.realRoot, target.abs, rel);
    const temporary = `${target.abs}.station-replace-${process.pid}`;
    this._assertWithin(target.realRoot, temporary, rel);
    try {
      writeFileSync(temporary, content, { flag: 'wx' });
      renameSync(temporary, target.abs);
      const resolved = realpathSync(target.abs);
      this._assertWithin(target.realRoot, resolved, rel);
      return this._entryFor(target.realRoot, resolved);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  // ── Mutations ─────────────────────────────────────────────────────────────
  // All mutations are workspace-scoped: `root` is the project working
  // directory and the target is a path relative to it. `_lexicalPathWithin`
  // realpath-resolves the root and rejects anything that escapes it, so a
  // traversal payload (`../../etc/passwd`, an absolute path, or the root
  // itself) can never reach disk. Containment lives in `_assertWithin` alone —
  // one policy, shared by the mutation paths and by the directory walk, which
  // additionally re-checks each resolved entry so an escaping symlink is never
  // disclosed through a listing.

  private _realWorkspaceRoot(root: string): string {
    if (!existsSync(root)) throw new Error(`Workspace not found: ${root}`);
    return realpathSync(root);
  }

  private _lexicalPathWithin(
    root: string,
    rel: string,
  ): {
    realRoot: string;
    abs: string;
  } {
    if (!rel?.trim()) throw new Error('path required');
    const realRoot = this._realWorkspaceRoot(root);
    const abs = resolve(realRoot, rel);
    this._assertWithin(realRoot, abs, rel);
    return { realRoot, abs };
  }

  private _assertWithin(
    realRoot: string,
    target: string,
    original: string,
    allowRoot = false,
  ): void {
    const rrel = relative(realRoot, target);
    if (
      (!allowRoot && rrel === '') ||
      rrel.startsWith('..') ||
      isAbsolute(rrel)
    ) {
      throw new Error(`Path escapes workspace: ${original}`);
    }
  }

  private _resolveExistingWithin(root: string, rel: string): string {
    const { realRoot, abs } = this._lexicalPathWithin(root, rel);
    if (!existsSync(abs)) throw new Error(`Not found: ${rel}`);
    if (lstatSync(abs).isSymbolicLink()) {
      throw new Error(`Symlink target is not allowed: ${rel}`);
    }
    const resolved = realpathSync(abs);
    this._assertWithin(realRoot, resolved, rel);
    return resolved;
  }

  /**
   * Validate the deepest existing parent before a create/rename destination.
   * A later filesystem swap remains a platform TOCTOU limitation; callers use
   * exclusive file creation and post-create realpath verification to narrow it.
   */
  private _resolveNewWithin(
    root: string,
    rel: string,
  ): {
    realRoot: string;
    abs: string;
  } {
    const target = this._lexicalPathWithin(root, rel);
    if (existsSync(target.abs)) throw new Error(`Already exists: ${rel}`);
    let parent = dirname(target.abs);
    while (!existsSync(parent)) parent = dirname(parent);
    this._assertWithin(target.realRoot, realpathSync(parent), rel, true);
    return target;
  }

  private _ensureParentWithin(
    realRoot: string,
    abs: string,
    rel: string,
  ): void {
    mkdirSync(dirname(abs), { recursive: true });
    this._assertWithin(realRoot, realpathSync(dirname(abs)), rel, true);
  }

  private _entryFor(realRoot: string, abs: string): FileEntry {
    const stat = statSync(abs);
    const isDir = stat.isDirectory();
    return {
      name: basename(abs),
      path: relative(realRoot, abs),
      type: isDir ? 'directory' : 'file',
      size: isDir ? undefined : stat.size,
      modified: stat.mtime.toISOString(),
    };
  }

  /** Create an empty file or a directory at `rel` within `root`. */
  createEntry(
    root: string,
    rel: string,
    type: 'file' | 'directory',
  ): FileEntry {
    fileTreeOps.add(1, { operation: 'createEntry' });
    const { realRoot, abs } = this._resolveNewWithin(root, rel);
    if (type === 'directory') {
      this._ensureParentWithin(realRoot, abs, rel);
      mkdirSync(abs);
    } else {
      this._ensureParentWithin(realRoot, abs, rel);
      writeFileSync(abs, '', { flag: 'wx' });
    }
    const resolved = realpathSync(abs);
    this._assertWithin(realRoot, resolved, rel);
    return this._entryFor(realRoot, resolved);
  }

  /** Rename or move `from` to `to`, both within `root`. */
  renameEntry(root: string, from: string, to: string): FileEntry {
    fileTreeOps.add(1, { operation: 'renameEntry' });
    const absFrom = this._resolveExistingWithin(root, from);
    const { realRoot, abs: absTo } = this._resolveNewWithin(root, to);
    this._ensureParentWithin(realRoot, absTo, to);
    renameSync(absFrom, absTo);
    const resolved = realpathSync(absTo);
    this._assertWithin(realRoot, resolved, to);
    return this._entryFor(realRoot, resolved);
  }

  /** Delete a file or directory (recursively) at `rel` within `root`. */
  deleteEntry(root: string, rel: string): void {
    fileTreeOps.add(1, { operation: 'deleteEntry' });
    const abs = this._resolveExistingWithin(root, rel);
    rmSync(abs, { recursive: true, force: true });
  }
}
