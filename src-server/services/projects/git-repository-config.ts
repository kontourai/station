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
 * - Partial clone: `extensions.partialClone`, `remote.<name>.promisor`,
 *   `remote.<name>.partialCloneFilter`. With one of these a missing object
 *   makes ANY read (`diff`, `log`, `status`, `show`) fetch from the
 *   repository's own remote, running its credential helper (measured on git
 *   2.50: the helper ran and the address was connected to). A genuine
 *   partial clone is refused too: Station cannot tell it from a planted one.
 * - Any other `extensions.*` outside `SAFE_EXTENSIONS`: an extension changes
 *   how git reads the repository, and one Station has not looked at is not
 *   assumed harmless.
 * - Programs: `credential.*` (helpers), `core.askPass`, `core.sshCommand`,
 *   `core.gitProxy`, `core.editor`, `sequence.editor`, `core.pager` and a
 *   `pager.<command>` that names a program rather than a boolean,
 *   `core.alternateRefsCommand`, `gpg.*` (`gpg.program`,
 *   `gpg.<format>.program`, `gpg.ssh.defaultKeyCommand`),
 *   `gc.recentObjectsHook`, `uploadpack.*` (`packObjectsHook`),
 *   `remote.<name>.vcs|uploadpack|receivepack|proxy`, and a
 *   `submodule.<name>.update` of the `!command` form.
 * - Addresses and rewrites: `url.<base>.insteadOf|pushInsteadOf`, `http`
 *   proxy and cookie keys (`http.proxy`, `http.<url>.proxy`,
 *   `http.proxy*`, `http.cookieFile`, `http.saveCookies`),
 *   `fetch.bundleURI`.
 *
 * These are the READ refusals, applied by every coding git read. Before the
 * operator's COMMIT or PUSH, which run with the operator's credentials and
 * signing, these are refused as well: `include`/`includeIf` (more
 * configuration from elsewhere), a remote NAMED by an address, and a
 * `core.fsmonitor` that is a program rather than the builtin daemon's
 * boolean.
 *
 * NOT refused, because no command Station runs reaches them: `alias.*` (an
 * alias cannot replace a builtin command, and Station names builtins only),
 * `merge.<name>.driver` and `mergetool.*` (Station's coding routes do not
 * merge), `difftool.*`, `trailer.<token>.command` (only with
 * `commit --trailer`), `sendemail.*`, `imap.*`, `instaweb.*`, `web.browser`,
 * `browser.*`, `man.*`, `gui.*`, `guitool.*`. `remote.<name>.url` itself is
 * what every clone has; a push validates it, and no read connects to it.
 * `core.hooksPath` (husky) and a boolean `core.fsmonitor` are overridden by
 * the runner on every call, and so is `protocol.*` (re-enabling a transport
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

export type RepositoryConfigPurpose = 'read' | 'write';

/**
 * `extensions.*` keys (lowercased) that only describe how the repository's
 * own files are stored. Everything else under `extensions.` is refused.
 */
const SAFE_EXTENSIONS = new Set([
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
  /^remote\..+\.(?:promisor|partialclonefilter)$/,
  /^credential\./,
  /^core\.(?:sshcommand|askpass|gitproxy|alternaterefscommand|editor|pager)$/,
  /^sequence\.editor$/,
  /^gpg\./,
  /^gc\.recentobjectshook$/,
  /^uploadpack\./,
  /^remote\..+\.(?:proxy|vcs|receivepack|uploadpack)$/,
  /^url\..+\.(?:insteadof|pushinsteadof)$/,
  /^http\.(?:.+\.)?(?:proxy[a-z]*|cookiefile|savecookies)$/,
  /^fetch\.bundleuri$/,
];

/** Keys (lowercased) refused before an operator commit or push. */
const WRITE_REFUSED = [
  ...READ_REFUSED,
  /^include\./,
  /^includeif\./,
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
  if (lower.startsWith('extensions.')) return !SAFE_EXTENSIONS.has(lower);
  // `pager.<command>` is a boolean, or the program to page that command with.
  if (lower.startsWith('pager.')) return !BOOLEAN_VALUE.test(value ?? '');
  // `submodule.<name>.update=!command` runs the command.
  if (/^submodule\..+\.update$/.test(lower)) {
    return (value ?? '').trimStart().startsWith('!');
  }
  return (purpose === 'read' ? READ_REFUSED : WRITE_REFUSED).some((rule) =>
    rule.test(lower),
  );
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
 * discovers it from `cwd`.
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
  const keys = new Set<string>();
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const scope = tokens[index];
    if (scope !== 'local' && scope !== 'worktree') continue;
    const record = tokens[index + 1];
    const newline = record.indexOf('\n');
    const key = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? null : record.slice(newline + 1);
    if (refused(key, value, purpose)) keys.add(key);
  }
  return keys.size === 0
    ? { ok: true }
    : { ok: false, code: 'repository-config-refused', keys: [...keys].sort() };
}
