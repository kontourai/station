import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateRepairPaths } from '@kontourai/station-contracts/qualification-repair-policy';
import { execGit, killGitProcessTree, spawnGit } from '../../utils/git-exec.js';
import { readProjectRepository } from '../projects/git-read-repository.js';

interface RepairSourceEntry {
  path: string;
  mode: '100644' | '100755';
  sha: string;
  size: number;
}
export interface RepairSourceSnapshot {
  baseSha: string;
  baseTreeSha: string;
  digest: string;
  entries: RepairSourceEntry[];
}
export interface RepairResult {
  digest: string;
  expectedTreeSha: string;
  patch: string;
  files: {
    path: string;
    mode: '100644' | '100755';
    contentBase64: string | null;
  }[];
}
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_SOURCE_FILES = 50_000;
const hash = (type: string, bytes: Buffer) =>
  createHash('sha1')
    .update(`${type} ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
export const repairDigest = (value: unknown): string => {
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : input !== null && typeof input === 'object'
        ? Object.fromEntries(
            Object.entries(input)
              .filter(([, value]) => value !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [key, canonical(value)]),
          )
        : input;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
};

function assertPortablePaths(paths: readonly string[]): void {
  const prefixes = new Map<string, string>();
  for (const path of paths) {
    let prefix = '';
    for (const part of path.split('/')) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const previous = prefixes.get(prefix.toLowerCase());
      if (previous !== undefined && previous !== prefix)
        throw new Error('repair-source-case-collision');
      prefixes.set(prefix.toLowerCase(), prefix);
    }
  }
}

function safeSourcePath(path: string): boolean {
  return (
    path.length <= 1024 &&
    ![...path].some(
      (char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '\\',
    ) &&
    path
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          part !== '.' &&
          part !== '..' &&
          part.toLowerCase() !== '.git',
      )
  );
}

/** Binary batch reads stay behind the same admitted Git config snapshot as the tree read. */
async function readBlobs(
  repoArgs: string[],
  cwd: string,
  shas: string[],
): Promise<Buffer[]> {
  const child = spawnGit([...repoArgs, 'cat-file', '--batch'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let rejected = false;
  return new Promise((resolve, reject) => {
    const fail = () => {
      rejected = true;
      killGitProcessTree(child);
      reject(new Error('repair-source-read-unavailable'));
    };
    const timer = setTimeout(fail, 60_000);
    child.on('error', () => {
      clearTimeout(timer);
      fail();
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_SOURCE_BYTES + MAX_SOURCE_FILES * 128) fail();
      else chunks.push(chunk);
    });
    // Git diagnostics can contain local paths; they are never retained or serialized.
    child.stderr?.resume();
    child.stdin?.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (rejected) return;
      if (code !== 0) {
        fail();
        return;
      }
      try {
        const output = Buffer.concat(chunks);
        let offset = 0;
        const result = shas.map((sha) => {
          const end = output.indexOf(10, offset);
          if (end < 0) throw new Error('header');
          const match = /^([0-9a-f]{40}) blob (0|[1-9][0-9]*)$/.exec(
            output.subarray(offset, end).toString('ascii'),
          );
          if (!match || match[1] !== sha) throw new Error('identity');
          const size = Number(match[2]);
          if (size > 16 * 1024 * 1024 || end + size + 1 >= output.length)
            throw new Error('size');
          const value = output.subarray(end + 1, end + 1 + size);
          offset = end + 2 + size;
          if (output[offset - 1] !== 10 || hash('blob', value) !== sha)
            throw new Error('blob');
          return value;
        });
        if (offset !== output.length) throw new Error('trailing');
        resolve(result);
      } catch {
        reject(new Error('repair-source-read-unavailable'));
      }
    });
    child.stdin?.end(`${shas.join('\n')}\n`);
  });
}

/** No checkout, archive extraction, working-tree content, or repository program is executed. */
export async function prepareRepairSource(input: {
  projectRoot: string;
  repository: string;
  sourceRoot: string;
  workspace: string;
  assertCurrent(): void;
}): Promise<RepairSourceSnapshot> {
  input.assertCurrent();
  const projectRoot = await realpath(input.projectRoot);
  const admitted = await readProjectRepository(
    projectRoot,
    projectRoot,
    {},
    async (repository) => {
      const read = async (...args: string[]) => {
        input.assertCurrent();
        return (
          await execGit([...repository.repoArgs, ...args], {
            cwd: repository.top,
            maxBuffer: 16 * 1024 * 1024,
            timeout: 30_000,
            assertCurrent: input.assertCurrent,
          })
        ).stdout;
      };
      const origin = (
        await read('config', '--get', 'remote.origin.url')
      ).trim();
      if (
        ![
          `https://github.com/${input.repository}.git`,
          `https://github.com/${input.repository}`,
          `git@github.com:${input.repository}.git`,
        ].includes(origin)
      )
        throw new Error('repair-source-repository-mismatch');
      const baseSha = (
        await read('rev-parse', '--verify', 'refs/remotes/origin/main^{commit}')
      ).trim();
      const baseTreeSha = (
        await read('rev-parse', '--verify', `${baseSha}^{tree}`)
      ).trim();
      if (![baseSha, baseTreeSha].every((sha) => /^[0-9a-f]{40}$/.test(sha)))
        throw new Error('repair-source-object-format');
      const raw = await read('ls-tree', '-rz', '--full-tree', baseSha);
      const paths = new Set<string>();
      const entries: RepairSourceEntry[] = raw
        .split('\0')
        .filter(Boolean)
        .map((row) => {
          const match = /^(100644|100755) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(
            row,
          );
          if (
            !match ||
            !safeSourcePath(match[3]) ||
            paths.has(match[3].toLowerCase())
          )
            throw new Error('repair-source-path-or-mode');
          paths.add(match[3].toLowerCase());
          return {
            path: match[3],
            mode: match[1] === '100755' ? '100755' : '100644',
            sha: match[2],
            size: 0,
          };
        });
      if (!entries.length || entries.length > MAX_SOURCE_FILES)
        throw new Error('repair-source-size');
      assertPortablePaths(entries.map((entry) => entry.path));
      const blobs = await readBlobs(
        repository.repoArgs,
        repository.top,
        entries.map((entry) => entry.sha),
      );
      entries.forEach((entry, index) => {
        entry.size = blobs[index].length;
      });
      if (
        entries.reduce((sum, entry) => sum + entry.size, 0) >
          MAX_SOURCE_BYTES ||
        repairTreeSha(entries) !== baseTreeSha
      )
        throw new Error('repair-source-tree-mismatch');
      return { baseSha, baseTreeSha, entries, blobs };
    },
  );
  if (!admitted.ok) throw new Error(`repair-source-${admitted.state}`);
  input.assertCurrent();
  const { blobs, ...snapshot } = admitted.value;
  for (const root of [input.sourceRoot, input.workspace]) {
    await mkdir(root, { recursive: false, mode: 0o700 });
    for (let i = 0; i < snapshot.entries.length; i++) {
      const entry = snapshot.entries[i];
      const path = join(root, entry.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, blobs[i], {
        flag: 'wx',
        mode: entry.mode === '100755' ? 0o700 : 0o600,
      });
      if (root === input.sourceRoot)
        await chmod(path, entry.mode === '100755' ? 0o500 : 0o400);
    }
  }
  return { ...snapshot, digest: repairDigest(snapshot) };
}

