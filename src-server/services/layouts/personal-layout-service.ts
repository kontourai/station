/**
 * The personal scope's server-side store (#2061; design decision D1 in
 * `docs/design/shell-ownership-and-boards.md`).
 *
 * A **Board** is a Layout owned by a principal. Before this, "personal" in
 * Station meant either instance-wide — which only works on a single-operator
 * instance — or device-local, which does not follow a person to their phone.
 * These records live under the Station home, keyed by principal, so the same
 * person sees the same Boards from every device they are authenticated on.
 *
 * ## Why a service and not a generic `PersonalScopeStore`
 *
 * The generic shape would be one key-value store keyed by principal with
 * "layouts" as its first artifact kind. It is not built here because there is
 * no second artifact to generalize over yet, and the layout-specific behavior
 * is most of the work: the record shape, its immutable fields, its slug
 * identity, and the owner-scoped paths all belong to Layouts and all already
 * exist in the storage adapter (#2060). A generic wrapper would add a naming
 * layer over one caller and would have to be unwrapped again the moment a
 * second artifact turned out not to be slug-keyed. Personal agents (D1's next
 * consumer) can reuse `layoutOwnerDirectory`'s principal key directly.
 *
 * ## Authorization is by construction, not by filter
 *
 * Every method here takes the owner the CALLER resolved to; nothing accepts a
 * principal from a request. The owner selects a directory
 * (`layouts/personal/<principal-key>/`), so a read for a slug another
 * principal owns does not find a record it then has to refuse — it finds
 * nothing, exactly as a slug nobody owns finds nothing. That is why the
 * route's not-found response for the two cases is the same response rather
 * than two responses a caller could tell apart.
 */
import type {
  LayoutConfig,
  LayoutMetadata,
  LayoutOwner,
} from '@kontourai/station-contracts/layout';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type { AgentOwnershipRef } from '@kontourai/station-contracts/project-reference-integrity';
import {
  FileStorageConflictError,
  FileStorageNotFoundError,
} from '../../domain/project-file-transactions.js';
import {
  admitProjectLayoutWrite,
  deriveProjectLayoutWorkingDirectory,
  type ProjectLayoutRefusalBody,
} from '../../routes/projects/project-layout-admission.js';

/**
 * The exact storage surface this service reads — narrower than
 * `IStorageAdapter` so a second reader of owner-scoped layout storage has to
 * declare what it touches. `FileStorageAdapter` satisfies it structurally.
 */
export interface OwnedLayoutStore {
  listOwnedLayouts(owner: LayoutOwner): LayoutMetadata[];
  getOwnedLayout(owner: LayoutOwner, layoutSlug: string): LayoutConfig;
  /**
   * Write one Layout under an owner that does not yet hold that slug.
   *
   * Promote (#2062) is the only caller, and it is the only method here that
   * is ever handed a PROJECT owner: the adapter routes that case into the
   * project transaction (`createLayout` → `projectRevision(slug)`), so a
   * promoted Board is published by the same writer and under the same project
   * lock as every layout the project route creates.
   *
   * CORRECTED (#2062 review BLOCKING-2). This used to add "and the same
   * agent-reference integrity", which the writer does not supply: it checks
   * fingerprints and slug occupancy, and nothing else. A Board carrying
   * `config.availableAgents: ['ghost-agent']` reached disk through here while
   * the project's own route answered 400 for the identical body. The
   * integrity check now runs in `promote`, through the same
   * `admitProjectLayoutWrite` the project route calls — so the equality is
   * real, and it is the CALLER's doing, not this writer's.
   */
  createOwnedLayout(owner: LayoutOwner, config: LayoutConfig): Promise<void>;
  /**
   * The destination project's own record, for the admission promote must pass
   * before publishing into it (#2062 review BLOCKING-2). Declared HERE rather
   * than read through a second adapter reference so this interface still says
   * everything the service touches. Throws `FileStorageNotFoundError` for an
   * unknown slug, which is the project routes' own 404 and is why promote can
   * enforce "the destination exists" without a second existence check.
   */
  getProject(projectSlug: string): ProjectConfig;
  deleteOwnedLayout(owner: LayoutOwner, layoutSlug: string): Promise<void>;
  mutateOwnedLayout(
    owner: LayoutOwner,
    layoutSlug: string,
    update: (current: LayoutConfig | undefined) => LayoutConfig,
  ): Promise<LayoutConfig>;
}

