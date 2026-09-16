/**
 * Per-principal plugin visibility (#2067; design decision D2 in
 * `docs/design/shell-ownership-and-boards.md`).
 *
 * Plugin installation stays instance-wide: one `plugins/` directory, one
 * inventory, one set of grants. What this adds is a **projection** of that one
 * installed set onto one person — which plugins a principal may see and
 * compose a Board or a personal agent from. Without it, a Board shared out of
 * a single-operator instance would carry the whole instance's plugin set with
 * it, and the membership record already requires the opposite: a
 * collaborator's first-member journey must refuse to enumerate the instance's
 * plugin list *before their data is read*, not hide it in the UI
 * (`docs/design/project-membership.md`).
 *
 * ## The projection is a derivation, not a stored label
 *
 * Nothing here stores "visible". The record stores exactly one fact — the
 * operator granted principal P sight of plugin N — and every answer is
 * computed from that fact plus the live installed inventory
 * ({@link PluginVisibilityService.visiblePlugins}). So a plugin that is
 * uninstalled disappears from every projection without a sweep, and a stale
 * grant for a plugin that no longer exists can never make one appear.
 *
 * ## What it is NOT
 *
 * This is a *listing and composition* projection. It is not the execution
 * authority for a plugin: that remains the plugin permission grant state
 * (`plugin-permissions.ts`), which every bundle delivery and every invocation
 * rechecks on its own. Hiding a plugin from a person's list does not revoke
 * anything the plugin itself may do, and this service must never be cited as
 * if it did.
 */

import { join } from 'node:path';
import { isAgentPluginName } from '@kontourai/station-contracts/agent-plugin';
import {
  isPrincipalRef,
  type PrincipalRef,
  principalIdMatchesKind,
} from '@kontourai/station-contracts/principal';
import {
  mutateJsonFile,
  readJsonFile,
} from '@kontourai/station-shared/json-file-storage';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../identity/principal-resolver.js';

/** The record's own shape version; a record without it is read as v1. */
const PLUGIN_VISIBILITY_RECORD_VERSION = 1;

/**
 * Bounded so a corrupt or hostile file cannot be read into memory whole. A
 * grant is a principal id plus a plugin name, so this holds thousands.
 */
const PLUGIN_VISIBILITY_MAX_BYTES = 256 * 1024;

export interface PluginVisibilityRecord {
  version: number;
  /** Principal id → the plugin names that principal has been granted sight of. */
  grants: Record<string, string[]>;
}

/** A grant or revoke whose target principal or plugin name could never name one. */
export class PluginVisibilityInputError extends Error {
  readonly code = 'PLUGIN_VISIBILITY_INVALID_TARGET';
  constructor(message: string) {
    super(message);
    this.name = 'PluginVisibilityInputError';
  }
}

/**
 * Whether this principal is the instance operator.
 *
 * The ONE derivation, reused rather than re-spelled: `LOCAL_OPERATOR_PRINCIPAL_ID`
 * is minted by `resolvePrincipal` only after it has verified a home-possession
 * locality or an operator credential
 * (`src-server/services/identity/principal-resolver.ts:193,265-282`), and
 * `humanPrincipal` refuses to construct that id for anybody else
 * (`packages/contracts/src/principal.ts:300`). So carrying the id IS the
 * verified authority fact; this predicate reads it and re-derives nothing.
 *
 * Deliberately narrow: a hosted tenant principal is not an operator here, and
 * a paired device with no person binding is not one either. Both resolve to
 * their own ids and therefore see only what they have been granted.
 */
export function isInstanceOperator(principal: PrincipalRef): boolean {
  return principal.id === LOCAL_OPERATOR_PRINCIPAL_ID;
}

function normalizeRecord(value: unknown): PluginVisibilityRecord {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Partial<PluginVisibilityRecord>)
      : {};
  const rawGrants =
    typeof record.grants === 'object' &&
    record.grants !== null &&
    !Array.isArray(record.grants)
      ? (record.grants as Record<string, unknown>)
      : {};
  const grants: Record<string, string[]> = {};
  for (const [principalId, names] of Object.entries(rawGrants)) {
    // A record entry is re-validated on READ, not trusted because a writer
    // once validated it: this file is on disk in the Station home, and a
    // hand-edited or partially-written entry must not be able to widen a
    // projection. An entry that cannot name a principal or a plugin is
    // dropped rather than repaired.
    if (!principalIdMatchesKind(principalId, 'human')) continue;
    if (!Array.isArray(names)) continue;
    const plugins = [
      ...new Set(
        names.filter(
          (name): name is string =>
            typeof name === 'string' && isAgentPluginName(name),
        ),
      ),
    ].sort();
    if (plugins.length > 0) grants[principalId] = plugins;
  }
  return { version: PLUGIN_VISIBILITY_RECORD_VERSION, grants };
}