/** Reconstructs Git's tree identity without consulting model-owned Git metadata. */
function repairTreeSha(
  entries: readonly Pick<RepairSourceEntry, 'path' | 'mode' | 'sha'>[],
): string {
  type Tree = Map<string, { mode: string; sha: string } | Tree>;
  const tree: Tree = new Map();
  for (const entry of entries) {
    let parent = tree;
    const parts = entry.path.split('/');
    for (const part of parts.slice(0, -1)) {
      let next = parent.get(part);
      if (!next) {
        next = new Map();
        parent.set(part, next);
      }
      if (!(next instanceof Map)) throw new Error('repair-tree-collision');
      parent = next;
    }
    const name = parts.at(-1)!;
    if (parent.has(name)) throw new Error('repair-tree-collision');
    parent.set(name, { mode: entry.mode, sha: entry.sha });
  }
  const digest = (node: Tree): string => {
    const ordered = [...node].sort(([a, left], [b, right]) =>
      Buffer.compare(
        Buffer.from(a + (left instanceof Map ? '/' : '')),
        Buffer.from(b + (right instanceof Map ? '/' : '')),
      ),
    );
    return hash(
      'tree',
      Buffer.concat(
        ordered.map(([name, value]) =>
          Buffer.concat([
            Buffer.from(
              `${value instanceof Map ? '40000' : value.mode} ${name}\0`,
            ),
            Buffer.from(
              value instanceof Map ? digest(value) : value.sha,
              'hex',
            ),
          ]),
        ),
      ),
    );
  };
  return digest(tree);
}

async function regularBytes(
  path: string,
): Promise<{ bytes: Buffer; mode: '100644' | '100755' }> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > 16 * 1024 * 1024
    )
      throw new Error('repair-result-nonregular');
    const bytes = await file.readFile();
    const after = await file.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      bytes.length !== before.size
    )
      throw new Error('repair-result-changing');
    return { bytes, mode: before.mode & 0o111 ? '100755' : '100644' };
  } finally {
    await file.close();
  }
}

