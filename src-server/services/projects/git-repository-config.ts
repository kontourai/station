/**
 * Which of a repository's OWN configuration keys make Station refuse to run
 * git there (#2363).
 *
 * The shared runner (`utils/git-exec.ts`) overrides what it can on the
 * command line: hooks, fsmonitor, pager, editor, ssh command, protocols,
 * credential helpers, lazy fetch, signing. This refusal is the second layer
 * for those, and the only one for what cannot be overridden generically.
 *
 * BASIS OF THE LIST. git's configuration reference (`git help config`, read
 * at git 2.50) was walked for every key whose value is (a) a program git
 * runs, (b) an address git connects to or a rewrite of one, or (c) a switch
 * that makes an ordinary read connect. A key is refused when a command
 * Station runs can reach it:
 *
 * - Chosen per file by `.gitattributes`, under a name the repository picks,
 *   so no fixed `-c` can switch it off: `filter.<name>.*` (clean, smudge,
 *   process), `diff.external`, `diff.<name>.textconv|command`. `git status`
 *   runs a clean filter when it re-hashes a file whose stat data looks racy
 *   (measured on git 2.50: a planted `filter.<name>.clean` ran on the first
 *   `status` after a commit, with the tree otherwise clean); `git diff` runs
 *   it and the diff drivers; `add`/`checkout` run filters by design.
 * - Any `extensions.*` outside `SAFE_EXTENSIONS`: an extension changes
 *   how git reads the repository, and one Station has not looked at is not
 *   assumed harmless.
 * - Programs: `credential.*` (helpers), `core.askPass`, `core.sshCommand`,
 *   `core.gitProxy`, `core.alternateRefsCommand`, `gpg.*` (`gpg.program`,
 *   `gpg.<format>.program`, `gpg.ssh.defaultKeyCommand`),
 *   `gc.recentObjectsHook`, `uploadpack.*` (`packObjectsHook`),
 *   `remote.<name>.vcs|uploadpack|receivepack|proxy`, and a
 *   `submodule.<name>.update` of the `!command` form.
 * - Addresses and rewrites: `url.<base>.insteadOf|pushInsteadOf`, `http`
 *   proxy and cookie keys (`http.proxy`, `http.<url>.proxy`,
 *   `http.proxy*`, `http.cookieFile`, `http.saveCookies`),
 *   `fetch.bundleURI`.
 *
 * - Files read by name: `core.excludesFile`, `core.attributesFile`,
 *   `mailmap.file|blob`, `diff.orderFile`, `blame.ignoreRevsFile`.
 *   `commit.template` is not among them: Station commits with `-m`, which
 *   never reads it.
 *
 * These are the READ refusals, applied wherever git runs with Station's own
 * copy of the configuration, in which includes are already resolved
 * (`git-read-repository.ts`): the coding reads, checkout, checkpoints,
 * worktree provisioning and the review workspace. Before the operator's
 * COMMIT or PUSH, which read the repository's configuration themselves and
 * run with the operator's credentials and signing, these are refused as
 * well: `include`/`includeIf` (more configuration from another file, read
 * when git runs rather than when Station judged this one), every `http.*`
 * key, a remote NAMED by an address, a `core.fsmonitor` that is a program
 * rather than the builtin daemon's boolean, and a PARTIAL CLONE
 * (`extensions.partialClone`, `remote.<name>.promisor`,
 * `remote.<name>.partialCloneFilter`).
 *
 * PARTIAL CLONES. With a promisor remote, a missing object makes any command
 * that touches it fetch from the repository's own remote, running its
 * credential helper (measured on git 2.50: the helper ran and the address
 * was connected to). For a READ that is closed by the runner, not here:
 * every command that is not a network command runs with no transport, no
 * lazy fetch and no credential helper (`utils/git-exec.ts`; measured the
 * same way: no helper, no connection, git fails naming the missing object).
 * So a genuine `--filter=blob:none` clone is read like any other, and a
 * read that needs an object it has not fetched fails. A PUSH is a network
 * command: the runner gives it the operator's helpers and https/ssh, so a
 * lazy fetch during it would reach the promisor remote, an address the push
 * route never validated. Commit and Push therefore refuse a partial clone.
 *
 * NOT refused, because no command Station runs reaches them: `alias.*` (an
 * alias cannot replace a builtin command, and Station names builtins only),
 * `merge.<name>.driver` and `mergetool.*` (Station's coding routes do not
 * merge), `difftool.*`, `trailer.<token>.command` (only with
 * `commit --trailer`), `sendemail.*`, `imap.*`, `instaweb.*`, `web.browser`,
 * `browser.*`, `man.*`, `gui.*`, `guitool.*`. `remote.<name>.url` itself is
 * what every clone has; a push validates it, and no read connects to it.
 * `core.hooksPath` (husky), a boolean `core.fsmonitor`, `core.editor` and
 * `core.pager` are overridden by the runner on every call (a
 * `pager.<command>` or `sequence.editor` only runs on a terminal or in an
 * interactive rebase, neither of which Station has), and so is `protocol.*` (re-enabling a transport
 * such as `ext::`): the runner's `GIT_ALLOW_PROTOCOL` outranks every config
 * file, and `git clone -c protocol.file.allow=always` leaves that key in an
 * ordinary clone.
 *
 * Ordinary repositories pass: a fresh `git init`/`git clone`, a gh-cloned
 * checkout (`remote.origin.gh-resolved`), husky (`core.hooksPath`), VS Code
 * (`branch.*.vscode-merge-base`), `branch.*.pushRemote`/`rebase`, a
 * sha256 or reftable repository, per-worktree config, and the builtin
 * fsmonitor daemon (`core.fsmonitor=true`). Only the repository's own scopes
 * (`local`, `worktree`) are judged, including anything they `include`: the
 * operator's global configuration is the operator's, and applies by design.
 */
