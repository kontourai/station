/**
 * Publish a plugin that lives in a Project folder to a git remote (#2374,
 * epic #2323 S6; owner decision: git export/push, operator-only). The pushed
 * repository is then an ordinary `station plugin install <url>` source.
 *
 * Publishing is an EXPORT of the folder's current files:
 * 1. `plugin-publish-snapshot.ts` reads the folder without git and without
 *    following links, skipping the folder's `.git` entirely.
 * 2. Those exact bytes are checked here: secret-looking names, private-key
 *    blocks, and `.gitattributes` that name a filter.
 * 3. `plugin-publish-export.ts` builds a commit from them in a fresh
 *    Station-owned repository, as a child of the remote branch's tip, and
 *    pushes it to the validated address, refusing if the remote moved.
 *
 * The folder's own git history is neither read nor updated. Nothing is
 * written anywhere under the folder.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../../utils/logger.js';
import { parsePluginManifestDocument } from '../plugins/plugin-manifest-loader.js';
import {
  type GitRemoteRefusal,
  privateKeyInContent,
  redactRemoteUrl,
  secretLookingPathReason,
  validateGitRemoteUrl,
} from './git-guards.js';
import {
  buildCommit,
  type ExportFailureCode,
  exportFailureCode,
  fetchBranchTip,
  ignoreOracle,
  operatorIdentity,
  pluginInstallSource,
  pushCommit,
  remoteBranchTip,
  withExportWorkspace,
} from './plugin-publish-export.js';
import {
  type SnapshotFile,
  type SnapshotHooks,
  type SnapshotLimits,
  type SnapshotRefusal,
  type SnapshotSkip,
  snapshotPluginFolder,
} from './plugin-publish-snapshot.js';

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MAX_COMMIT_MESSAGE_LENGTH = 5000;
const MAX_MANIFEST_BYTES = 256 * 1024;

export interface PluginPublishServiceOptions {
  /** TEST ONLY; see `ExportGitOptions`. */
  allowFileProtocol?: boolean;
  limits?: Partial<SnapshotLimits>;
  /** TEST SEAMS: the moments a writer racing the publish would act. The
   * route never passes these. */
  testHooks?: SnapshotHooks & {
    beforePush?: () => Promise<void> | void;
  };
}

export interface PluginPublishSecret {
  path: string;
  reason: string;
}

export interface PluginIdentity {
  name: string;
  version: string;
}

/** The cheap answer the Project page asks on mount. Reads `plugin.json`
 * (not through a link); runs no git. */
export type PluginPublishSummary =
  | { plugin: null; reason: 'not-a-plugin' | 'invalid-manifest' }
  | { plugin: PluginIdentity };

export type PluginPublishRefusalCode =
  | 'not-a-plugin'
  | 'invalid-manifest'
  | SnapshotRefusal['code']
  | 'secrets'
  | 'filter-attributes'
  | 'nothing-to-publish'
  | 'invalid-branch'
  | 'invalid-message'
  | GitRemoteRefusal
  | 'git-identity-missing'
  | ExportFailureCode;

export interface PluginPublishRefusal {
  code: PluginPublishRefusalCode;
  /** The files the refusal is about, when it names files. */
  paths?: string[];
  secrets?: PluginPublishSecret[];
}

/** What publishing would send, from a walk of the folder. No network. */
export type PluginPublishInspection =
  | { plugin: null; reason: 'not-a-plugin' | 'invalid-manifest' }
  | {
      plugin: PluginIdentity;
      files: Array<{ path: string; size: number }>;
      skipped: SnapshotSkip[];
      secrets: PluginPublishSecret[];
      /** Why publishing is refused as the folder stands, if it is. */
      refusal: PluginPublishRefusal | null;
    };

export interface PluginPublishRequest {
  remoteUrl: string;
  branch: string;
  message: string;
}

export interface PluginPublishSuccess {
  plugin: PluginIdentity;
  /** The commit pushed, or null when the remote already had these files. */
  commit: string | null;
  /** The remote tip it was built on; null for a new branch. */
  parent: string | null;
  branch: string;
  remoteUrl: string;
  committer: { name: string; email: string };
  files: number;
  skipped: SnapshotSkip[];
  installSource: string;
  installSourceDerived: boolean;
  installCommand: string;
}

class PublishRefused extends Error {
  constructor(readonly refusal: PluginPublishRefusal) {
    super(refusal.code);
  }
}

function refuse(
  code: PluginPublishRefusalCode,
  extra: Omit<PluginPublishRefusal, 'code'> = {},
): never {
  throw new PublishRefused({ code, ...extra });
}

