import { realpath } from 'node:fs/promises';
import {
  EXECUTION_PREPARATION_PROTOCOL,
  type ExecutionPreparationReceipt,
  type ExecutionPreparationRequirement,
} from '@kontourai/station-contracts/execution-preparation';
import type { ProjectRepoResource } from '@kontourai/station-contracts/project-identity';
import { execGit } from '../../utils/git-exec.js';
import {
  type ProjectRepositoryRead,
  readProjectRepository,
} from '../projects/git-read-repository.js';
import {
  RECEIVER_EXECUTION_REFUSAL_COPY,
  ReceiverExecutionRefusal,
} from '../projects/project-contribution-service.js';

/**
 * #2875 slice 1: the receiver-side check behind a `project-portable-prepared`
 * workspace — "is my admitted checkout at the version the caller named?".
 *
 * The check observes; it never prepares. It runs no setup, writes nothing
 * into the checkout, and transfers nothing. Its only claim is that the
 * version matched WHEN CHECKED: a local writer can change the checkout
 * afterwards, and the receipt says so (docs/design/remote-execution-preparation.md,
 * "Race disclosure").
 *
 * Adapters are a CLOSED in-process registry keyed by portable resource kind.
 * Nothing in a request or in configuration can add one: an unknown kind is a
 * typed refusal, not a lookup miss to fall through.
 */

const SUPPORTED_MODE = 'existing-realization';
/** Known and deferred: refused by its own name, not as an unknown mode. */
const REMOTE_REFERENCE_MODE = 'remote-reference';
const SUPPORTED_GUARANTEE = 'version-matched-when-checked';
/** Known, deliberately refused by name: nothing can fence writers yet (#484). */
const PROTECTION_GUARANTEE = 'protected-during-execution';
const GIT_OBSERVE_TIMEOUT_MS = 10_000;
/** Bounds the untracked listing; a larger listing reads as unavailable. */
const UNTRACKED_LISTING_MAX_BYTES = 16 * 1024 * 1024;

/** What an adapter read from the checkout. Never a path or a file name. */
type CheckoutObservation =
  | {
      readonly state: 'readable';
      readonly version: string;
      /**
       * `changed`: a tracked file or a submodule commit differs from HEAD.
       * `unverifiable`: the index marks entries assume-unchanged or
       * skip-worktree, so git would not report their changes at all.
       */
      readonly tracked: 'clean' | 'changed' | 'unverifiable';
      readonly untrackedFiles: number;
    }
  | { readonly state: 'unavailable' };

interface ExecutionPreparationAdapter {
  /** The one version scheme this adapter can observe. */
  readonly scheme: string;
  /** Whether `value` is a version this scheme could ever observe. */
  readonly isWellFormed: (value: string) => boolean;
  readonly observe: (checkout: {
    /** The admitted resource's bound checkout (the member-writable root). */
    readonly root: string;
    /** The directory the Agent will start in, inside `root`. */
    readonly cwd: string;
  }) => Promise<CheckoutObservation>;
}

/** `HEAD`'s gitlinks or the index's: path → recorded submodule commit. */
function gitlinks(listing: string, pattern: RegExp): Map<string, string> {
  const links = new Map<string, string>();
  for (const entry of listing.split('\0')) {
    const match = pattern.exec(entry);
    if (match) links.set(match[2]!, match[1]!);
  }
  return links;
}

function sameGitlinks(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [path, commit] of left)
    if (right.get(path) !== commit) return false;
  return true;
}

/**
 * Git: the commit `HEAD` names, whether any TRACKED file differs from it
 * (staged or not), and how many untracked files exist. Read through the
 * repository-read owner, which runs git against a judged copy of the
 * repository's config and refuses repository-defined programs (filters,
 * fsmonitor) instead of running them.
 *
 * `status` alone is not enough: the hardened runner forces
 * `--ignore-submodules=all` onto it (utils/git-exec.ts, so no nested
 * repository's config is ever run), and git never reports an entry marked
 * assume-unchanged or skip-worktree. So the adapter also
 * - refuses as unverifiable when `ls-files -v` shows either index flag;
 * - compares the index's gitlinks with HEAD's (staged submodule drift);
 * - asks `ls-files --modified`, which compares a populated submodule's
 *   checked-out commit in-process, without running git inside it
 *   (unstaged submodule drift). Neither verb is rewritten by the runner,
 *   and neither runs a program.
 */
