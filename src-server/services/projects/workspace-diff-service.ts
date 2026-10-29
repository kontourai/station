import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { join, sep } from 'node:path';
import { execGit } from '../../utils/git-exec.js';
import type { ReadRepository } from './git-read-repository.js';
import type { WorkspaceFilePreviewFsPort } from './workspace-file-preview-service.js';

const MAX_FILES = 128;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_LIST_BYTES = 64 * 1024;
const DEADLINE_MS = 30_000;

const filesystem: WorkspaceFilePreviewFsPort = {
  noFollow: constants.O_NOFOLLOW,
  realpath: realpathSync,
  lstat: lstatSync,
  open: openSync,
  fstat: fstatSync,
  read: readSync,
  close: closeSync,
};

function refuse(reason: string): never {
  throw new Error(
    `Worktree diff unavailable: ${reason}. No partial patch was returned`,
  );
}

function same(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** The preview's descriptor port, with per-component pre/post checks as well.
 * These are observed identities, not an atomic openat filesystem snapshot. */
function readAddition(
  root: string,
  path: string,
  fs: WorkspaceFilePreviewFsPort,
) {
  const parts = path.split('/');
  if (
    path.length > 4096 ||
    parts.length > 64 ||
    parts.some(
      (part) =>
        !part || part === '.' || part === '..' || part.toLowerCase() === '.git',
    ) ||
    path.includes('\\') ||
    /^[A-Za-z]:/.test(path)
  ) {
    refuse('an untracked path cannot be safely represented');
  }
  // Non-ignored credentials still need an explicit refusal, never an automatic read.
  if (
    parts.some(
      (part) =>
        /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(
          part,
        ) || /\.(?:pem|key|p12|pfx)$/i.test(part),
    )
  ) {
    refuse('an untracked path may contain credentials; inspect it separately');
  }
  const chain: Array<{ path: string; stat: Stats }> = [];
  for (let i = 0; i < parts.length; i++) {
    const directory = join(root, ...parts.slice(0, i));
    const stat = fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      refuse('an untracked parent is not a regular directory');
    chain.push({ path: directory, stat });
  }
  const target = join(root, ...parts);
  const before = fs.lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    refuse('an untracked entry is not a single-link regular file');
  if (before.size > MAX_FILE_BYTES) refuse('an untracked file exceeds 256 KiB');
  const recheck = () => {
    for (const directory of chain) {
      if (!same(directory.stat, fs.lstat(directory.path)))
        refuse('an untracked directory changed during the read');
    }
    if (fs.realpath(target) !== target || !same(before, fs.lstat(target)))
      refuse('an untracked file changed during the read');
  };
  recheck();
  const descriptor = fs.open(
    target,
    constants.O_RDONLY | (fs.noFollow ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!same(before, fs.fstat(descriptor)))
      refuse('an untracked file changed while opening');
    recheck();
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.read(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (count === 0) break;
      length += count;
    }
    if (length !== before.size || !same(before, fs.fstat(descriptor)))
      refuse('an untracked file changed while reading');
    recheck();
    return {
      bytes: bytes.subarray(0, length),
      executable: (before.mode & 0o111) !== 0,
      recheck,
    };
  } finally {
    fs.close(descriptor);
  }
}

/** Git C quoting, including octal UTF-8 bytes, as Pierre decodes it. */
function quote(path: string): string {
  const bytes = Buffer.from(path);
  if (
    !bytes.some(
      (byte) => byte <= 32 || byte >= 127 || byte === 34 || byte === 92,
    )
  )
    return path;
  return `"${[...bytes]
    .map((byte) => {
      if (byte < 32 || byte >= 127)
        return `\\${byte.toString(8).padStart(3, '0')}`;
      if (byte === 34 || byte === 92) return `\\${String.fromCharCode(byte)}`;
      return String.fromCharCode(byte);
    })
    .join('')}"`;
}

function additionPatch(
  path: string,
  bytes: Buffer,
  executable: boolean,
): string {
  const oldPath = quote(`a/${path}`);
  const newPath = quote(`b/${path}`);
  const header = `diff --git ${oldPath} ${newPath}\nnew file mode ${executable ? '100755' : '100644'}\n`;
  if (bytes.length === 0) return header;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
    if (bytes.includes(0)) throw new Error('binary');
  } catch {
    return `${header}Binary files /dev/null and ${newPath} differ\n`;
  }
  const lines = text.split('\n');
  const hasNewline = text.endsWith('\n');
  if (hasNewline) lines.pop();
  return `${header}--- /dev/null\n+++ ${newPath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join('')}${hasNewline ? '' : '\\ No newline at end of file\n'}`;
}

/** Index-relative tracked edits plus non-ignored untracked additions. Staged-only
 * edits stay excluded. Every Git call uses the caller's judged read snapshot;
 * no add, hash-object, index write or member object write is needed. */
