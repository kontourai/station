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
import { FileStorageNotFoundError } from '../../domain/project-file-transactions.js';

/**
 * The exact storage surface this service reads — narrower than
 * `IStorageAdapter` so a second reader of owner-scoped layout storage has to
 * declare what it touches. `FileStorageAdapter` satisfies it structurally.
 */
export interface OwnedLayoutStore {
  listOwnedLayouts(owner: LayoutOwner): LayoutMetadata[];
  getOwnedLayout(owner: LayoutOwner, layoutSlug: string): LayoutConfig;
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
  deleteOwnedLayout?: unknown;
  mutateOwnedLayout?: unknown;
}): OwnedLayoutStore {
  const missing = (
    [
      'listOwnedLayouts',
      'getOwnedLayout',
      'deleteOwnedLayout',
      'mutateOwnedLayout',
    ] as const
  ).filter((method) => typeof adapter[method] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(
      `storage adapter cannot serve personal-scope layouts: missing ${missing.join(', ')}`,
    );
  }
  return adapter as OwnedLayoutStore;
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

  constructor(
    store: OwnedLayoutStore,
    deps: { now?: () => string; newId: () => string },
  ) {
    this.#store = store;
    this.#now = deps.now ?? (() => new Date().toISOString());
    this.#newId = deps.newId;
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