/**
 * Narrows a storage adapter to the owner-scoped surface, or refuses.
 *
 * `IStorageAdapter` declares these four methods OPTIONAL (#2060), so a cast
 * would assert at compile time something only one implementation actually
 * provides, and the route would throw `is not a function` on the first
 * request instead. This checks, and an adapter that cannot serve the personal
 * scope fails at composition — where an operator can read the reason — rather
 * than at the first Board a person opens.
 */
export function ownedLayoutStore(adapter: {
  listOwnedLayouts?: unknown;
  getOwnedLayout?: unknown;
  createOwnedLayout?: unknown;
  deleteOwnedLayout?: unknown;
  mutateOwnedLayout?: unknown;
  getProject?: unknown;
}): OwnedLayoutStore {
  const missing = (
    [
      'listOwnedLayouts',
      'getOwnedLayout',
      'createOwnedLayout',
      'deleteOwnedLayout',
      'mutateOwnedLayout',
      'getProject',
    ] as const
  ).filter((method) => typeof adapter[method] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(
      `storage adapter cannot serve personal-scope layouts: missing ${missing.join(', ')}`,
    );
  }
  return adapter as OwnedLayoutStore;
}

/**
 * A promote the destination project's own admission refuses (#2062 review
 * BLOCKING-2).
 *
 * Carries the exact 400 body `POST /api/projects/:slug/layouts` would have
 * answered, so the route forwards it rather than composing a second wording
 * for the same refusal.
 */
export class ProjectLayoutRefusedError extends Error {
  constructor(readonly body: ProjectLayoutRefusalBody) {
    super(body.error);
    this.name = 'ProjectLayoutRefusedError';
  }
}

/** A Board the caller asked to create under a slug it already owns. */
export class PersonalLayoutConflictError extends Error {
  readonly code = 'PERSONAL_LAYOUT_EXISTS';
  constructor(layoutSlug: string) {
    super(`A Board named '${layoutSlug}' already exists.`);
    this.name = 'PersonalLayoutConflictError';
  }
}

/** The fields a caller may supply when creating or renaming a Board. */
export interface PersonalLayoutInput {
  readonly slug: string;
  readonly name: string;
  readonly type?: string;
  readonly icon?: string;
  readonly description?: string;
  readonly config?: Record<string, unknown>;
}

/** The subset of {@link PersonalLayoutInput} an update may change. */
export type PersonalLayoutPatch = Partial<Omit<PersonalLayoutInput, 'slug'>>;

/**
 * The owner a principal's own Boards are filed under. The ONE place a
 * `PrincipalRef` becomes a `LayoutOwner`, so no route builds the owner object
 * itself and no route can build one for somebody else while doing it.
 */
export function personalLayoutOwner(principal: PrincipalRef): LayoutOwner {
  return { kind: 'principal', principal };
}

