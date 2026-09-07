/**
 * Plugin content integrity (archive#3677, review HIGH 1).
 *
 * Two primitives every authority-bearing consumer of plugin content shares:
 *
 * 1. {@link computePluginContentDigest} — a SHA-256 over the plugin's entire
 *    on-disk tree. A consent fingerprint built from a manifest projection
 *    (name/displayName/version/permissions) does not cover what actually
 *    EXECUTES: `serverModule`, its imports, providers, agents — all of which
 *    the ordinary update route can replace via `git pull` without changing
 *    the manifest's identity fields or even its version. The digest makes
 *    any byte change to the installed tree change the fingerprint, so a
 *    consent granted is a consent to exactly the reviewed bytes.
 *
 *    What this HONESTLY cannot cover: code the plugin fetches or generates
 *    AT RUNTIME after being granted, native binaries it invokes from outside
 *    its own tree, and any mutation made AFTER the grant commits. It attests
 *    that the tree at decision time is byte-identical to the tree at request
 *    time — nothing more. Post-grant integrity remains the update flow's
 *    re-consent problem, not this digest's.
 *
 * 2. {@link withPluginContentLock} — a per-plugin async mutex spanning the
 *    consent decision's revalidate → grant-commit window AND the routes that
 *    mutate plugin content (update, uninstall). Even a perfect fingerprint
 *    leaves a race between "revalidated unchanged" and "grant committed";
 *    holding this lock across both closes it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * SHA-256 over every file in the plugin's installed tree, in sorted path
 * order, with path/kind/content folded into the stream NUL-separated so
 * content cannot shift between files undetected. Symlinks contribute their
 * TARGET STRING (never followed — a link out of the tree must not pull
 * foreign content into the digest, and following it could loop).
 *
 * The plugin's own root `.git` directory is excluded: it is VCS metadata the
 * update route legitimately touches (`git pull` rewrites refs even when the
 * tree is unchanged) and is not part of what executes. `.git`-named entries
 * deeper in the tree ARE digested — nothing stops a manifest pointing
 * `serverModule` into one.
 *
 * Returns null when the tree cannot be read (absent plugin, unreadable file,
 * or an entry that is neither file, directory, nor symlink) — a target whose
 * content cannot be derived must refuse, never grant on a partial digest.
 */
