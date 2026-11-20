import type {
  InstallResult,
  RegistryItem,
} from '@kontourai/station-contracts/catalog';
import type { IAgentRegistryProvider } from '../provider-interfaces.js';

/** One registered agent catalog and the label it was registered under. */
export interface AgentCatalog {
  provider: IAgentRegistryProvider;
  source: string;
}

/** The status a listed agent carries when more than one catalog offers its id. */
export const AMBIGUOUS_AGENT_SOURCE_STATUS = 'ambiguous-source';

/**
 * Every registered agent catalog as one. Rows keep the catalog they came from
 * (`catalogSourceName`). The merge never picks a winner: an id that two
 * catalogs offer is listed from both and marked ambiguous, and installing or
 * updating it is refused, naming the catalogs, rather than going to whichever
 * registered first. A catalog that cannot be read leaves the others listed,
 * but an install is refused until every catalog answers, because the
 * unanswered one might offer the same id.
 */
export type AgentCatalogOwnership =
  | { state: 'owned'; catalog: AgentCatalog }
  | { state: 'none' }
  /** `reason` is a fixed sentence naming the catalogs by their labels. */
  | { state: 'ambiguous'; catalogs: string[]; reason: string }
  | {
      state: 'unavailable';
      catalogs: string[];
      /** Readable catalogs that do offer the id. */
      offeredBy: string[];
      reason: string;
    };

/**
 * A plain agent id refused before any acquisition, because its catalog owner
 * is ambiguous (409) or cannot be established while a catalog is unreadable
 * (503). `reason` is a fixed sentence naming catalogs by their labels.
 */
export class AgentCatalogOwnershipRefusal extends Error {
  readonly status: 409 | 503;
  readonly code: 'agent-catalog-ambiguous' | 'agent-catalog-unavailable';
  constructor(
    readonly state: 'ambiguous' | 'unavailable',
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'AgentCatalogOwnershipRefusal';
    this.status = state === 'ambiguous' ? 409 : 503;
    this.code =
      state === 'ambiguous'
        ? 'agent-catalog-ambiguous'
        : 'agent-catalog-unavailable';
  }
}

/**
 * The one ownership rule for every acquisition of a plain id. The agent face
 * refuses whenever ownership is unknown. A package face (plugin install,
 * preview, update, dependency) refuses an ambiguous id, and an unknown owner
 * only when a readable catalog offers the id as an agent: an ordinary plugin
 * is not blocked because some agent catalog is down.
 */
export function assertAgentOwnershipFor(
  ownership: AgentCatalogOwnership,
  face: 'agent' | 'package',
): void {
  if (ownership.state === 'ambiguous')
    throw new AgentCatalogOwnershipRefusal('ambiguous', ownership.reason);
  if (
    ownership.state === 'unavailable' &&
    (face === 'agent' || ownership.offeredBy.length > 0)
  )
    throw new AgentCatalogOwnershipRefusal('unavailable', ownership.reason);
}

async function readCatalogs(
  catalogs: readonly AgentCatalog[],
  method: 'listAvailable' | 'listInstalled',
) {
  return Promise.all(
    catalogs.map(async (catalog) => {
      try {
        return { catalog, items: await catalog.provider[method]() };
      } catch {
        return { catalog, items: null };
      }
    }),
  );
}

/**
 * Which catalog owns a plain agent id. Ownership is decided only when every
 * catalog answered: a catalog that could not be read might offer the same
 * id, so its silence is `unavailable`, never "not offered".
 */
export async function agentCatalogOwnership(
  catalogs: readonly AgentCatalog[],
  id: string,
  method: 'listAvailable' | 'listInstalled' = 'listAvailable',
): Promise<AgentCatalogOwnership> {
  const lists = await readCatalogs(catalogs, method);
  const failed = lists
    .filter(({ items }) => items === null)
    .map(({ catalog }) => catalog.source);
  if (failed.length > 0)
    return {
      state: 'unavailable',
      catalogs: failed,
      offeredBy: lists
        .filter(({ items }) => items?.some((item) => item.id === id))
        .map(({ catalog }) => catalog.source),
      reason: `The agent catalog ${failed.join(', ')} could not be read, so ${id} cannot be matched to one catalog. Try again when it is available.`,
    };
  const owners = lists
    .filter(({ items }) => items!.some((item) => item.id === id))
    .map(({ catalog }) => catalog);
  if (owners.length > 1) {
    const names = owners.map((catalog) => catalog.source);
    return {
      state: 'ambiguous',
      catalogs: names,
      reason: `${id} is offered by more than one agent catalog (${names.join(', ')}). Disable or remove one of them first.`,
    };
  }
  return owners[0] ? { state: 'owned', catalog: owners[0] } : { state: 'none' };
}

export function createAgentRegistryProvider(
  catalogs: readonly AgentCatalog[],
): IAgentRegistryProvider {
  const read = (method: 'listAvailable' | 'listInstalled') =>
    readCatalogs(catalogs, method);
  const attribute = (
    lists: Awaited<ReturnType<typeof read>>,
    markAmbiguous: boolean,
  ): RegistryItem[] => {
    const offered = new Map<string, number>();
    for (const { items } of lists)
      for (const id of new Set((items ?? []).map((item) => item.id)))
        offered.set(id, (offered.get(id) ?? 0) + 1);
    return lists.flatMap(({ catalog, items }) =>
      (items ?? []).map((item) => ({
        ...item,
        catalogSourceName: item.catalogSourceName ?? catalog.source,
        ...(markAmbiguous && (offered.get(item.id) ?? 0) > 1
          ? { status: AMBIGUOUS_AGENT_SOURCE_STATUS }
          : {}),
      })),
    );
  };
  const owner = async (
    id: string,
    method: 'listAvailable' | 'listInstalled',
  ): Promise<AgentCatalog | InstallResult | null> => {
    const ownership = await agentCatalogOwnership(catalogs, id, method);
    if (ownership.state === 'owned') return ownership.catalog;
    if (ownership.state === 'none') return null;
    return { success: false, message: ownership.reason };
  };
  const isCatalog = (value: unknown): value is AgentCatalog =>
    typeof value === 'object' && value !== null && 'provider' in value;
  return {
    async listAvailable() {
      return attribute(await read('listAvailable'), true);
    },
    async listInstalled() {
      return attribute(await read('listInstalled'), false);
    },
    async install(id) {
      const found = await owner(id, 'listAvailable');
      if (isCatalog(found)) return found.provider.install(id);
      return (
        found ?? { success: false, message: `No agent catalog offers ${id}` }
      );
    },
    async update(id) {
      const found = await owner(id, 'listAvailable');
      if (!isCatalog(found))
        return (
          found ?? { success: false, message: `No agent catalog offers ${id}` }
        );
      return (
        (await found.provider.update?.(id)) ?? {
          success: false,
          message: `${found.source} cannot update ${id}`,
        }
      );
    },
    async uninstall(id) {
      const found = await owner(id, 'listInstalled');
      if (isCatalog(found)) return found.provider.uninstall(id);
      if (found) return found;
      // No catalog lists it as installed. Removal only narrows what this
      // Station runs, so each catalog may try to remove its own copy.
      for (const catalog of catalogs) {
        const result = await catalog.provider.uninstall(id);
        if (result.success) return result;
      }
      return {
        success: false,
        message: `No agent catalog could uninstall ${id}`,
      };
    },
  };
}
