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
export function createAgentRegistryProvider(
  catalogs: readonly AgentCatalog[],
): IAgentRegistryProvider {
  const read = async (method: 'listAvailable' | 'listInstalled') =>
    Promise.all(
      catalogs.map(async (catalog) => {
        try {
          return { catalog, items: await catalog.provider[method]() };
        } catch {
          return { catalog, items: null };
        }
      }),
    );
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
    const lists = await read(method);
    if (lists.some(({ items }) => items === null))
      return {
        success: false,
        message: `Could not read every agent catalog, so ${id} cannot be matched to one. Try again.`,
      };
    const owners = lists
      .filter(({ items }) => items!.some((item) => item.id === id))
      .map(({ catalog }) => catalog);
    if (owners.length > 1)
      return {
        success: false,
        message: `${id} is offered by more than one agent catalog (${owners.map((catalog) => catalog.source).join(', ')}). Disable or remove one of them first.`,
      };
    return owners[0] ?? null;
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
      return found ?? { success: false, message: `No agent catalog offers ${id}` };
    },
    async update(id) {
      const found = await owner(id, 'listAvailable');
      if (!isCatalog(found))
        return found ?? { success: false, message: `No agent catalog offers ${id}` };
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
      return { success: false, message: `No agent catalog could uninstall ${id}` };
    },
  };
}
