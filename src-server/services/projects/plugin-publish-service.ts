/**
 * Publish a plugin that lives in a Project folder to a git remote (epic
 * #2323 S6, owner decision: git export/push). The pushed repository is then
 * an ordinary `station plugin install <url>` source, and installs made from
 * it update by pulling, as every git-backed install already does.
 *
 * Every git call goes through `plugin-publish-git.ts`: no shell, a timeout,
 * and overrides that keep the folder's own `.git` from running code as the
 * operator or reaching any transport but https/ssh (read that file's header
 * for the full list and why). Nothing here force-pushes: the only refspec it
 * builds is `refs/heads/<branch>:refs/heads/<branch>`.
 */
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../utils/logger.js';
import { readPluginManifestFile } from '../plugins/plugin-manifest-loader.js';
import {
  checkRepositoryConfig,
  type PublishGitOptions,
  type RepositoryConfigRefusal,
  readOperatorCredentialHelpers,
  runPublishGit,
  streamPublishStatus,
} from './plugin-publish-git.js';
import {
  type PluginPublishRemoteRefusal,
  privateKeyInContent,
  redactRemoteUrl,
  secretLookingPathReason,
  validatePluginPublishRemoteUrl,
} from './plugin-publish-guards.js';

const GIT_READ_TIMEOUT_MS = 15_000;
const GIT_COMMIT_TIMEOUT_MS = 60_000;
const GIT_PUSH_TIMEOUT_MS = 120_000;
/** Beyond this the folder almost certainly holds build output or
 * dependencies that belong in `.gitignore`; it also bounds git's argv. */
const MAX_PUBLISH_PATHS = 1000;
const MAX_CONTENT_SCAN_BYTES = 512 * 1024;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_COMMIT_MESSAGE_LENGTH = 5000;

/** Knobs for the service. `allowFileProtocol` is test-only (see
 * `PublishGitOptions`); the limits exist so tests can reach the cap and the
 * timeout without writing thousands of files. */
export interface PluginPublishServiceOptions {
  allowFileProtocol?: boolean;
  limits?: { maxPaths?: number; statusTimeoutMs?: number };
}

export interface PluginPublishChange {
  path: string;
  /** Two-letter `git status --porcelain` code, e.g. `??`, ` M`, `D `. */
  status: string;
}

export interface PluginPublishSecret {
  path: string;
  reason: string;
}

export interface PluginPublishRemote {
  name: string;
  /** Fetch address with any userinfo removed. */
  url: string;
  usable: boolean;
  refusal?: PluginPublishRemoteRefusal;
  installSource?: string;
  installSourceDerived?: boolean;
}

export type PluginPublishRepository =
  | { state: 'none' }
  | { state: 'nested' }
  | {
      /** Station will not run git in this folder; nothing was run. */
      state: 'refused';
      code: RepositoryRefusalCode;
      /** For `repository-config-refused`: the offending config keys. */
      keys?: string[];
    }
  | {
      state: 'root';
      branch: string | null;
      hasCommits: boolean;
      remotes: PluginPublishRemote[];
    };

export type RepositoryRefusalCode =
  | RepositoryConfigRefusal['code']
  | 'repository-unreadable';

/** The cheap answer the Project page asks for on mount: whether this folder
 * is a plugin at all. Reads `plugin.json`; runs no git. */
export type PluginPublishSummary =
  | { plugin: null; reason: 'not-a-plugin' | 'invalid-manifest' }
  | { plugin: { name: string; version: string } };

export type PluginPublishInspection =
  | { plugin: null; reason: 'not-a-plugin' | 'invalid-manifest' }
  | {
      plugin: { name: string; version: string };
      repository: PluginPublishRepository;
      changes: PluginPublishChange[];
      secrets: PluginPublishSecret[];
      tooManyChanges: boolean;
    };

