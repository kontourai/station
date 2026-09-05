import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type {
  WorkspacePackageInspection,
  WorkspacePackageReceipt,
  WorkspacePackageVerification,
} from '@kontourai/station-contracts/cloud-move';
import { STATION_HOME_SCHEMA_FILE } from './station-home-schema.js';
import { validateWorkspaceGitPacks } from './workspace-git-pack.js';
import {
  COMPONENT_MAX_BYTES,
  digest,
  FILE_MAX_BYTES,
  isWithin,
  MAX_ENTRIES,
  PACKAGE_MAX_BYTES,
  packageGit,
  readBoundedFile,
  validatePaths,
  writePrivateNewFile,
} from './workspace-package-io.js';

const MAGIC = Buffer.from('station-workspace-package/v1\0');
const SCHEMA = 'station.workspace-package/v1';
type IndexEntry = { path: string; mode: '100644' | '100755'; oid: string };
type FileEntry = {
  path: string;
  executable: boolean;
  content: string;
  sha256: string;
};
interface Payload {
  schemaVersion: typeof SCHEMA;
  objectFormat: 'sha1' | 'sha256';
  head: string;
  branch: string | null;
  policy: { autocrlf: string; eol: string; filemode: boolean };
  index: IndexEntry[];
  files: FileEntry[];
  bundle: string;
  indexPack: string;
}

function validateBranch(branch: unknown): asserts branch is string | null {
  if (branch === null) return;
  if (typeof branch !== 'string' || branch.length > 200)
    throw new Error('Branch must be a portable name of at most 200 characters');
  try {
    validatePaths([`branch/${branch}`]);
  } catch {
    throw new Error('Branch is not portable across supported filesystems');
  }
}
function receipt(payload: Payload): WorkspacePackageReceipt {
  return {
    schemaVersion: 'station.workspace-package-receipt/v1',
    head: payload.head,
    branch: payload.branch,
    fileCount: payload.files.length,
    indexEntryCount: payload.index.length,
    untrackedIgnoredFiles: 'omitted',
    gitHistory: 'HEAD-ancestry-only',
    otherRefs: 'omitted',
    capture: 'source-quiescence-required',
    sourceGitConfiguration: 'content-policy-only',
    executionAuthorityTransferred: false,
    credentialEnrollment: 'not-performed',
  };
}
function keyBytes(path: string): Buffer {
  const bytes = readBoundedFile(path, 32);
  if (bytes.length !== 32)
    throw new Error('Workspace key must contain exactly 32 random bytes');
  if (process.platform !== 'win32' && (lstatSync(path).mode & 0o077) !== 0)
    throw new Error('Workspace key must have private file permissions');
  return bytes;
}
export function createWorkspacePackageKey(output: string): void {
  const key = randomBytes(32);
  try {
    writePrivateNewFile(output, key);
  } finally {
    key.fill(0);
  }
}