import { execGit } from '../../utils/git-exec.js';

/**
 * - `read`: git runs with Station's own copy of this configuration
 *   (`git-read-repository.ts`), in which includes are already resolved.
 * - `write`: the operator's Commit and Push, which read the repository's
 *   configuration themselves.
 */
export type RepositoryConfigPurpose = 'read' | 'write';

/**
 * `extensions.*` keys (lowercased) that only describe how the repository's
 * own files are stored. Everything else under `extensions.` is refused.
 */
const SAFE_EXTENSIONS = new Set([
  // Refused for a commit or push (`WRITE_REFUSED`); see PARTIAL CLONES.
  'extensions.partialclone',
  'extensions.objectformat',
  'extensions.compatobjectformat',
  'extensions.refstorage',
  'extensions.worktreeconfig',
  'extensions.relativeworktrees',
  'extensions.preciousobjects',
  'extensions.noop',
]);

/** Keys (lowercased) refused before any coding git read. See the header. */
const READ_REFUSED = [
  /^filter\./,
  /^diff\.external$/,
  /^diff\..+\.(?:textconv|command)$/,
  /^credential\./,
  /^core\.(?:sshcommand|askpass|gitproxy|alternaterefscommand)$/,
  /^gpg\./,
  /^gc\.recentobjectshook$/,
  /^uploadpack\./,
  /^remote\..+\.(?:proxy|vcs|receivepack|uploadpack)$/,
  /^url\..+\.(?:insteadof|pushinsteadof)$/,
  /^http\.(?:.+\.)?(?:proxy[a-z]*|cookiefile|savecookies)$/,
  /^fetch\.bundleuri$/,
  // A file git reads and acts on by name. Pointed outside the Project (by an
  // absolute path, or through a link) it answers questions about a file the
  // member cannot read: which names its patterns match, which authors it
  // maps. In-tree `.gitignore`, `.gitattributes` and `.mailmap` need none of
  // these keys.
  /^core\.(?:excludesfile|attributesfile)$/,
  /^mailmap\.(?:file|blob)$/,
  /^diff\.orderfile$/,
  /^blame\.ignorerevsfile$/,
];