function text(bytes: Buffer): string {
  const value = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  if (value.includes('\0')) throw new Error('repair-result-binary-change');
  return value;
}
function patchLines(prefix: string, value: string): string {
  if (!value) return '';
  const lines = value.split('\n');
  const newline = lines.at(-1) === '';
  if (newline) lines.pop();
  return (
    lines.map((line) => `${prefix}${line}\n`).join('') +
    (newline ? '' : '\\ No newline at end of file\n')
  );
}

/** Caller must first observe that the exact owned worker is stopped and removed. */
export async function collectRepairResult(
  snapshot: RepairSourceSnapshot,
  sourceRoot: string,
  workspace: string,
): Promise<RepairResult> {
  const found = new Map<
    string,
    { bytes: Buffer; mode: '100644' | '100755'; sha: string }
  >();
  let total = 0;
  let entries = 0;
  const walk = async (relative: string): Promise<void> => {
    for (const name of await readdir(join(workspace, relative))) {
      if (!relative && name === '.git') continue;
      const path = relative ? `${relative}/${name}` : name;
      if (++entries > 100_000 || path.split('/').length > 128)
        throw new Error('repair-result-entry-limit');
      if (!safeSourcePath(path)) throw new Error('repair-result-path');
      const stat = await lstat(join(workspace, path));
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error('repair-result-nonregular');
      if (stat.isDirectory()) await walk(path);
      else {
        const file = await regularBytes(join(workspace, path));
        total += file.bytes.length;
        if (total > MAX_SOURCE_BYTES || found.size >= MAX_SOURCE_FILES)
          throw new Error('repair-result-size');
        found.set(path, { ...file, sha: hash('blob', file.bytes) });
      }
    }
  };
  await walk('');
  assertPortablePaths([...found.keys()]);
  const original = new Map(
    snapshot.entries.map((entry) => [entry.path, entry]),
  );
  const paths = [...new Set([...original.keys(), ...found.keys()])]
    .filter((path) => {
      const before = original.get(path);
      const after = found.get(path);
      return before?.sha !== after?.sha || before?.mode !== after?.mode;
    })
    .sort();
  try {
    validateRepairPaths(paths);
  } catch {
    throw new Error('repair-result-protected-or-invalid-path');
  }
  let bytes = 0;
  let patch = '';
  const files: RepairResult['files'] = [];
  for (const path of paths) {
    const before = original.get(path);
    const after = found.get(path);
    const oldBytes = before
      ? (await regularBytes(join(sourceRoot, path))).bytes
      : Buffer.alloc(0);
    if (before && hash('blob', oldBytes) !== before.sha)
      throw new Error('repair-source-changed');
    const newBytes = after?.bytes ?? Buffer.alloc(0);
    bytes += newBytes.length;
    if (
      newBytes.length > 128 * 1024 ||
      oldBytes.length > 128 * 1024 ||
      bytes > 1024 * 1024
    )
      throw new Error('repair-result-patch-size');
    files.push({
      path,
      mode: after?.mode ?? before!.mode,
      contentBase64: after ? newBytes.toString('base64') : null,
    });
    patch += `diff --git a/${path} b/${path}\n`;
    if (!before) patch += `new file mode ${after!.mode}\n`;
    else if (!after) patch += `deleted file mode ${before.mode}\n`;
    else if (before.mode !== after.mode)
      patch += `old mode ${before.mode}\nnew mode ${after.mode}\n`;
    patch += `index ${before?.sha ?? '0'.repeat(40)}..${after?.sha ?? '0'.repeat(40)}${before && after && before.mode === after.mode ? ` ${after.mode}` : ''}\n`;
    if (!oldBytes.equals(newBytes)) {
      const oldText = text(oldBytes);
      const newText = text(newBytes);
      const count = (value: string) =>
        value ? value.split('\n').length - (value.endsWith('\n') ? 1 : 0) : 0;
      const oldCount = count(oldText);
      const newCount = count(newText);
      patch += `--- ${before ? `a/${path}` : '/dev/null'}\n+++ ${after ? `b/${path}` : '/dev/null'}\n@@ -${oldCount ? 1 : 0},${oldCount} +${newCount ? 1 : 0},${newCount} @@\n${patchLines('-', oldText)}${patchLines('+', newText)}`;
    }
  }
  const result = {
    expectedTreeSha: repairTreeSha(
      [...found].map(([path, file]) => ({
        path,
        mode: file.mode,
        sha: file.sha,
      })),
    ),
    patch,
    files,
  };
  return { ...result, digest: repairDigest(result) };
}
