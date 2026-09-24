/**
 * Which of a repository's OWN configuration keys make Station refuse to run
 * git there (#2363).
 *
 * The shared runner (`utils/git-exec.ts`) overrides what it can on the
 * command line: fsmonitor, pager, editor, ssh command, protocols, credential
 * helpers, signing. Two kinds of setting cannot be overridden generically,
 * so a repository that sets one is refused instead:
 *
 * - A clean/smudge FILTER or a DIFF DRIVER is chosen per file by
 *   `.gitattributes`, under a name the repository picks, so no fixed `-c`
 *   can switch it off. `git status` runs a clean filter when it re-hashes a
 *   file whose stat data looks racy (measured on git 2.50: a planted
 *   `filter.<name>.clean` ran on the first `status` after a commit, with the
 *   tree otherwise clean), `git diff` runs it and `diff.external`, and
 *   `add`/`checkout` run filters by design. These are the READ refusals,
 *   applied wherever the coding routes run one of those commands.
 * - A key that redirects where a push goes or what runs during one
 *   (`url.*.insteadOf`, `remote.*.receivepack`, a remote NAMED by an
 *   address, a proxy command, `include` of more configuration, …). These
 *   are refused, together with the read
 *   refusals, before the operator's COMMIT or PUSH, which run with the
 *   operator's credentials and signing.
 *
 * Ordinary repositories pass: a fresh `git init`/`git clone`, a gh-cloned
 * checkout (`remote.origin.gh-resolved`), husky (`core.hooksPath`), VS Code
 * (`branch.*.vscode-merge-base`), `branch.*.pushRemote`/`rebase`, and the
 * builtin fsmonitor daemon (`core.fsmonitor=true`, a boolean, which the
 * runner overrides anyway). Only the repository's own scopes (`local`,
 * `worktree`) are judged, including anything they `include`: the
 * operator's global configuration is the operator's, and applies by design.
 */
import { execGit } from '../../utils/git-exec.js';

export type RepositoryConfigPurpose = 'read' | 'write';

/** Keys (lowercased) that run a program on status, diff, add or checkout. */
const READ_REFUSED = [
  /^filter\./,
  /^diff\.external$/,
  /^diff\..+\.(?:textconv|command)$/,
];

/** Keys (lowercased) refused before an operator commit or push. */
const WRITE_REFUSED = [
  ...READ_REFUSED,
  /^include\./,
  /^includeif\./,
  /^url\..+\.(?:insteadof|pushinsteadof)$/,
  /^credential\./,
  /^core\.(?:sshcommand|askpass|gitproxy|alternaterefscommand)$/,
  /^http\.(?:.+\.)?proxy$/,
  /^remote\..+\.(?:proxy|vcs|receivepack|uploadpack)$/,
  // A remote whose NAME is an address (`remote."https://host/x.git".url`):
  // `git push -- <that address>` reads it as that remote, so its
  // `url`/`pushurl` would redirect a push to an address Station validated.
  // Every address Station validates contains `:` (`https://`, `ssh://`,
  // `git@host:`); a nickname may contain `/` (`team/fork`) but never `:`.
  /^remote\.[^\n]*:[^\n]*\.[^.]+$/,
  /^gpg\./,
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