export async function readWorkspaceDiff(
  { top, repoArgs }: ReadRepository,
  fs: WorkspaceFilePreviewFsPort = filesystem,
): Promise<string> {
  const deadline = Date.now() + DEADLINE_MS;
  const git = async (args: string[], maxBuffer: number) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) refuse('the 30 second read deadline was exceeded');
    try {
      return (
        await execGit([...repoArgs, ...args], {
          cwd: top,
          encoding: 'utf8',
          timeout: remaining,
          maxBuffer,
        })
      ).stdout;
    } catch (error) {
      if (
        (error as { code?: unknown }).code ===
        'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
      )
        refuse('the patch or untracked listing exceeds its byte limit');
      throw error;
    }
  };
  // Git's untracked listing omits FIFOs and sockets. Inspect non-ignored
  // directories with a bounded iterator before claiming this is a complete read.
  const pending = [top];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    if (directory.slice(top.length).split(sep).length > 64)
      refuse('directory nesting exceeds 64 components');
    const before = fs.lstat(directory);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      fs.realpath(directory) !== directory
    )
      refuse('a directory cannot be inspected safely');
    const children: Array<{
      name: string;
      directory: boolean;
      special: boolean;
    }> = [];
    const handle = opendirSync(directory);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++entries > 16384 || Date.now() >= deadline)
          refuse(
            'the non-ignored directory scan exceeds its entry or time limit',
          );
        if (entry.name.toLowerCase() === '.git') continue;
        children.push({
          name: entry.name,
          directory: entry.isDirectory(),
          special:
            !entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink(),
        });
        if (children.length > 4096) refuse('a directory exceeds 4096 entries');
      }
    } finally {
      handle.closeSync();
    }
    if (!same(before, fs.lstat(directory)))
      refuse('a directory changed during inspection');
    const candidates = children.filter(
      (entry) => entry.directory || entry.special,
    );
    if (!candidates.length) continue;
    const paths = candidates.map((entry) =>
      join(directory, entry.name)
        .slice(top.length + 1)
        .split(sep)
        .join('/'),
    );
    const input = paths.map((path) => `${path}\0`).join('');
    if (Buffer.byteLength(input) > MAX_LIST_BYTES)
      refuse('directory paths exceed 64 KiB');
    let ignored: string;
    try {
      ignored = (
        await execGit([...repoArgs, 'check-ignore', '--stdin', '-z'], {
          cwd: top,
          encoding: 'utf8',
          timeout: Math.max(1, deadline - Date.now()),
          maxBuffer: MAX_LIST_BYTES,
          input,
        })
      ).stdout;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error;
      ignored = (error as { stdout: string }).stdout;
    }
    const excluded = new Set(ignored.split('\0'));
    for (const [index, entry] of candidates.entries()) {
      if (excluded.has(paths[index])) continue;
      if (entry.special)
        refuse('an untracked special file cannot be represented');
      const child = join(directory, entry.name);
      // Marker existence does not prove Git recognizes a nested repository:
      // malformed .git files plus special files disappear from ls-files.
      let marker = false;
      try {
        fs.lstat(join(child, '.git'));
        marker = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (marker) {
        const indexed = await git(
          ['ls-files', '--stage', '-z', '--', `:(literal)${paths[index]}`],
          MAX_LIST_BYTES,
        );
        const records = indexed.split('\0').filter(Boolean);
        const record = records[0];
        const tab = record?.indexOf('\t') ?? -1;
        if (
          records.length === 1 &&
          record.startsWith('160000 ') &&
          record.slice(0, tab).endsWith(' 0') &&
          record.slice(tab + 1) === paths[index]
        )
          continue;
        refuse('an unverified nested git marker prevents a complete read');
      }
      pending.push(child);
      if (pending.length > 128) refuse('more than 128 pending directories');
    }
  }
  // Keep plain diff's index-relative behavior, but never emit terminal colors.
  let patch = await git(['diff', '--no-color'], MAX_PATCH_BYTES);
  const list = () =>
    git(['ls-files', '--others', '--exclude-standard', '-z'], MAX_LIST_BYTES);
  const listing = await list();
  if (listing && !listing.endsWith('\0'))
    refuse('the untracked listing is incomplete');
  const paths = listing ? listing.slice(0, -1).split('\0') : [];
  if (paths.length > MAX_FILES) refuse('more than 128 untracked files');
  // execGit returns UTF-8 text: refuse undecodable names rather than guessing a path.
  if (paths.some((path) => path.includes('\ufffd')))
    refuse('an untracked filename is not supported UTF-8');
  const rechecks: Array<() => void> = [];
  let contentBytes = 0;
  try {
    for (const path of paths) {
      if (Date.now() >= deadline)
        refuse('the 30 second read deadline was exceeded');
      const file = readAddition(top, path, fs);
      contentBytes += file.bytes.length;
      if (contentBytes > MAX_CONTENT_BYTES)
        refuse('untracked contents exceed 2 MiB');
      patch += additionPatch(path, file.bytes, file.executable);
      if (Buffer.byteLength(patch) > MAX_PATCH_BYTES)
        refuse('the patch exceeds 4 MiB');
      rechecks.push(file.recheck);
    }
    if (paths.length && (await list()) !== listing)
      refuse('the non-ignored untracked listing changed during the read');
    for (const recheck of rechecks) recheck();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Worktree diff unavailable:')
    )
      throw error;
    refuse('an untracked entry could not be read safely');
  }
  return patch;
}