function nul(bytes: Buffer): string[] {
  return new TextDecoder('utf-8', { fatal: true })
    .decode(bytes)
    .split('\0')
    .filter(Boolean);
}
function indexEntries(workspace: string): IndexEntry[] {
  const flags = nul(packageGit(workspace, ['ls-files', '-v', '-z']));
  if (flags.some((line) => !line.startsWith('H ')))
    throw new Error(
      'Sparse, conflicted, or assume-unchanged index entries are unsupported',
    );
  const diff = [
    'diff',
    '--cached',
    '--name-only',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '-z',
  ];
  if (
    !packageGit(workspace, [...diff, '--ita-visible-in-index']).equals(
      packageGit(workspace, [...diff, '--ita-invisible-in-index']),
    )
  )
    throw new Error('Intent-to-add index entries are unsupported');
  const entries = nul(packageGit(workspace, ['ls-files', '--stage', '-z'])).map(
    (line) => {
      const match =
        /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/.exec(line);
      if (!match)
        throw new Error(
          'Submodules, symbolic links, or conflicted index entries are unsupported',
        );
      return {
        mode: match[1] as IndexEntry['mode'],
        oid: match[2],
        path: match[3],
      };
    },
  );
  validatePaths(entries.map((entry) => entry.path));
  return entries;
}
function fileSnapshot(
  workspace: string,
  index: IndexEntry[],
  filemode: boolean,
): FileEntry[] {
  const indexedModes = new Map(index.map((entry) => [entry.path, entry.mode]));
  const paths = [
    ...new Set(
      nul(
        packageGit(
          workspace,
          ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
          undefined,
          true,
        ),
      ),
    ),
  ].sort();
  // Index paths can be replaced by working directories, so validate the actual
  // regular-file set separately after inspecting every ancestor.
  if (paths.length > MAX_ENTRIES)
    throw new Error('Workspace entry limit exceeded');
  let total = 0;
  const files: FileEntry[] = [];
  for (const path of paths) {
    validatePaths([path]);
    const parts = path.split('/');
    const ancestors: Array<{ path: string; dev: number; ino: number }> = [];
    let missing = false;
    for (let count = 0; count < parts.length; count++) {
      const parent = join(workspace, ...parts.slice(0, count));
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          missing = true;
          break;
        }
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Workspace ancestor is not a regular directory');
      ancestors.push({ path: parent, dev: stat.dev, ino: stat.ino });
    }
    if (missing) continue;
    const full = join(workspace, ...parts);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (info.isDirectory() && !info.isSymbolicLink()) continue;
    const content = readBoundedFile(full, FILE_MAX_BYTES);
    total += content.length;
    if (total > 24 * 1024 * 1024)
      throw new Error('Working-file byte limit exceeded');
    for (const parent of ancestors) {
      const after = lstatSync(parent.path);
      if (
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        after.dev !== parent.dev ||
        after.ino !== parent.ino
      )
        throw new Error('Workspace ancestor changed during capture');
    }
    files.push({
      path,
      executable:
        !filemode && indexedModes.has(path)
          ? indexedModes.get(path) === '100755'
          : (info.mode & 0o111) !== 0,
      content: content.toString('base64'),
      sha256: digest(content),
    });
  }
  validatePaths(files.map((file) => file.path));
  return files;
}
function validateIndexObjects(workspace: string, index: IndexEntry[]): void {
  if (!index.length) return;
  const checked = packageGit(
    workspace,
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    index.map((entry) => `${entry.oid}\n`).join(''),
  )
    .toString()
    .trim()
    .split('\n');
  if (
    checked.length !== index.length ||
    checked.some((line, i) => {
      const [id, type, size] = line.split(' ');
      return (
        id !== index[i].oid ||
        type !== 'blob' ||
        !/^\d+$/.test(size) ||
        Number(size) > FILE_MAX_BYTES
      );
    })
  )
    throw new Error('Invalid staged object');
}

function fingerprintFiles(
  files: FileEntry[],
  includeExecutable = true,
): string {
  return digest(
    Buffer.from(
      JSON.stringify(
        [...files]
          .sort((left, right) =>
            left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
          )
          .map(({ path, executable, sha256 }) => ({
            path,
            executable: includeExecutable ? executable : null,
            sha256,
          })),
      ),
    ),
  );
}
function readContentPolicy(workspace: string): Payload['policy'] {
  const getPolicy = (name: string, fallback: string) =>
    packageGit(
      workspace,
      [
        'config',
        ...(name === 'filemode'
          ? ['--type=bool']
          : name === 'autocrlf'
            ? ['--type=bool-or-str']
            : []),
        `--default=${fallback}`,
        '--get',
        `core.${name}`,
      ],
      undefined,
      true,
    )
      .toString()
      .trim();
  return {
    autocrlf: getPolicy('autocrlf', 'false'),
    eol: getPolicy('eol', 'native'),
    filemode: getPolicy('filemode', 'true') === 'true',
  };
}