export function computePluginContentDigest(
  pluginsDir: string,
  pluginName: string,
): string | null {
  const root = join(pluginsDir, pluginName);
  const hash = createHash('sha256');
  const walk = (dir: string, relative: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (relative === '' && entry.name === '.git') continue;
      const absolute = join(dir, entry.name);
      const entryRelative =
        relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        hash.update(entryRelative);
        hash.update('\0symlink\0');
        hash.update(readlinkSync(absolute));
        hash.update('\0');
      } else if (entry.isDirectory()) {
        walk(absolute, entryRelative);
      } else if (entry.isFile()) {
        hash.update(entryRelative);
        hash.update('\0file\0');
        hash.update(readFileSync(absolute));
        hash.update('\0');
      } else {
        throw new Error(`Unsupported entry in plugin tree: ${entryRelative}`);
      }
    }
  };
  try {
    walk(root, '');
  } catch {
    return null;
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * `cpSync` options for backing up and restoring a plugin tree.
 *
 * `verbatimSymlinks` defaults to FALSE, which means `cpSync` RESOLVES a
 * relative symlink and writes an absolute target into the copy. That is fatal
 * here in two ways (archive#4288, review MEDIUM 2):
 *
 * 1. {@link computePluginContentDigest} hashes `readlinkSync` output
 *    verbatim, so a backup → restore round trip of a tree containing any
 *    relative symlink produces a DIFFERENT digest from the tree it restored.
 *    A failed update then reads `changed` and withholds every permission —
 *    precisely the "a failed update silently strips a plugin" outcome the
 *    rollback exists to prevent. `node_modules/.bin/*` shims are relative
 *    symlinks and `ensurePluginDeps` creates them, so this is the ordinary
 *    case for any plugin with dependencies, not an exotic one.
 * 2. The rewritten absolute targets point INTO the backup directory, which
 *    the rollback's `finally` deletes — so the restored tree's `.bin` links
 *    dangle. That half is a pre-existing bug the same option closes.
 *
 * Use it for every copy whose two ends must be byte-identical trees.
 */
export const PLUGIN_TREE_COPY = {
  recursive: true,
  verbatimSymlinks: true,
} as const;

/**
 * Memoized {@link computePluginContentDigest}, keyed by the resolved plugin
 * directory (archive#4288).
 *
 * Why a memo exists at all: binding grants to content means the *enforcement*
 * predicates read a digest, and those run per request on the plugin server
 * proxy and per dispatch on the operational-event subscription path. Measured
 * on this repo's own tree, a modest installed plugin (836 files / 13.9 MB —
 * a starter plus `react`, `react-dom`, `zod`, `dompurify`) costs ~35 ms warm
 * and ~107 ms cold per digest. That is fine once per mutation and absurd once
 * per request.
 *
 * What invalidates it: every Station-mediated mutation of a plugin's tree runs
 * inside {@link withPluginContentLock}, which forgets the entry on release.
 * That is a checked list, not an aspiration — review HIGH 3 found two
 * mutators outside it and both are now inside: `installPluginFromSource`
 * (which is a first-class install-OVER-EXISTING path, not only a first
 * install) and `installPluginDependency`'s rebuild of an ALREADY-INSTALLED
 * dependency, which runs `npm install` and an esbuild write inside that other
 * plugin's live directory. The full list is: install, update, uninstall, the
 * dependency rebuild, the home-role and host-approval consent decisions'
 * revalidate → commit spans. {@link refreshPluginContentDigest} additionally
 * forces a recompute wherever a digest is about to be RECORDED against a
 * grant, so no write can pin a stale value even if a mutator is missed.
 *
 * What it honestly does not cover, stated because a cache that goes stale in
 * the fail-open direction is exactly the defect this whole mechanism exists to
 * close: a tree mutated OUT OF BAND — an operator running `git pull` inside
 * `<home>/plugins/<name>` by hand, or another process writing there — keeps
 * serving the memoized digest until the next Station-mediated mutation or a
 * server restart. That is a narrower window than the one being fixed (Station's
 * own update route laundering consent), and it is the same boundary
 * `plugin-public-server.ts` already lives with when it caches loaded server
 * modules; it is not a claim that post-grant tampering is detected in real time.
 */
const contentDigests = new Map<string, string | null>();

/** Memoized read. See the note above for the staleness boundary. */
export function pluginContentDigest(
  pluginsDir: string,
  pluginName: string,
): string | null {
  const key = join(pluginsDir, pluginName);
  if (contentDigests.has(key)) return contentDigests.get(key) ?? null;
  const digest = computePluginContentDigest(pluginsDir, pluginName);
  contentDigests.set(key, digest);
  return digest;
}

/**
 * Recomputes and re-memoizes. Every path that RECORDS a digest against a grant
 * uses this rather than {@link pluginContentDigest}: a grant must be bound to
 * the bytes on disk right now, never to a value cached before the install or
 * build that produced them.
 */
export function refreshPluginContentDigest(
  pluginsDir: string,
  pluginName: string,
): string | null {
  const key = join(pluginsDir, pluginName);
  const digest = computePluginContentDigest(pluginsDir, pluginName);
  contentDigests.set(key, digest);
  return digest;
}

/** Drops the memoized digest for one plugin. */
export function forgetPluginContentDigest(
  pluginsDir: string,
  pluginName: string,
): void {
  contentDigests.delete(join(pluginsDir, pluginName));
}

interface PluginContentLockState {
  tail: Promise<void>;
  holders: number;
  /**
   * The token of whoever currently holds the lock, or undefined between
   * holders. Identity comparison against this is what makes re-entrancy mean
   * "I still hold it" rather than "my ancestry once did".
   */
  holder?: symbol;
}

const contentLocks = new Map<string, PluginContentLockState>();

/**
 * The lock keys the CURRENT async context holds, each with the token of the
 * acquire that took it.
 *
 * The lock is a plain FIFO mutex, so a second acquire of the same key from
 * inside the span that holds it can never be satisfied — the tail only
 * advances when the outer holder releases, and the outer holder is waiting on
 * the inner acquire. That is reachable through real inputs: installing plugin
 * A takes A's lock and then installs A's declared dependencies, and
 * `installPluginDependency` takes the dependency's own lock to rebuild it in
 * place. A manifest naming itself as a dependency, or a dependency cycle that
 * comes back round to A, is a self-acquire.
 *
 * So a re-acquire of a key this context already holds runs `fn` inline. It is
 * already inside the mutually-excluded span; the outer release is what
 * forgets the memoized digest, and one release for the whole nested span is
 * exactly right, because the whole nested span is one mutation window.
 *
 * Each acquire stores a COPY carrying its own token, and re-entrancy compares
 * that token against the lock's live `holder`. Both halves matter, and an
 * earlier round got this wrong in an instructive way:
 *
 * - A token, not mere membership, because populating the map at acquire and
 *   never clearing it would make the predicate mean "my async ancestry once
 *   held this key". A task created inside the span but still running after
 *   the release would take the re-entrant branch and mutate the tree holding
 *   NO lock at all.
 * - A COPY, not a shared mutable set, because sharing one makes a sibling
 *   task in the same span read keys its sibling holds and take the re-entrant
 *   fast path — two bodies mutating one tree with the mutex believing it is
 *   held once. Sharing also made the wait-for edges asymmetric: a descendant
 *   parked on `await previous` inserted edges from the live set and removed
 *   them from the same set after the outer release had emptied it, leaking an
 *   edge for the life of the process and refusing innocent callers forever.
 *
 * Copying gives sibling isolation and a stable membership snapshot; the token
 * gives liveness. Neither alone is sufficient (archive#4288, delta reviews).
 */
const heldLockKeys = new AsyncLocalStorage<ReadonlyMap<string, symbol>>();

/**
 * Starts response-independent work without inheriting re-entrant content-lock
 * authority. The work must still acquire the ordinary mutex for its effects.
 * A caller with a live content guard must not await this work while keeping
 * that guard: the independent acquire may be queued behind the caller itself.
 */
export function startIndependentPluginContentWork<T>(start: () => Promise<T>): {
  work: Promise<T>;
  callerOwnsContentLock: boolean;
} {
  const held = heldLockKeys.getStore();
  const callerOwnsContentLock = held
    ? [...held].some(([key, token]) => contentLocks.get(key)?.holder === token)
    : false;
  return { work: heldLockKeys.exit(start), callerOwnsContentLock };
}

/**
 * The wait-for graph: `waitingFor.get(h)` is the set of keys the holder of `h`
 * is currently blocked on. Edges exist only between a key's acquire request
 * and its grant, and only a lock's single holder can add one, so an edge
 * `h → k` is unambiguous.
 *
 * Why it exists (archive#4288, delta review MEDIUM 3): `buildDependencyIfNeeded`
 * takes a dependency's lock from INSIDE the installing plugin's lock, so one
 * context can hold two keys. Two concurrent installs of mutually dependent
 * plugins (P depends on Q, Q depends on P) then take them in opposite orders
 * and wait on each other forever — AB-BA, and re-entrancy cannot help because
 * they are sibling contexts, not nested ones. The mutex has no timeout, so
 * both keys stay held for the life of the process and every later consent
 * decision, update and uninstall for either plugin hangs too.
 */
const waitingFor = new Map<string, Set<string>>();

/**
 * A lock acquisition would have closed a cycle in the wait-for graph.
 *
 * Detection rather than a timeout, deliberately. A bounded wait converts the
 * hang into a failure but has to pick a duration, and any duration long enough
 * not to kill a legitimate slow install (`ensurePluginDeps` runs `npm install`)
 * is long enough to be indistinguishable from a hang. Detection fires
 * immediately, only in the genuinely cyclic case, and never fails a caller
 * that was merely waiting behind slow work.
 *
 * Acquiring in sorted key order — the other standard prevention — is not
 * available here: the keys a dependency install will need are not knowable
 * when the first is taken, because transitive dependencies are only
 * discoverable after the plugin ahead of them has been fetched and read
 * (`installPluginDependency` recurses into `depManifest.dependencies` after
 * `fetchPluginSource`). Ordering a partially-known set does not prevent the
 * cycle, it only moves it.
 */
export class PluginContentLockCycleError extends Error {
  readonly cycle: readonly string[];

  /**
   * The DISTINCT plugin names in `cycle`, in the order the loop visits them.
   *
   * Derived here because this module owns the key format
   * (`join(pluginsDir, pluginName)`); a route re-deriving names with its own
   * `basename` is the second reader of an encoding that eventually gets it
   * wrong. `cycle` repeats its first key last to render the loop, so the
   * names are de-duplicated — two plugins in a two-key cycle, not three.
   */
  readonly plugins: readonly string[];

  constructor(cycle: readonly string[]) {
    super(
      `Plugin content lock cycle: ${cycle.join(' -> ')}. Two plugin operations are each holding a lock the other needs; neither can proceed. Install or update these plugins one at a time.`,
    );
    this.name = 'PluginContentLockCycleError';
    this.cycle = [...cycle];
    this.plugins = [...new Set(cycle.map((key) => basename(key)))];
  }
}

/**
 * Finds a {@link PluginContentLockCycleError} anywhere in `error`'s wrapping
 * chain, or null.
 *
 * The refusal is raised deep inside an install and every layer above it
 * rewraps: `installPluginDependency` reports failures as a RESULT rather than
 * an exception and carries the original as `cause`, the install loop wraps
 * that in an `Error`, and a rollback that also fails wraps THAT in an
 * `AggregateError`. An `instanceof` at the route therefore sees a plain
 * `Error` and answers 500 with the sentence embedded, which is how a typed
 * error with a `cycle` field ends up being something no handler can act on
 * (archive#4309 follow-up). One walker, so every route that can observe the
 * refusal classifies it the same way.
 */
export function findPluginContentLockCycleError(
  error: unknown,
): PluginContentLockCycleError | null {
  const seen = new Set<object>();
  const pending: unknown[] = [error];
  // Breadth-first, and `shift` rather than `pop`, so the nearest wrapper wins.
  // An `AggregateError` from a failed install whose ROLLBACK also failed holds
  // both failures; a stack would search the rollback's chain first and answer
  // for whichever one happened to be pushed last (archive#4309 follow-up
  // review, LOW). Which one is found decides the status code a request gets,
  // so the order is chosen rather than incidental.
  while (pending.length > 0) {
    const current = pending.shift();
    if (current instanceof PluginContentLockCycleError) return current;
    if (current === null || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current instanceof AggregateError) pending.push(...current.errors);
    if ('cause' in current) pending.push((current as { cause: unknown }).cause);
  }
  return null;
}

/**
 * The operator-facing sentence for a refused acquisition, naming the plugins
 * whose operations are waiting on each other. Shared so the install routes
 * that can both observe the refusal cannot describe it differently.
 *
 * It says what the lock layer KNOWS — which plugins are waiting on each other,
 * and that the acquisition was refused rather than allowed to deadlock — and
 * nothing about what the request that hit it had already done. It used to end
 * "Nothing was changed", which nothing computes and which is false whenever
 * the refusal lands partway through a dependency list: the dependencies
 * installed ahead of it were installed and then rolled back, which is changed
 * and reverted, not unchanged (archive#4309 follow-up review, HIGH 1).
 */
export function pluginContentLockCycleMessage(
  error: PluginContentLockCycleError,
): string {
  const names = error.plugins;
  // Two plugins wait on "the other"; three or more each wait on "another" —
  // rendering a three-name list beside "the other" names a pair that is not
  // there (archive#4309 follow-up review, LOW).
  const list =
    names.length <= 1
      ? (names[0] ?? 'this plugin')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const holder = names.length === 2 ? 'the other' : 'another';
  return `Plugin operations for ${list} are each waiting for a content lock ${holder} holds, so this request was refused instead of hanging. Install or update these plugins one at a time.`;
}

/**
 * Walks the wait-for graph forward from `requested`. Returns the path back to
 * one of `heldKeys` when the holder of `requested` is (transitively) waiting
 * for something this context already holds — i.e. when waiting would deadlock
 * — and null otherwise. The check and the edge insertion in
 * {@link withPluginContentLock} run with no `await` between them, so no other
 * context can interleave and make the answer stale.
 */
function findLockCycle(
  heldKeys: ReadonlySet<string>,
  requested: string,
): string[] | null {
  const seen = new Set<string>();
  const stack: Array<{ key: string; path: string[] }> = [
    { key: requested, path: [requested] },
  ];
  while (stack.length > 0) {
    const { key, path } = stack.pop() as { key: string; path: string[] };
    if (heldKeys.has(key)) return path;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const next of waitingFor.get(key) ?? []) {
      stack.push({ key: next, path: [...path, next] });
    }
  }
  return null;
}

/**
 * Runs `fn` while holding the per-plugin content mutation lock. FIFO, keyed
 * by the resolved plugin directory, and re-entrant within one async context
 * (see {@link heldLockKeys}). Both sides of the review-HIGH-1 race take it:
 * the consent decision (revalidate → grant commit, via the store's
 * `guardDecision`) and every route that mutates the plugin's tree.
 *
 * Throws {@link PluginContentLockCycleError} instead of waiting when this
 * context already holds a key whose acquisition would close a cycle — see
 * {@link waitingFor}. Nothing has been mutated at that point, so the caller's
 * ordinary failure path (the install's rollback) applies unchanged.
 */
export async function withPluginContentLock<T>(
  pluginsDir: string,
  pluginName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = join(pluginsDir, pluginName);
  const held = heldLockKeys.getStore();
  // Re-entrant only while this context is STILL the live holder. Membership
  // alone would also admit a task that outlived the release.
  if (
    held?.get(key) !== undefined &&
    contentLocks.get(key)?.holder === held.get(key)
  )
    return await fn();
  // The keys this context still holds, as a stable array. Filtering by live
  // holder is what keeps the wait-for graph honest: an edge from a key we
  // have since released is the leak that refuses innocent callers forever,
  // and inserting and removing over the same array makes the two loops
  // symmetric by construction rather than by timing.
  const waitKeys = held
    ? [...held.keys()].filter(
        (heldKey) => contentLocks.get(heldKey)?.holder === held.get(heldKey),
      )
    : [];
  // Everything from here to `await previous` is synchronous on purpose: the
  // cycle check, the edge insertion and the queue join must be one indivisible
  // step, or two contexts could each decide "no cycle" and then create one.
  const holding = new Set(waitKeys);
  if (holding.size > 0) {
    const path = findLockCycle(holding, key);
    if (path !== null) {
      // `path` runs from the key being requested to the key of ours its
      // holder is (transitively) waiting for, so naming that key first
      // renders the whole loop: h -> requested -> … -> h.
      throw new PluginContentLockCycleError([path[path.length - 1], ...path]);
    }
  }
  let state = contentLocks.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), holders: 0 };
    contentLocks.set(key, state);
  }
  state.holders += 1;
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const heldKey of waitKeys) {
    const edges = waitingFor.get(heldKey);
    if (edges) edges.add(key);
    else waitingFor.set(heldKey, new Set([key]));
  }
  try {
    await previous;
  } finally {
    for (const heldKey of waitKeys) {
      const edges = waitingFor.get(heldKey);
      edges?.delete(key);
      if (edges?.size === 0) waitingFor.delete(heldKey);
    }
  }
  const token = Symbol(key);
  state.holder = token;
  const nested = new Map(held ?? []);
  nested.set(key, token);
  try {
    return await heldLockKeys.run(nested, fn);
  } finally {
    state.holder = undefined;
    // Every Station-mediated tree mutation runs in here, so releasing the
    // lock is the one moment at which a memoized digest is known to be
    // suspect. Forgetting unconditionally (the consent decision's guarded
    // span mutates nothing) costs one recompute and cannot go stale.
    forgetPluginContentDigest(pluginsDir, pluginName);
    release();
    state.holders -= 1;
    if (state.holders === 0) contentLocks.delete(key);
  }
}