function assertGrantTarget(principalId: string, pluginName: string): void {
  if (!principalIdMatchesKind(principalId, 'human')) {
    throw new PluginVisibilityInputError(
      'a visibility grant must name a well-formed human principal id',
    );
  }
  if (!isAgentPluginName(pluginName)) {
    throw new PluginVisibilityInputError(
      'a visibility grant must name a canonical plugin id',
    );
  }
}

export class PluginVisibilityService {
  readonly #path: string;

  /**
   * @param projectHomeDir the Station home. The record sits beside the
   *   instance's `plugins/` directory it projects, so an operator reading the
   *   home finds the grants next to what they grant sight of.
   */
  constructor(projectHomeDir: string) {
    this.#path = join(projectHomeDir, 'plugins', 'visibility.json');
  }

  /** Where the grant record lives; exported for tests and operator diagnostics. */
  get recordPath(): string {
    return this.#path;
  }

  /** The whole grant record. Operator-only data: no route returns it unfiltered. */
  read(): PluginVisibilityRecord {
    return normalizeRecord(
      readJsonFile<unknown>(this.#path, null, {
        maxBytes: PLUGIN_VISIBILITY_MAX_BYTES,
        label: 'plugin visibility record',
      }),
    );
  }

  /**
   * The plugins THIS principal may see, out of the ones installed right now.
   *
   * The derivation, and the only place the operator's blanket sight is
   * expressed: the operator sees `installed` unchanged; anybody else sees the
   * intersection of `installed` with their grants, so a grant naming a plugin
   * that is not installed contributes nothing. Order follows `installed`, so
   * a caller may hand this a list and get a projection of that same list back
   * without re-sorting it.
   */
  visiblePlugins(
    principal: PrincipalRef,
    installed: readonly string[],
  ): readonly string[] {
    if (isInstanceOperator(principal)) return installed;
    const granted = new Set(this.read().grants[principal.id] ?? []);
    return installed.filter((name) => granted.has(name));
  }

  /**
   * Whether this principal may see one named plugin. Same derivation as
   * {@link visiblePlugins} with the installed set left to the caller — used
   * where the caller already holds the plugin (a pane's provenance) and has
   * no list to intersect.
   */
  canSee(principal: PrincipalRef, pluginName: string): boolean {
    if (!isPrincipalRef(principal)) return false;
    if (isInstanceOperator(principal)) return true;
    return (this.read().grants[principal.id] ?? []).includes(pluginName);
  }

  /**
   * Grant sight of one plugin to one principal, returning that principal's
   * full granted list.
   *
   * The read, the decision and the write happen inside `mutateJsonFile`'s
   * per-path mutation lock, so two concurrent grants — to the same principal
   * or to different ones — cannot lose each other to a stale base. A
   * read-modify-write outside that lock would drop one of them silently,
   * which is the failure mode nothing downstream could detect.
   */
  async grant(principalId: string, pluginName: string): Promise<string[]> {
    assertGrantTarget(principalId, pluginName);
    const next = await this.#mutate((current) => {
      const plugins = new Set(current.grants[principalId] ?? []);
      plugins.add(pluginName);
      return {
        ...current,
        grants: { ...current.grants, [principalId]: [...plugins].sort() },
      };
    });
    return next.grants[principalId] ?? [];
  }

  /**
   * Revoke sight of one plugin. A principal left with no grants is removed
   * from the record entirely rather than kept with an empty array: an empty
   * entry and an absent entry mean the same thing, and keeping both shapes
   * would let a reader invent a difference between them.
   */
  async revoke(principalId: string, pluginName: string): Promise<string[]> {
    assertGrantTarget(principalId, pluginName);
    const next = await this.#mutate((current) => {
      const plugins = (current.grants[principalId] ?? []).filter(
        (name) => name !== pluginName,
      );
      const grants = { ...current.grants };
      if (plugins.length > 0) grants[principalId] = plugins;
      else delete grants[principalId];
      return { ...current, grants };
    });
    return next.grants[principalId] ?? [];
  }

  async #mutate(
    update: (current: PluginVisibilityRecord) => PluginVisibilityRecord,
  ): Promise<PluginVisibilityRecord> {
    return mutateJsonFile<PluginVisibilityRecord>(
      this.#path,
      { version: PLUGIN_VISIBILITY_RECORD_VERSION, grants: {} },
      (current) => normalizeRecord(update(normalizeRecord(current))),
      {
        maxBytes: PLUGIN_VISIBILITY_MAX_BYTES,
        label: 'plugin visibility record',
      },
    );
  }
}