export function packWorkspace(input: {
  workspace: string;
  output: string;
  keyFile: string;
  sourcePaused: boolean;
}): WorkspacePackageReceipt {
  if (input.sourcePaused !== true)
    throw new Error(
      'Pause source writers and pass --source-paused before packaging',
    );
  const workspace = realpathSync(input.workspace);
  if (existsSync(join(workspace, STATION_HOME_SCHEMA_FILE)))
    throw new Error(
      'Station homes require their own lifecycle backup; select a project checkout',
    );
  const output = resolve(input.output);
  if (lstatSync(input.keyFile).isSymbolicLink())
    throw new Error('Workspace key must not be a symlink');
  const keyPath = realpathSync(input.keyFile);
  if (
    isWithin(workspace, realpathSync(dirname(output))) ||
    isWithin(workspace, keyPath)
  )
    throw new Error('Package and key must remain outside the source workspace');
  if (existsSync(output)) throw new Error('Package output already exists');
  if (
    realpathSync(
      packageGit(workspace, ['rev-parse', '--show-toplevel']).toString().trim(),
    ) !== workspace
  )
    throw new Error('Select the Git checkout root');
  const commonDir = realpathSync(
    resolve(
      workspace,
      packageGit(workspace, ['rev-parse', '--git-common-dir'])
        .toString()
        .trim(),
    ),
  );
  if (
    isWithin(commonDir, realpathSync(dirname(output))) ||
    isWithin(commonDir, keyPath)
  )
    throw new Error(
      'Package and key must remain outside the backing Git directory',
    );
  const head = packageGit(workspace, ['rev-parse', '--verify', 'HEAD'])
    .toString()
    .trim();
  const objectFormat = packageGit(workspace, [
    'rev-parse',
    '--show-object-format',
  ])
    .toString()
    .trim();
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256')
    throw new Error('Unsupported Git object format');
  let branch: string | null = null;
  const symbolic = packageGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])
    .toString()
    .trim();
  if (symbolic !== 'HEAD') branch = symbolic;
  validateBranch(branch);
  if (
    packageGit(workspace, ['rev-parse', '--is-shallow-repository'])
      .toString()
      .trim() !== 'false'
  )
    throw new Error('Shallow repositories are unsupported');
  const policy = readContentPolicy(workspace);
  if (
    !['true', 'false', 'input'].includes(policy.autocrlf) ||
    !['native', 'lf', 'crlf'].includes(policy.eol)
  )
    throw new Error('Unsupported Git content policy');
  const attributes = packageGit(workspace, [
    'rev-parse',
    '--git-path',
    'info/attributes',
  ])
    .toString()
    .trim();
  if (existsSync(resolve(workspace, attributes)))
    throw new Error(
      'Local info/attributes must be reviewed and removed before packaging',
    );
  const index = indexEntries(workspace);
  validateIndexObjects(workspace, index);
  const files = fileSnapshot(workspace, index, policy.filemode);
  const filterAttributes = nul(
    packageGit(
      workspace,
      ['check-attr', '-z', '--stdin', 'filter'],
      files.map((file) => `${file.path}\0`).join(''),
      true,
    ),
  );
  if (
    filterAttributes.some(
      (value, i) => i % 3 === 2 && value !== 'unspecified' && value !== 'unset',
    )
  )
    throw new Error(
      'External Git filters (including LFS) require a separate transfer adapter',
    );
  const attributePaths = files.map((file) => `${file.path}\0`).join('');
  const attrArgs = ['check-attr', '-a', '-z', '--stdin'];
  const sourceAttributes = packageGit(
    workspace,
    attrArgs,
    attributePaths,
    true,
  );
  if (!sourceAttributes.equals(packageGit(workspace, attrArgs, attributePaths)))
    throw new Error(
      'External Git attribute policy requires a separate transfer adapter',
    );
  const oids = [...new Set(index.map((entry) => entry.oid))];
  const indexPack = oids.length
    ? packageGit(
        workspace,
        ['pack-objects', '--stdout'],
        `${oids.join('\n')}\n`,
      )
    : Buffer.alloc(0);
  const bundle = packageGit(workspace, [
    'bundle',
    'create',
    `--version=${objectFormat === 'sha1' ? 2 : 3}`,
    '-',
    'HEAD',
  ]);
  const payload: Payload = {
    schemaVersion: SCHEMA,
    objectFormat,
    policy,
    head,
    branch,
    index,
    files,
    bundle: bundle.toString('base64'),
    indexPack: indexPack.toString('base64'),
  };
  validatePayload(payload);
  const plain = Buffer.from(JSON.stringify(payload));
  if (plain.length > PACKAGE_MAX_BYTES)
    throw new Error('Workspace package plaintext limit exceeded');
  if (
    JSON.stringify(readContentPolicy(workspace)) !== JSON.stringify(policy) ||
    !packageGit(workspace, attrArgs, attributePaths, true).equals(
      sourceAttributes,
    ) ||
    packageGit(workspace, ['rev-parse', 'HEAD']).toString().trim() !== head ||
    packageGit(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])
      .toString()
      .trim() !== symbolic ||
    JSON.stringify(indexEntries(workspace)) !== JSON.stringify(index) ||
    fingerprintFiles(fileSnapshot(workspace, index, policy.filemode)) !==
      fingerprintFiles(files)
  )
    throw new Error('Source changed during capture; pause writers and retry');
  const iv = randomBytes(12);
  const key = keyBytes(keyPath);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(MAGIC);
    const encrypted = Buffer.concat([
      cipher.update(gzipSync(plain)),
      cipher.final(),
    ]);
    writePrivateNewFile(
      output,
      Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]),
    );
  } finally {
    key.fill(0);
  }
  return receipt(payload);
}
function bytes(value: unknown, limit: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4)
    throw new Error('Invalid bounded package bytes');
  const result = Buffer.from(value, 'base64');
  if (result.length > limit || result.toString('base64') !== value)
    throw new Error('Invalid package encoding');
  return result;
}
function decode(archive: string, keyFile: string): Payload {
  return decodeEnvelope(
    readBoundedFile(archive, PACKAGE_MAX_BYTES + 65536),
    keyFile,
  );
}
function decodeEnvelope(raw: Buffer, keyFile: string): Payload {
  if (
    !raw.subarray(0, MAGIC.length).equals(MAGIC) ||
    raw.length < MAGIC.length + 28
  )
    throw new Error('Invalid workspace package header');
  const key = keyBytes(keyFile);
  let plain: Buffer;
  try {
    const cipher = createDecipheriv(
      'aes-256-gcm',
      key,
      raw.subarray(MAGIC.length, MAGIC.length + 12),
    );
    cipher.setAAD(MAGIC);
    cipher.setAuthTag(raw.subarray(MAGIC.length + 12, MAGIC.length + 28));
    const compressed = Buffer.concat([
      cipher.update(raw.subarray(MAGIC.length + 28)),
      cipher.final(),
    ]);
    plain = gunzipSync(compressed, { maxOutputLength: PACKAGE_MAX_BYTES });
  } catch {
    throw new Error('Workspace package authentication or decompression failed');
  } finally {
    key.fill(0);
  }
  const payload: Payload = JSON.parse(plain.toString('utf8'));
  return validatePayload(payload);
}