export class PersonalLayoutService {
  readonly #store: OwnedLayoutStore;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #listAgents: () => Promise<readonly AgentOwnershipRef[] | undefined>;
  readonly #resolveWorkspacePath?: (
    projectSlug: string,
    resourceId: string,
  ) => Promise<string | undefined>;
  /** In-flight promote per Board; see {@link PersonalLayoutService.promote}. */
  readonly #promotions = new Map<string, Promise<void>>();

  constructor(
    store: OwnedLayoutStore,
    deps: {
      now?: () => string;
      newId: () => string;
      /**
       * The agents a promoted Board's references are checked against.
       *
       * REQUIRED, with no default — a composition that forgets it is a type
       * error rather than a promote that silently skips the check the
       * destination's own route applies. Resolving to `undefined` is still
       * allowed and still means "skip", because that is exactly what
       * `projects.ts`'s `readKnownAgents()` means; what is not allowed is a
       * caller that never had to think about it.
       */
      listAgents: () => Promise<readonly AgentOwnershipRef[] | undefined>;
      /** Resolves a coding layout's repo-scoped directory, as the project routes do. */
      resolveWorkspacePath?: (
        projectSlug: string,
        resourceId: string,
      ) => Promise<string | undefined>;
    },
  ) {
    this.#store = store;
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#newId = deps.newId;
    this.#listAgents = deps.listAgents;
    this.#resolveWorkspacePath = deps.resolveWorkspacePath;
  }

  list(owner: LayoutOwner): LayoutMetadata[] {
    return this.#store.listOwnedLayouts(owner);
  }

  /**
   * The stored Board, or `undefined` when this owner has none under that slug.
   * A missing record is not an error here: the caller's response for "you have
   * no such Board" must not depend on why there is no record.
   */
  get(owner: LayoutOwner, layoutSlug: string): LayoutConfig | undefined {
    try {
      return this.#store.getOwnedLayout(owner, layoutSlug);
    } catch (error) {
      if (error instanceof FileStorageNotFoundError) return undefined;
      throw error;
    }
  }

  /**
   * Create, refusing a slug this owner already uses. The refusal is decided
   * inside the store's per-record lock, so two concurrent creates of the same
   * slug cannot both find it free.
   */
  async create(
    owner: LayoutOwner,
    input: PersonalLayoutInput,
  ): Promise<LayoutConfig> {
    const now = this.#now();
    const id = this.#newId();
    return this.#store.mutateOwnedLayout(owner, input.slug, (current) => {
      if (current !== undefined) {
        throw new PersonalLayoutConflictError(input.slug);
      }
      return {
        // Ownership is ISSUED here from the owner the caller resolved, never
        // copied from anything a request supplied (#2060's rule for the
        // project routes, applied to the scope that has no path segment to
        // read it from).
        owner,
        id,
        slug: input.slug,
        type: input.type ?? 'custom',
        name: input.name,
        ...(input.icon === undefined ? {} : { icon: input.icon }),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        config: input.config ?? {},
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  /**
   * Apply a patch to an existing Board, or return `undefined` when this owner
   * has none under that slug. The read and the write happen in one serialized
   * transaction, so a concurrent update cannot be lost to a stale base.
   */
  async update(
    owner: LayoutOwner,
    layoutSlug: string,
    patch: PersonalLayoutPatch,
  ): Promise<LayoutConfig | undefined> {
    const now = this.#now();
    try {
      return await this.#store.mutateOwnedLayout(
        owner,
        layoutSlug,
        (current) => {
          if (current === undefined) {
            throw new FileStorageNotFoundError(
              `Layout '${layoutSlug}' not found`,
            );
          }
          // `current` is the store's defensive copy; spreading it rather than
          // assigning into it keeps that true for the store's own immutability
          // check on the way out.
          return {
            ...current,
            ...definedFields(patch),
            updatedAt: now,
          };
        },
      );
    } catch (error) {
      if (error instanceof FileStorageNotFoundError) return undefined;
      throw error;
    }
  }

  /**
   * Move a Board into a project, where it becomes that project's Layout
   * (#2062; design decision D1's "a Board can be promoted").
   *
   * ## It is a MOVE, and the order is create-then-delete
   *
   * There is no atomic cross-root move in the storage adapter: the two roots
   * (`layouts/personal/<key>/` and `projects/<slug>/layouts/`) have different
   * locks and different publication paths, and a rename across them would
   * bypass the project transaction that every other project Layout is
   * written through. So the move is two writes, and the ORDER is the whole
   * decision:
   *
   * - **create-then-delete** (what this does) leaves BOTH copies if the
   *   process dies between them. The Board is visible in the project and
   *   still listed personally. Nothing is lost, and the duplicate is
   *   resolvable.
   * - **delete-then-create** would leave NEITHER: a crash after the delete
   *   destroys the only copy, and no later call can reconstruct it.
   *
   * A recoverable duplicate beats an unrecoverable loss, so the create goes
   * first. The window is real and is not papered over: between the two
   * writes the Board appears in `GET /api/me/layouts` AND in the project's
   * layout list.
   *
   * ## Closing the window
   *
   * The read side does NOT resolve it by preferring the project copy. Making
   * `list` prefer a project copy would mean reading every project's layout
   * directory on every personal list — and the whole point of the storage
   * split (#2060) is that a Board cannot appear in a project route, and a
   * project layout cannot appear in a personal one, by construction. Instead
   * the window is closed by REPEATING the promote: a second call finds the
   * project copy already there, recognizes it as this Board's own lineage
   * (same immutable `id`), and completes the interrupted delete. A promote
   * is therefore idempotent for its own interrupted run, and still a 409 for
   * a genuine name collision with somebody else's project Layout.
   *
   * ## Id lineage
   *
   * The project Layout keeps the Board's `id` and `createdAt` verbatim — no
   * `promotedFrom` field. Layout ids are a record field, not a directory key
   * (`file-storage-adapter.ts` keys every root on the SLUG), so nothing
   * requires them to be unique per root and nothing has to be invented to
   * express the lineage. Carrying the same id IS the lineage; a second field
   * asserting it would be a label nothing derives. Only `updatedAt` moves,
   * because the record did.
   *
   * Returns `undefined` when this owner has no Board under that slug — the
   * same "there is no such Board" the other methods answer, for the same
   * reason.
   */
  async promote(
    owner: LayoutOwner,
    layoutSlug: string,
    projectSlug: string,
  ): Promise<LayoutConfig | undefined> {
    // SERIALIZED PER BOARD (#2062 review MED-5). Two concurrent promotes of
    // one Board to DIFFERENT projects both read it, both create their own
    // project copy, and only one delete finds anything — leaving the Board
    // duplicated across two projects with no resume path, because the
    // id-lineage recovery below only recognizes a copy in the destination it
    // is looking at. Running them one at a time makes the second find the
    // Board already gone, which is the honest 404.
    //
    // In-process, like the storage adapter's own per-key queue: it holds for
    // one Station server over one home, which is the concurrency this product
    // has. It is NOT a cross-process lock and does not claim to be one.
    const key = `${JSON.stringify(owner)}\u0000${layoutSlug}`;
    const previous = this.#promotions.get(key) ?? Promise.resolve();
    // A rejected predecessor must not reject its successor: the queue exists
    // to order these, not to couple their outcomes.
    const run = previous
      .catch(() => undefined)
      .then(() => this.#promoteExclusive(owner, layoutSlug, projectSlug));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#promotions.set(key, tail);
    try {
      return await run;
    } finally {
      // Only the LAST promote for this key clears the entry, so the map holds
      // in-flight work rather than growing with every Board ever promoted, and
      // a queued successor is never orphaned.
      if (this.#promotions.get(key) === tail) this.#promotions.delete(key);
    }
  }

  async #promoteExclusive(
    owner: LayoutOwner,
    layoutSlug: string,
    projectSlug: string,
  ): Promise<LayoutConfig | undefined> {
    const board = this.get(owner, layoutSlug);
    if (board === undefined) return undefined;
    const projectOwner: LayoutOwner = { kind: 'project', projectSlug };
    // `owner` is DROPPED rather than set to a project owner: a project record
    // persists `projectSlug` and nothing else (`normalizeProjectLayoutRecord`),
    // so writing both would be the contradiction `layoutOwner` refuses.
    const { owner: _personalOwner, ...withoutOwner } = board;
    const candidate: LayoutConfig = {
      ...withoutOwner,
      projectSlug,
      updatedAt: this.#now(),
    };

    // ADMISSION FIRST (#2062 review BLOCKING-2). The destination's own create
    // route refuses a layout naming an agent the project cannot reach, and a
    // coding layout carrying its own `config.workingDirectory`; promote used
    // to go straight to the storage writer, which checks only fingerprints and
    // slug occupancy, so it published records that route would have answered
    // 400 for. `admitProjectLayoutWrite` is the SAME function that route now
    // calls, so the equality is derived rather than asserted — and it runs
    // before any write, so a refused promote leaves the Board exactly where it
    // was.
    //
    // `getProject` throws `FileStorageNotFoundError` for an unknown slug,
    // which the route already answers as the project routes' own 404. That is
    // also why there is no separate existence check: the read the admission
    // needs IS the existence check.
    const project = this.#store.getProject(projectSlug);
    const admission = admitProjectLayoutWrite({
      project,
      layout: candidate,
      knownAgents: await this.#listAgents(),
      derivedWorkingDirectory: await deriveProjectLayoutWorkingDirectory({
        projectSlug,
        layout: candidate,
        projectWorkingDirectory: project.workingDirectory,
        resolveWorkspacePath: this.#resolveWorkspacePath,
      }),
    });
    if (!admission.ok) throw new ProjectLayoutRefusedError(admission.body);
    const promoted = admission.persisted;

    try {
      await this.#store.createOwnedLayout(projectOwner, promoted);
    } catch (error) {
      if (!(error instanceof FileStorageConflictError)) throw error;
      // Occupied — OR a lost CAS race. `FileStorageConflictError` covers both
      // ("Layout 'x' already exists" and "Project changed before the Layout
      // could be created"), so the occupant read is what tells them apart,
      // and a read that finds NOTHING means it was the race. Rethrowing the
      // original there is what keeps a racing caller a 409 instead of the
      // 404 `Project not found` the route maps `FileStorageNotFoundError` to
      // — which would report a missing project for one that exists.
      let occupant: LayoutConfig;
      try {
        occupant = this.#store.getOwnedLayout(projectOwner, layoutSlug);
      } catch (readError) {
        if (readError instanceof FileStorageNotFoundError) throw error;
        throw readError;
      }
      // Occupied by something else. Not this Board's interrupted promote, so
      // the name genuinely collides and nothing moves.
      if (occupant.id !== board.id) throw error;
      await this.#completeMove(owner, layoutSlug);
      return occupant;
    }
    await this.#completeMove(owner, layoutSlug);
    return promoted;
  }

  /**
   * The delete leg, after the project copy is published.
   *
   * A `FileStorageNotFoundError` here means the personal record is ALREADY
   * gone — a concurrent `DELETE /api/me/layouts/:slug`, or a promote that
   * raced past the serialization above from another process. The move is
   * complete either way: the project holds the Layout and the personal scope
   * does not. Letting that error out of `promote` handed it to the route's
   * catch, which maps `FileStorageNotFoundError` to 404 `Project not found` —
   * naming a project that plainly exists, since its copy was just written
   * (#2062 review MED-4; the same class fixed one line away in bc28143ff).
   *
   * Only absence is swallowed. Any other storage failure still throws,
   * because that one leaves a duplicate somebody has to know about.
   */
  async #completeMove(owner: LayoutOwner, layoutSlug: string): Promise<void> {
    try {
      await this.#store.deleteOwnedLayout(owner, layoutSlug);
    } catch (error) {
      if (error instanceof FileStorageNotFoundError) return;
      throw error;
    }
  }

  /** `false` when this owner has no Board under that slug. */
  async remove(owner: LayoutOwner, layoutSlug: string): Promise<boolean> {
    try {
      await this.#store.deleteOwnedLayout(owner, layoutSlug);
      return true;
    } catch (error) {
      if (error instanceof FileStorageNotFoundError) return false;
      throw error;
    }
  }
}

/**
 * Drops keys the caller left out. A patch that omits `icon` must leave the
 * stored icon alone; spreading the raw patch would overwrite it with
 * `undefined` and the storage schema would then reject the record.
 */
function definedFields(patch: PersonalLayoutPatch): PersonalLayoutPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
}