function manifestFrom(
  folder: string,
  bytes: Buffer | undefined,
): PluginIdentity | 'not-a-plugin' | 'invalid-manifest' {
  if (bytes === undefined) return 'not-a-plugin';
  try {
    const manifest = parsePluginManifestDocument(
      bytes.toString('utf8'),
      join(folder, 'plugin.json'),
    );
    return { name: manifest.name, version: manifest.version };
  } catch {
    return 'invalid-manifest';
  }
}

export async function summarizePluginPublish(
  folder: string,
): Promise<PluginPublishSummary> {
  const path = join(folder, 'plugin.json');
  let bytes: Buffer;
  try {
    const seen = await lstat(path);
    if (!seen.isFile() || seen.size > MAX_MANIFEST_BYTES) {
      return { plugin: null, reason: 'not-a-plugin' };
    }
    const handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const status = await handle.stat();
      if (!status.isFile() || status.ino !== seen.ino) {
        return { plugin: null, reason: 'not-a-plugin' };
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return { plugin: null, reason: 'not-a-plugin' };
  }
  const plugin = manifestFrom(folder, bytes);
  return typeof plugin === 'string'
    ? { plugin: null, reason: plugin }
    : { plugin };
}

function findSecrets(files: readonly SnapshotFile[]): PluginPublishSecret[] {
  const secrets: PluginPublishSecret[] = [];
  for (const file of files) {
    const byName = secretLookingPathReason(file.path);
    if (byName) {
      secrets.push({ path: file.path, reason: byName });
      continue;
    }
    // The bytes that will be committed; latin1 keeps every byte one
    // character, and a PEM header is ASCII.
    if (privateKeyInContent(file.bytes.toString('latin1'))) {
      secrets.push({ path: file.path, reason: 'contains a private key' });
    }
  }
  return secrets;
}

/**
 * `.gitattributes` files that assign a filter (git-lfs, or any other). The
 * commit holds the bytes as they are on disk; a filter's clean side is never
 * run, so publishing such a folder would push what the filter was meant to
 * replace (an lfs object's full content instead of its pointer) under
 * attributes that tell every clone to run it. Refused rather than guessed.
 */
function filterAttributeFiles(files: readonly SnapshotFile[]): string[] {
  return files
    .filter((file) => file.path.split('/').at(-1) === '.gitattributes')
    .filter((file) =>
      file.bytes
        .toString('utf8')
        .split(/\r?\n/)
        .some((line) => {
          const trimmed = line.trim();
          if (trimmed === '' || trimmed.startsWith('#')) return false;
          return trimmed
            .split(/\s+/)
            .slice(1)
            .some((attribute) => /^filter=/i.test(attribute));
        }),
    )
    .map((file) => file.path);
}

interface CheckedFolder {
  plugin: PluginIdentity;
  files: SnapshotFile[];
  skipped: SnapshotSkip[];
  secrets: PluginPublishSecret[];
  refusal: PluginPublishRefusal | null;
}

async function checkFolder(
  folder: string,
  workspace: Parameters<typeof ignoreOracle>[0],
  options: PluginPublishServiceOptions,
): Promise<CheckedFolder | { refusal: PluginPublishRefusal }> {
  const snapshot = await snapshotPluginFolder(folder, ignoreOracle(workspace), {
    limits: options.limits,
    hooks: options.testHooks,
  });
  if (!snapshot.ok) {
    const { code, ...rest } = snapshot.refusal;
    return { refusal: { code, ...rest } };
  }
  const { files, skipped } = snapshot;
  const plugin = manifestFrom(
    folder,
    files.find((file) => file.path === 'plugin.json')?.bytes,
  );
  if (typeof plugin === 'string') return { refusal: { code: plugin } };
  const secrets = findSecrets(files);
  const filtered = filterAttributeFiles(files);
  const refusal: PluginPublishRefusal | null =
    secrets.length > 0
      ? { code: 'secrets', secrets }
      : filtered.length > 0
        ? { code: 'filter-attributes', paths: filtered }
        : null;
  return { plugin, files, skipped, secrets, refusal };
}

export async function inspectPluginPublish(
  folder: string,
  options: PluginPublishServiceOptions = {},
): Promise<PluginPublishInspection> {
  return withExportWorkspace(
    { allowFileProtocol: options.allowFileProtocol },
    async (workspace): Promise<PluginPublishInspection> => {
      const checked = await checkFolder(folder, workspace, options);
      if (!('plugin' in checked)) {
        const { code } = checked.refusal;
        if (code === 'not-a-plugin' || code === 'invalid-manifest') {
          return { plugin: null, reason: code };
        }
        // The walk refused the folder (a link swapped in, a name git would
        // mangle): the dialog still names the plugin and says why.
        const summary = await summarizePluginPublish(folder);
        if (!summary.plugin) return summary;
        return {
          plugin: summary.plugin,
          files: [],
          skipped: [],
          secrets: [],
          refusal: checked.refusal,
        };
      }
      return {
        plugin: checked.plugin,
        files: checked.files.map((file) => ({
          path: file.path,
          size: file.bytes.length,
        })),
        skipped: checked.skipped,
        secrets: checked.secrets,
        refusal: checked.refusal,
      };
    },
  );
}

function validBranch(branch: string): boolean {
  return (
    BRANCH_NAME.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('//') &&
    !branch.includes('@{') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.') &&
    !branch.endsWith('.lock') &&
    !branch.split('/').some((part) => part.startsWith('.'))
  );
}

// Two publishes of one folder at once would race for the same remote tip;
// the second waits for the first.
const folderQueues = new Map<string, Promise<unknown>>();

function serialized<T>(folder: string, run: () => Promise<T>): Promise<T> {
  const previous = folderQueues.get(folder) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.catch(() => undefined);
  folderQueues.set(folder, settled);
  void settled.then(() => {
    if (folderQueues.get(folder) === settled) folderQueues.delete(folder);
  });
  return next;
}

export function publishPlugin(
  folder: string,
  request: PluginPublishRequest,
  options: PluginPublishServiceOptions & { logger?: Logger } = {},
): Promise<
  | { ok: true; result: PluginPublishSuccess }
  | { ok: false; refusal: PluginPublishRefusal }
> {
  return serialized(folder, async () => {
    try {
      return {
        ok: true as const,
        result: await publishOnce(folder, request, options),
      };
    } catch (error) {
      if (error instanceof PublishRefused) {
        return { ok: false as const, refusal: error.refusal };
      }
      const code = exportFailureCode(error);
      options.logger?.warn('Plugin publish git step failed', {
        code,
        stderr: String((error as { stderr?: unknown }).stderr ?? '').slice(
          0,
          2000,
        ),
      });
      return { ok: false as const, refusal: { code } };
    }
  });
}

async function publishOnce(
  folder: string,
  request: PluginPublishRequest,
  options: PluginPublishServiceOptions,
): Promise<PluginPublishSuccess> {
  // Everything the request says is judged before the folder is read.
  const message = request.message.trim();
  if (message === '' || message.length > MAX_COMMIT_MESSAGE_LENGTH) {
    refuse('invalid-message');
  }
  const branch = request.branch.trim();
  if (!validBranch(branch)) refuse('invalid-branch');
  const url = request.remoteUrl.trim();
  const verdict = validateGitRemoteUrl(url);
  if (!verdict.ok) refuse(verdict.code);

  return withExportWorkspace(
    { allowFileProtocol: options.allowFileProtocol },
    async (workspace) => {
      const checked = await checkFolder(folder, workspace, options);
      if (!('plugin' in checked)) throw new PublishRefused(checked.refusal);
      if (checked.refusal) throw new PublishRefused(checked.refusal);
      const { plugin, files, skipped } = checked;
      if (files.length === 0) refuse('nothing-to-publish');

      const identity = await operatorIdentity(workspace);
      if (!identity) refuse('git-identity-missing');

      const tip = await remoteBranchTip(workspace, url, branch);
      let parent: string | null = null;
      if (tip !== null) {
        parent = await fetchBranchTip(workspace, url, branch);
        // It moved between the two reads: this publish would already be
        // building on something other than what the remote listed.
        if (parent !== tip) refuse('remote-moved');
      }
      const built = await buildCommit(workspace, {
        files,
        parent,
        message,
        identity,
      });
      if (!built.unchanged) {
        await options.testHooks?.beforePush?.();
        await pushCommit(workspace, {
          url,
          commit: built.commit,
          branch,
          expected: parent,
        });
      }

      const install = pluginInstallSource(url, verdict.transport);
      const source =
        branch === 'main' || branch === 'master'
          ? install.source
          : `${install.source}#${branch}`;
      return {
        plugin,
        commit: built.unchanged ? null : built.commit,
        parent,
        branch,
        remoteUrl: redactRemoteUrl(url),
        committer: identity,
        files: files.length,
        skipped,
        installSource: source,
        installSourceDerived: install.derived,
        installCommand: `station plugin install ${source}`,
      };
    },
  );
}