function validatePayload(payload: Payload): Payload {
  const exactKeys = (value: unknown, keys: string[]) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  if (
    !exactKeys(payload, [
      'schemaVersion',
      'objectFormat',
      'head',
      'branch',
      'policy',
      'index',
      'files',
      'bundle',
      'indexPack',
    ])
  )
    throw new Error('Invalid workspace package shape');
  if (!exactKeys(payload.policy, ['autocrlf', 'eol', 'filemode']))
    throw new Error('Invalid content policy');
  if (
    !payload ||
    payload.schemaVersion !== SCHEMA ||
    !['sha1', 'sha256'].includes(payload.objectFormat) ||
    !Array.isArray(payload.index) ||
    !Array.isArray(payload.files) ||
    payload.index.length > MAX_ENTRIES ||
    payload.files.length > MAX_ENTRIES ||
    (payload.branch !== null &&
      (typeof payload.branch !== 'string' || payload.branch.length > 200))
  )
    throw new Error('Invalid workspace package shape');
  if (
    !payload.policy ||
    !['true', 'false', 'input'].includes(payload.policy.autocrlf) ||
    !['native', 'lf', 'crlf'].includes(payload.policy.eol) ||
    typeof payload.policy.filemode !== 'boolean'
  )
    throw new Error('Invalid content policy');
  validateBranch(payload.branch);
  const oid =
    payload.objectFormat === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  if (typeof payload.head !== 'string' || !oid.test(payload.head))
    throw new Error('Invalid workspace HEAD');
  for (const entry of payload.index)
    if (
      !exactKeys(entry, ['path', 'mode', 'oid']) ||
      !entry ||
      !['100644', '100755'].includes(entry.mode) ||
      !oid.test(entry.oid)
    )
      throw new Error('Invalid workspace index');
  let total = 0;
  for (const file of payload.files) {
    if (
      !exactKeys(file, ['path', 'executable', 'content', 'sha256']) ||
      !file ||
      typeof file.executable !== 'boolean'
    )
      throw new Error('Invalid workspace file');
    const content = bytes(file.content, FILE_MAX_BYTES);
    total += content.length;
    if (digest(content) !== file.sha256 || total > 24 * 1024 * 1024)
      throw new Error('Workspace file integrity or byte limit failed');
  }
  validatePaths(payload.index.map((entry) => entry.path));
  validatePaths(payload.files.map((file) => file.path));
  const spelling = new Map<string, string>();
  for (const path of [
    ...payload.index.map((entry) => entry.path),
    ...payload.files.map((file) => file.path),
  ]) {
    const key = path.normalize('NFC').toLowerCase();
    if (spelling.has(key) && spelling.get(key) !== path)
      throw new Error('Case-colliding index and workspace paths');
    spelling.set(key, path);
  }
  validateWorkspaceGitPacks(
    bytes(payload.bundle, COMPONENT_MAX_BYTES),
    bytes(payload.indexPack, COMPONENT_MAX_BYTES),
    payload.objectFormat,
    payload.head,
  );
  return payload;
}
export function inspectWorkspacePackage(input: {
  archive: string;
  keyFile: string;
}): WorkspacePackageInspection {
  const payload = decode(input.archive, input.keyFile);
  return {
    ...receipt(payload),
    files: payload.files.map((file) => ({
      path: file.path,
      bytes: bytes(file.content, FILE_MAX_BYTES).length,
      executable: file.executable,
      sha256: file.sha256,
    })),
    gitObjectValidation: 'performed-during-import',
  };
}

