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
      readonly trackedChanges: boolean;
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

/**
 * Git: the commit `HEAD` names, whether any TRACKED file differs from it
 * (staged or not), and how many untracked files exist. Read through the
 * repository-read owner, which runs git against a judged copy of the
 * repository's config and refuses repository-defined programs (filters,
 * fsmonitor) instead of running them.
 */
export const gitCommitAdapter: ExecutionPreparationAdapter = {
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
      trackedChanges: boolean;
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
          return {
            version: head.stdout.trim().toLowerCase(),
            trackedChanges: tracked.stdout.length > 0,
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
  const observation = await adapter.observe({
    root: input.checkoutRoot,
    cwd: input.cwd,
  });
  if (observation.state !== 'readable')
    throw refuse('execution_preparation_unavailable');
  if (observation.trackedChanges)
    throw refuse('execution_preparation_tracked_changes');
  if (
    !adapter.isWellFormed(requested.value) ||
    observation.version !== requested.value
  )
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