/** Keys (lowercased) refused before an operator commit or push. */
const WRITE_REFUSED = [
  ...READ_REFUSED,
  // More configuration from another file, read when git runs rather than
  // when Station judged this one.
  /^include\./,
  /^includeif\./,
  /^extensions\.partialclone$/,
  /^remote\..+\.(?:promisor|partialclonefilter)$/,
  // Everything under `http.`: where a push connects, what it trusts and
  // what it sends (`curloptResolve`, `sslVerify`, `sslCAInfo`,
  // `extraHeader`, `proactiveAuth`, …).
  /^http\./,
  // A remote whose NAME is an address (`remote."https://host/x.git".url`):
  // `git push -- <that address>` reads it as that remote, so its
  // `url`/`pushurl` would redirect a push to an address Station validated.
  // Every address Station validates contains `:` (`https://`, `ssh://`,
  // `git@host:`); a nickname may contain `/` (`team/fork`) but never `:`.
  /^remote\.[^\n]*:[^\n]*\.[^.]+$/,
];

const BOOLEAN_VALUE = /^(?:true|false|yes|no|on|off|1|0|)$/i;

function refused(
  key: string,
  value: string | null,
  purpose: RepositoryConfigPurpose,
): boolean {
  const lower = key.toLowerCase();
  // A hook path or command, as opposed to the builtin daemon's boolean.
  if (
    purpose === 'write' &&
    lower === 'core.fsmonitor' &&
    !BOOLEAN_VALUE.test(value ?? '')
  ) {
    return true;
  }
  if (lower.startsWith('extensions.') && !SAFE_EXTENSIONS.has(lower)) {
    return true;
  }
  // `submodule.<name>.update=!command` runs the command.
  if (/^submodule\..+\.update$/.test(lower)) {
    return (value ?? '').trimStart().startsWith('!');
  }
  const rules = purpose === 'read' ? READ_REFUSED : WRITE_REFUSED;
  return rules.some((rule) => rule.test(lower));
}

export type RepositoryConfigVerdict =
  | { ok: true }
  | { ok: false; code: 'repository-config-refused'; keys: string[] }
  | { ok: false; code: 'repository-config-unreadable' };

/**
 * Reads the effective configuration with its scopes (one `git config
 * --show-scope --list`, which follows includes and reports an included
 * key under the scope of the file that included it) and judges the
 * repository's own keys. `gitArgs` locates the repository explicitly
 * (`--git-dir`/`--work-tree`) where the caller knows it; otherwise git
 * discovers it from `cwd`. `env` is the environment of that git call (the
 * coding reads judge the config copy they then run git with).
 */
export async function checkRepositoryConfig(
  cwd: string,
  purpose: RepositoryConfigPurpose,
  gitArgs: readonly string[] = [],
): Promise<RepositoryConfigVerdict> {
  let stdout: string;
  try {
    ({ stdout } = await execGit(
      [...gitArgs, 'config', '--show-scope', '--null', '--list'],
      { cwd, encoding: 'utf-8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch {
    return { ok: false, code: 'repository-config-unreadable' };
  }
  return judgeRepositoryConfig(stdout, purpose);
}

/** One configuration entry, as git lists it. `value` is `null` for a
 * key written with no `=` at all. */
export interface RepositoryConfigEntry {
  scope: string;
  key: string;
  value: string | null;
}

/** Judges entries of the repository's own scopes (`local`, `worktree`). */
export function judgeRepositoryConfigEntries(
  entries: readonly RepositoryConfigEntry[],
  purpose: RepositoryConfigPurpose,
): RepositoryConfigVerdict {
  const keys = new Set<string>();
  for (const { scope, key, value } of entries) {
    if (scope !== 'local' && scope !== 'worktree') continue;
    if (refused(key, value, purpose)) keys.add(key);
  }
  return keys.size === 0
    ? { ok: true }
    : { ok: false, code: 'repository-config-refused', keys: [...keys].sort() };
}

/**
 * Judges the output of `git config --show-scope --null --list` taken in the
 * repository. Separate from {@link checkRepositoryConfig} so a caller that
 * runs git through its own injectable runner (worktree provisioning) applies
 * the same rules to the same bytes rather than a second copy of them.
 */
export function judgeRepositoryConfig(
  stdout: string,
  purpose: RepositoryConfigPurpose,
): RepositoryConfigVerdict {
  const tokens = stdout.split('\0');
  const entries: RepositoryConfigEntry[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const record = tokens[index + 1];
    const newline = record.indexOf('\n');
    entries.push({
      scope: tokens[index],
      key: newline === -1 ? record : record.slice(0, newline),
      value: newline === -1 ? null : record.slice(newline + 1),
    });
  }
  return judgeRepositoryConfigEntries(entries, purpose);
}