export interface PluginPublishRequest {
  message: string;
  remoteName: string;
  /** Required when `remoteName` does not exist yet; it is then added. */
  remoteUrl?: string;
}

export type PluginPublishRefusalCode =
  | 'not-a-plugin'
  | 'invalid-manifest'
  | 'nested-repository'
  | RepositoryRefusalCode
  | 'detached-head'
  | 'invalid-remote-name'
  | 'invalid-message'
  | 'remote-missing'
  | 'remote-mismatch'
  | PluginPublishRemoteRefusal
  | 'secrets'
  | 'too-many-changes'
  | 'nothing-to-publish'
  | 'push-rejected'
  | 'push-auth-failed'
  | 'git-identity-missing'
  | 'git-timeout'
  | 'git-failed';

export interface PluginPublishRefusal {
  code: PluginPublishRefusalCode;
  secrets?: PluginPublishSecret[];
  keys?: string[];
}

export interface PluginPublishSuccess {
  plugin: { name: string; version: string };
  /** The commit made for this publish, or null when the tree was clean. */
  commit: string | null;
  branch: string;
  remote: { name: string; url: string };
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

interface GitRunner {
  run(cwd: string, args: string[], timeout?: number): Promise<string>;
  ok(cwd: string, args: string[]): Promise<string | null>;
  options: PublishGitOptions;
}

function gitRunner(options: PublishGitOptions): GitRunner {
  const run = (cwd: string, args: string[], timeout = GIT_READ_TIMEOUT_MS) =>
    runPublishGit(cwd, args, options, timeout);
  return {
    run,
    ok: async (cwd, args) => {
      try {
        return await run(cwd, args);
      } catch {
        return null;
      }
    },
    options,
  };
}

async function readPlugin(
  folder: string,
): Promise<
  { name: string; version: string } | 'not-a-plugin' | 'invalid-manifest'
> {
  const manifestPath = join(folder, 'plugin.json');
  try {
    const status = await lstat(manifestPath);
    if (!status.isFile()) return 'not-a-plugin';
  } catch {
    return 'not-a-plugin';
  }
  try {
    const manifest = await readPluginManifestFile(manifestPath);
    return { name: manifest.name, version: manifest.version };
  } catch {
    return 'invalid-manifest';
  }
}

/**
 * Where the folder stands, checked BEFORE any other git call runs in it.
 * `none` only when git says the folder is not in any repository (review
 * M2): any other failure is refused, because `git init` on a misread
 * answer would nest a repository inside an existing one.
 */
async function repositoryState(
  folder: string,
  git: GitRunner,
): Promise<
  'none' | 'nested' | 'root' | { code: RepositoryRefusalCode; keys?: string[] }
> {
  let config: Awaited<ReturnType<typeof checkRepositoryConfig>>;
  try {
    config = await checkRepositoryConfig(folder);
  } catch {
    // An unparseable `.git/config` is not one git should be pointed at.
    return { code: 'repository-config-refused', keys: [] };
  }
  if (config !== 'absent' && config !== 'ok') return config;
  let top: string;
  try {
    top = await git.run(folder, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    // A `.git` git does not recognise (no HEAD, a corrupt one) is not an
    // empty folder: `git init` there would re-initialise it.
    if (config === 'absent' && /not a git repository/i.test(stderr)) {
      return 'none';
    }
    return { code: 'repository-unreadable' };
  }
  const [a, b] = await Promise.all([realpath(top.trim()), realpath(folder)]);
  if (a !== b) return 'nested';
  // Git found a repository at this folder, so its `.git` must be the one
  // just checked; anything else is a layout this code does not vouch for.
  return config === 'ok' ? 'root' : { code: 'repository-unreadable' };
}

/**
 * What `git add -A` would stage, capped. For a folder that is not a
 * repository yet this runs against a throwaway git directory in the system
 * temp folder, so the answer honours the folder's `.gitignore` without
 * initialising anything in it before the person has confirmed.
 */
async function pendingChanges(
  folder: string,
  state: 'none' | 'root',
  git: GitRunner,
  limits: PluginPublishServiceOptions['limits'],
): Promise<{ changes: PluginPublishChange[]; tooMany: boolean }> {
  const caps = {
    maxPaths: limits?.maxPaths ?? MAX_PUBLISH_PATHS,
    timeoutMs: limits?.statusTimeoutMs ?? GIT_READ_TIMEOUT_MS,
  };
  if (state === 'root') {
    return streamPublishStatus(folder, [], git.options, caps);
  }
  const scratch = await mkdtemp(join(tmpdir(), 'station-plugin-publish-'));
  try {
    await git.run(scratch, ['init', '--quiet', scratch]);
    return await streamPublishStatus(
      folder,
      [`--git-dir=${join(scratch, '.git')}`, `--work-tree=${folder}`],
      git.options,
      caps,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function findSecrets(
  folder: string,
  changes: readonly PluginPublishChange[],
): Promise<PluginPublishSecret[]> {
  const secrets: PluginPublishSecret[] = [];
  for (const change of changes) {
    // A deletion removes the file from the next commit; it cannot publish it.
    if (change.status.includes('D')) continue;
    const byName = secretLookingPathReason(change.path);
    if (byName) {
      secrets.push({ path: change.path, reason: byName });
      continue;
    }
    try {
      const file = join(folder, change.path);
      const status = await lstat(file);
      if (!status.isFile() || status.size > MAX_CONTENT_SCAN_BYTES) continue;
      if (privateKeyInContent(await readFile(file, 'utf-8'))) {
        secrets.push({ path: change.path, reason: 'contains a private key' });
      }
    } catch {
      // Gone since `git status`: nothing of it will be committed.
    }
  }
  return secrets;
}

/**
 * The addresses as CONFIGURED, read from git config rather than through
 * `git remote get-url`, which applies `url.<base>.insteadOf` rewrites. The
 * guard judges what the person chose, the same thing it judges for a new
 * remote they type in; a rewrite in this computer's own git config is the
 * operator's own routing and applies to both alike.
 */
async function remoteUrls(
  folder: string,
  name: string,
  git: GitRunner,
): Promise<{ fetch: string; push: string[] } | null> {
  const lines = (output: string | null) =>
    (output ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  const fetch = lines(
    await git.ok(folder, ['config', '--get-all', `remote.${name}.url`]),
  );
  if (fetch.length === 0) return null;
  const push = lines(
    await git.ok(folder, ['config', '--get-all', `remote.${name}.pushurl`]),
  );
  // Without a pushurl, git pushes to every `url`.
  return { fetch: fetch[0], push: push.length > 0 ? push : fetch };
}

/** A remote is usable only when its fetch address AND every push address
 * pass the same guard: `pushurl` can point somewhere `url` does not. */
function describeRemote(
  name: string,
  urls: { fetch: string; push: string[] },
): PluginPublishRemote {
  const fetchVerdict = validatePluginPublishRemoteUrl(urls.fetch);
  const failing = [
    fetchVerdict,
    ...urls.push.map(validatePluginPublishRemoteUrl),
  ].find((verdict) => !verdict.ok);
  const base = { name, url: redactRemoteUrl(urls.fetch) };
  if (failing && !failing.ok)
    return { ...base, usable: false, refusal: failing.code };
  if (!fetchVerdict.ok)
    return { ...base, usable: false, refusal: fetchVerdict.code };
  return {
    ...base,
    usable: true,
    installSource: fetchVerdict.installSource,
    installSourceDerived: fetchVerdict.installSourceDerived,
  };
}

async function listRemotes(
  folder: string,
  git: GitRunner,
): Promise<PluginPublishRemote[]> {
  const names = ((await git.ok(folder, ['remote'])) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const remotes: PluginPublishRemote[] = [];
  for (const name of names) {
    const urls = await remoteUrls(folder, name, git);
    if (urls) remotes.push(describeRemote(name, urls));
  }
  return remotes;
}

async function currentBranch(
  folder: string,
  git: GitRunner,
): Promise<string | null> {
  const branch = await git.ok(folder, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  return branch?.trim() || null;
}

async function hasCommits(folder: string, git: GitRunner): Promise<boolean> {
  return (
    (await git.ok(folder, ['rev-parse', '--verify', '--quiet', 'HEAD'])) !==
    null
  );
}

export async function summarizePluginPublish(
  folder: string,
): Promise<PluginPublishSummary> {
  const plugin = await readPlugin(folder);
  return typeof plugin === 'string'
    ? { plugin: null, reason: plugin }
    : { plugin };
}

export async function inspectPluginPublish(
  folder: string,
  options: PluginPublishServiceOptions = {},
): Promise<PluginPublishInspection> {
  const plugin = await readPlugin(folder);
  if (typeof plugin === 'string') return { plugin: null, reason: plugin };
  const git = gitRunner({ allowFileProtocol: options.allowFileProtocol });
  const state = await repositoryState(folder, git);
  if (typeof state === 'object' || state === 'nested') {
    return {
      plugin,
      repository:
        state === 'nested' ? { state } : { state: 'refused', ...state },
      changes: [],
      secrets: [],
      tooManyChanges: false,
    };
  }
  const { changes, tooMany } = await pendingChanges(
    folder,
    state,
    git,
    options.limits,
  );
  const secrets = tooMany ? [] : await findSecrets(folder, changes);
  const repository: PluginPublishRepository =
    state === 'none'
      ? { state }
      : {
          state,
          branch: await currentBranch(folder, git),
          hasCommits: await hasCommits(folder, git),
          remotes: await listRemotes(folder, git),
        };
  return { plugin, repository, changes, secrets, tooManyChanges: tooMany };
}

function gitFailureCode(error: unknown): PluginPublishRefusalCode {
  const failure = error as {
    killed?: boolean;
    signal?: string;
    stdout?: unknown;
    stderr?: unknown;
  };
  if (failure.killed || failure.signal === 'SIGTERM') return 'git-timeout';
  // `push --porcelain` reports a rejected ref on stdout, the hint on stderr.
  const output = [failure.stdout, failure.stderr]
    .filter((text): text is string => typeof text === 'string')
    .join('\n');
  if (/please tell me who you are|unable to auto-detect email/i.test(output)) {
    return 'git-identity-missing';
  }
  if (
    /non-fast-forward|fetch first|updates were rejected|\[rejected\]/i.test(
      output,
    )
  ) {
    return 'push-rejected';
  }
  if (
    /authentication failed|permission denied|could not read (username|password)|terminal prompts disabled|access denied|403/i.test(
      output,
    )
  ) {
    return 'push-auth-failed';
  }
  return 'git-failed';
}

// Two publishes of one folder at once would race on git's index lock and
// on which commit gets pushed; the second waits for the first.
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

/**
 * Checks everything first, then initialises (if needed), adds the remote
 * (if new), stages exactly the paths it checked, commits and pushes.
 * Nothing in the folder changes before every refusal has had its chance.
 */
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
      const code = gitFailureCode(error);
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
  const git = gitRunner({ allowFileProtocol: options.allowFileProtocol });
  const message = request.message.trim();
  if (message === '' || message.length > MAX_COMMIT_MESSAGE_LENGTH) {
    refuse('invalid-message');
  }
  if (!REMOTE_NAME.test(request.remoteName)) refuse('invalid-remote-name');

  const plugin = await readPlugin(folder);
  if (typeof plugin === 'string') refuse(plugin);
  const state = await repositoryState(folder, git);
  if (typeof state === 'object') refuse(state.code, { keys: state.keys });
  if (state === 'nested') refuse('nested-repository');

  // The remote: an existing one must pass the guard on every address it
  // holds; a new one must pass it on the address the person typed.
  const existing =
    state === 'root' ? await remoteUrls(folder, request.remoteName, git) : null;
  let newRemoteUrl: string | null = null;
  let urls: { fetch: string; push: string[] };
  if (existing) {
    if (
      request.remoteUrl !== undefined &&
      request.remoteUrl.trim() !== existing.fetch
    ) {
      refuse('remote-mismatch');
    }
    urls = existing;
  } else {
    if (request.remoteUrl === undefined) refuse('remote-missing');
    newRemoteUrl = request.remoteUrl.trim();
    urls = { fetch: newRemoteUrl, push: [newRemoteUrl] };
  }
  const remote = describeRemote(request.remoteName, urls);
  if (!remote.usable || remote.installSource === undefined) {
    refuse(remote.refusal ?? 'unsupported-transport');
  }

  const { changes, tooMany } = await pendingChanges(
    folder,
    state,
    git,
    options.limits,
  );
  if (tooMany) refuse('too-many-changes');
  const secrets = await findSecrets(folder, changes);
  if (secrets.length > 0) refuse('secrets', { secrets });
  if (
    changes.length === 0 &&
    (state === 'none' || !(await hasCommits(folder, git)))
  ) {
    refuse('nothing-to-publish');
  }

  if (state === 'root' && (await currentBranch(folder, git)) === null) {
    refuse('detached-head');
  }

  // ---- Everything below changes the folder or the remote. ----
  if (state === 'none') {
    await git.run(folder, ['init', '--quiet', '--initial-branch=main']);
  }
  if (newRemoteUrl !== null) {
    await git.run(folder, [
      'remote',
      'add',
      '--',
      request.remoteName,
      newRemoteUrl,
    ]);
  }
  const branch = await currentBranch(folder, git);
  if (branch === null) refuse('detached-head');

  let commit: string | null = null;
  if (changes.length > 0) {
    // Exactly the paths that were checked: a file created after the check
    // is not swept into the commit.
    await git.run(folder, [
      '--literal-pathspecs',
      'add',
      '--all',
      '--',
      ...changes.map((change) => change.path),
    ]);
    await git.run(
      folder,
      ['commit', '--quiet', '-m', message],
      GIT_COMMIT_TIMEOUT_MS,
    );
    commit = (await git.run(folder, ['rev-parse', 'HEAD'])).trim();
  }

  // Checked once more right before the push: the folder is writable by
  // others while this runs, and this is the call that carries credentials.
  const beforePush = await checkRepositoryConfig(folder).catch(
    (): RepositoryConfigRefusal => ({
      code: 'repository-config-refused',
      keys: [],
    }),
  );
  if (beforePush === 'absent') refuse('repository-unreadable');
  if (beforePush !== 'ok') {
    refuse(
      beforePush.code,
      'keys' in beforePush ? { keys: beforePush.keys } : {},
    );
  }
  // Only the push needs credentials; only it gets the operator's helpers.
  const pushGit = gitRunner({
    ...git.options,
    credentialHelpers: await readOperatorCredentialHelpers(),
  });
  await pushGit.run(
    folder,
    [
      'push',
      '--porcelain',
      '--set-upstream',
      '--',
      request.remoteName,
      `refs/heads/${branch}:refs/heads/${branch}`,
    ],
    GIT_PUSH_TIMEOUT_MS,
  );

  const installSource = remote.installSource;
  const withBranch =
    branch === 'main' || branch === 'master'
      ? installSource
      : `${installSource}#${branch}`;
  return {
    plugin,
    commit,
    branch,
    remote: { name: remote.name, url: remote.url },
    installSource: withBranch,
    installSourceDerived: remote.installSourceDerived ?? false,
    installCommand: `station plugin install ${withBranch}`,
  };
}