export function unpackWorkspace(input: {
  archive: string;
  keyFile: string;
  destination: string;
}): WorkspacePackageReceipt & { workspace: string } {
  const payload = decode(input.archive, input.keyFile);
  const requestedDestination = resolve(input.destination);
  const parent = realpathSync(dirname(requestedDestination));
  const destination = join(parent, basename(requestedDestination));
  // This operation owns only a fresh private directory. It does not register a
  // Station Project, execute repository files, or alter an existing checkout.
  mkdirSync(destination, { mode: 0o700 });
  const identity = lstatSync(destination);
  let temporary: string | undefined;
  try {
    temporary = mkdtempSync(join(tmpdir(), 'station-workspace-import-'));
    const workspace = join(destination, 'workspace');
    mkdirSync(workspace, { mode: 0o700 });
    packageGit(workspace, [
      'init',
      '--template=',
      `--object-format=${payload.objectFormat}`,
      '--initial-branch=main',
    ]);
    const bundle = join(temporary, 'source.bundle');
    writeFileSync(bundle, bytes(payload.bundle, COMPONENT_MAX_BYTES), {
      mode: 0o600,
    });
    packageGit(workspace, [
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--no-write-fetch-head',
      bundle,
      'HEAD',
    ]);
    if (payload.indexPack)
      packageGit(
        workspace,
        ['index-pack', '--stdin', '--strict'],
        bytes(payload.indexPack, COMPONENT_MAX_BYTES),
      );
    packageGit(workspace, ['cat-file', '-e', `${payload.head}^{commit}`]);
    if (payload.branch !== null) {
      packageGit(workspace, [
        'check-ref-format',
        `refs/heads/${payload.branch}`,
      ]);
      packageGit(workspace, [
        'update-ref',
        `refs/heads/${payload.branch}`,
        payload.head,
      ]);
      packageGit(workspace, [
        'symbolic-ref',
        'HEAD',
        `refs/heads/${payload.branch}`,
      ]);
    } else
      packageGit(workspace, ['update-ref', '--no-deref', 'HEAD', payload.head]);
    packageGit(workspace, ['config', 'core.attributesFile', devNull]);
    packageGit(workspace, ['config', 'core.excludesFile', devNull]);
    for (const [name, value] of Object.entries(payload.policy))
      packageGit(workspace, ['config', `core.${name}`, String(value)]);
    if (payload.index.length) {
      validateIndexObjects(workspace, payload.index);
      packageGit(
        workspace,
        ['update-index', '-z', '--index-info'],
        payload.index
          .map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`)
          .join(''),
      );
    }
    const gitIdentity = lstatSync(join(workspace, '.git'));
    for (const file of payload.files) {
      const parts = file.path.split('/');
      const path = join(workspace, ...parts);
      for (let count = 1; count < parts.length; count++) {
        const ancestor = join(workspace, ...parts.slice(0, count));
        if (!existsSync(ancestor)) mkdirSync(ancestor, { mode: 0o700 });
        const info = lstatSync(ancestor);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (info.dev === gitIdentity.dev && info.ino === gitIdentity.ino)
        )
          throw new Error(
            'Workspace path aliases Git metadata or an unsafe directory',
          );
      }
      writeFileSync(path, bytes(file.content, FILE_MAX_BYTES), {
        flag: 'wx',
        mode: file.executable ? 0o700 : 0o600,
      });
      if (process.platform !== 'win32')
        chmodSync(path, file.executable ? 0o700 : 0o600);
    }
    const result = { ...receipt(payload), workspace };
    writeFileSync(
      join(destination, 'workspace-package-receipt.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return result;
  } catch (error) {
    let current: ReturnType<typeof lstatSync> | undefined;
    try {
      current = lstatSync(destination);
    } catch {}
    if (
      current &&
      current.dev === identity.dev &&
      current.ino === identity.ino &&
      !current.isSymbolicLink()
    )
      rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

/** Verify an inactive restored checkout through the same bounded capture and
 * import codecs. All writes belong to a private disposable verification tree;
 * the selected workspace is only read. This is not an execution fence. */
export function verifyWorkspacePackage(input: {
  archive: string;
  keyFile: string;
  workspace: string;
  workspacePaused: boolean;
}): WorkspacePackageVerification {
  if (input.workspacePaused !== true)
    throw new Error(
      'Pause target writers and pass --workspace-paused before verification',
    );
  const envelope = readBoundedFile(input.archive, PACKAGE_MAX_BYTES + 65536);
  const expected = decodeEnvelope(envelope, input.keyFile);
  const packageSha256 = digest(envelope);
  const workspace = realpathSync(input.workspace);
  const temporary = mkdtempSync(
    join(tmpdir(), 'station-workspace-verification-'),
  );
  try {
    const capturedArchive = join(temporary, 'captured.enc');
    packWorkspace({
      workspace,
      keyFile: input.keyFile,
      output: capturedArchive,
      sourcePaused: true,
    });
    const captured = decode(capturedArchive, input.keyFile);
    if (captured.head !== expected.head || captured.branch !== expected.branch)
      throw new Error(
        'Workspace verification failed: HEAD or branch differs from the package',
      );
    if (
      captured.policy.autocrlf !== expected.policy.autocrlf ||
      captured.policy.eol !== expected.policy.eol ||
      captured.policy.filemode !== expected.policy.filemode
    )
      throw new Error(
        'Workspace verification failed: Git content policy differs from the package',
      );
    const indexIdentity = (entries: IndexEntry[]) =>
      JSON.stringify(
        [...entries]
          .sort((left, right) =>
            left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
          )
          .map(({ path, mode, oid }) => [path, mode, oid]),
      );
    if (indexIdentity(captured.index) !== indexIdentity(expected.index))
      throw new Error(
        'Workspace verification failed: staged index differs from the package',
      );
    if (
      fingerprintFiles(captured.files, false) !==
      fingerprintFiles(expected.files, false)
    )
      throw new Error(
        'Workspace verification failed: working files differ from the package',
      );
    // Git validates the actual target-derived history and staged objects in an
    // isolated import. Merely checking object IDs would miss corrupt storage.
    unpackWorkspace({
      archive: capturedArchive,
      keyFile: input.keyFile,
      destination: join(temporary, 'object-check'),
    });
    const assertCurrentMetadata = () => {
      const policy = readContentPolicy(workspace);
      const branch = packageGit(workspace, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ])
        .toString()
        .trim();
      if (
        packageGit(workspace, ['rev-parse', 'HEAD']).toString().trim() !==
          expected.head ||
        (branch === 'HEAD' ? null : branch) !== expected.branch ||
        indexIdentity(indexEntries(workspace)) !==
          indexIdentity(expected.index) ||
        policy.autocrlf !== expected.policy.autocrlf ||
        policy.eol !== expected.policy.eol ||
        policy.filemode !== expected.policy.filemode
      )
        throw new Error(
          'Workspace metadata changed during verification; pause writers and retry',
        );
    };
    assertCurrentMetadata();
    // On POSIX, inspect physical executable bits even when core.filemode=false.
    // Windows cannot attest those bits; its Git index intent is checked above.
    const compareExecutable = process.platform !== 'win32';
    const currentFiles = fileSnapshot(workspace, captured.index, true);
    if (
      fingerprintFiles(currentFiles, compareExecutable) !==
      fingerprintFiles(expected.files, compareExecutable)
    )
      throw new Error(
        'Workspace verification failed: working files differ from the package',
      );
    assertCurrentMetadata();
    return {
      ...receipt(expected),
      workspace,
      verified: true,
      verification: 'HEAD-branch-index-policy-working-files',
      packageSha256,
      verifiedAt: new Date().toISOString(),
      gitObjectValidation: 'performed-in-isolated-import',
      executableModeVerification: compareExecutable
        ? 'passed'
        : 'unavailable-on-windows',
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