const gitCommitAdapter: ExecutionPreparationAdapter = {
  scheme: 'git-commit',
  // Full object ids only (SHA-1 or SHA-256). An abbreviation is never
  // resolved: it could name a different commit on the receiver.
  isWellFormed: (value) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value),
  observe: async (checkout) => {
    // The repository-read owner compares symlink-resolved paths.
    let root: string;
    let cwd: string;
    try {
      root = await realpath(checkout.root);
      cwd = await realpath(checkout.cwd);
    } catch {
      return { state: 'unavailable' };
    }
    let outcome: ProjectRepositoryRead<{
      version: string;
      tracked: 'clean' | 'changed' | 'unverifiable';
      untrackedFiles: number;
    }>;
    try {
      outcome = await readProjectRepository(
        root,
        cwd,
        { timeoutMs: GIT_OBSERVE_TIMEOUT_MS },
        async (repository) => {
          const git = (args: string[]) =>
            execGit([...repository.repoArgs, ...args], {
              cwd: repository.top,
              encoding: 'utf-8',
              windowsHide: true,
              timeout: GIT_OBSERVE_TIMEOUT_MS,
              maxBuffer: UNTRACKED_LISTING_MAX_BYTES,
            });
          const head = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
          const tracked = await git([
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=no',
          ]);
          const untracked = await git([
            'ls-files',
            '--others',
            '--exclude-standard',
            '-z',
          ]);
          const flagged = await git(['ls-files', '-v', '-z']);
          const modified = await git(['ls-files', '--modified', '-z']);
          const indexed = await git(['ls-files', '--stage', '-z']);
          const committed = await git(['ls-tree', '-r', '-z', 'HEAD']);
          // `ls-files -v` tags assume-unchanged entries in lowercase and
          // skip-worktree entries `S`.
          const unverifiable = flagged.stdout
            .split('\0')
            .some((entry) => /^(?:[a-z]|S) /.test(entry));
          const submoduleDrift = !sameGitlinks(
            gitlinks(indexed.stdout, /^160000 ([0-9a-f]+) \d\t([\s\S]+)$/),
            gitlinks(
              committed.stdout,
              /^160000 commit ([0-9a-f]+)\t([\s\S]+)$/,
            ),
          );
          return {
            version: head.stdout.trim().toLowerCase(),
            tracked: unverifiable
              ? ('unverifiable' as const)
              : tracked.stdout.length > 0 ||
                  modified.stdout.length > 0 ||
                  submoduleDrift
                ? ('changed' as const)
                : ('clean' as const),
            untrackedFiles: untracked.stdout
              .split('\0')
              .filter((entry) => entry.length > 0).length,
          };
        },
      );
    } catch {
      return { state: 'unavailable' };
    }
    if (!outcome.ok) return { state: 'unavailable' };
    return { state: 'readable', ...outcome.value };
  },
};

const ADAPTERS_BY_RESOURCE_KIND: ReadonlyMap<
  string,
  ExecutionPreparationAdapter
> = new Map<ProjectRepoResource['kind'], ExecutionPreparationAdapter>([
  ['git', gitCommitAdapter],
]);

function refuse(
  code: Extract<
    ReceiverExecutionRefusal['code'],
    `execution_preparation_${string}`
  >,
): ReceiverExecutionRefusal {
  return new ReceiverExecutionRefusal(
    code,
    RECEIVER_EXECUTION_REFUSAL_COPY[code],
  );
}

/**
 * The checks that need no admission and no repository read: protocol,
 * mode and guarantees. Run before admission so an unsupported requirement
 * refuses without touching the receiver's offer or checkout.
 */
export function assertPreparationRequirementSupported(
  requirement: ExecutionPreparationRequirement,
): void {
  if (requirement.protocol !== EXECUTION_PREPARATION_PROTOCOL)
    throw refuse('execution_preparation_unsupported');
  if (requirement.mode === REMOTE_REFERENCE_MODE)
    throw refuse('execution_preparation_remote_reference_unsupported');
  if (requirement.mode !== SUPPORTED_MODE)
    throw refuse('execution_preparation_mode_unsupported');
  if (requirement.guarantees.includes(PROTECTION_GUARANTEE))
    throw refuse('execution_preparation_protection_unavailable');
  if (
    requirement.guarantees.length === 0 ||
    requirement.guarantees.some(
      (guarantee) => guarantee !== SUPPORTED_GUARANTEE,
    )
  )
    throw refuse('execution_preparation_guarantee_unsupported');
}

/**
 * Observe the admitted checkout and return the receipt, or refuse. The
 * caller has already run {@link assertPreparationRequirementSupported} and
 * admitted the resource; `resourceKind` and the paths come from that
 * receiver-owned admission, never from the request.
 */
export async function verifyPreparedCheckout(input: {
  readonly requirement: ExecutionPreparationRequirement;
  readonly resourceId: string;
  readonly resourceKind: string | undefined;
  readonly checkoutRoot: string;
  readonly cwd: string;
}): Promise<ExecutionPreparationReceipt> {
  const adapter =
    input.resourceKind === undefined
      ? undefined
      : ADAPTERS_BY_RESOURCE_KIND.get(input.resourceKind);
  if (!adapter) throw refuse('execution_preparation_kind_unsupported');
  const requested = input.requirement.version;
  if (requested.scheme !== adapter.scheme)
    throw refuse('execution_preparation_scheme_unsupported');
  // Before any read: a value this scheme could never observe refuses
  // without the caller learning anything about the checkout's state.
  if (!adapter.isWellFormed(requested.value))
    throw refuse('execution_preparation_version_mismatch');
  const observation = await adapter.observe({
    root: input.checkoutRoot,
    cwd: input.cwd,
  });
  if (observation.state !== 'readable')
    throw refuse('execution_preparation_unavailable');
  if (observation.tracked === 'unverifiable')
    throw refuse('execution_preparation_tracked_state_unverifiable');
  if (observation.tracked === 'changed')
    throw refuse('execution_preparation_tracked_changes');
  if (observation.version !== requested.value)
    throw refuse('execution_preparation_version_mismatch');
  return {
    protocol: EXECUTION_PREPARATION_PROTOCOL,
    mode: SUPPORTED_MODE,
    resourceId: input.resourceId,
    requested: { scheme: requested.scheme, value: requested.value },
    observed: { scheme: adapter.scheme, value: observation.version },
    guarantee: SUPPORTED_GUARANTEE,
    checkedAt: new Date().toISOString(),
    trackedChanges: 'none',
    untrackedFiles: observation.untrackedFiles,
    setup: 'not-performed',
  };
}
