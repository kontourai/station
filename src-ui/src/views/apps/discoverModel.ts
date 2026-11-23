import type {
  RegistryAppFacts,
  RegistryAppPlacement,
  RegistryAppWorksWith,
} from '@kontourai/station-contracts/catalog';
import type { RegistryItem } from '../../components/registry/RegistryCatalog';

/** What Discover knows about an entry, from its catalog `app` fact. */
export type DiscoverKind = 'app' | 'no-screen' | 'unknown';

export function discoverKind(item: RegistryItem): DiscoverKind {
  if (!item.app) return 'unknown';
  return item.app.kind === 'app' ? 'app' : 'no-screen';
}

type AppFacts = Extract<RegistryAppFacts, { kind: 'app' }>;

export function appFactsOf(item: RegistryItem): AppFacts | null {
  return item.app?.kind === 'app' ? item.app : null;
}

/** Facet words, in the order the design lists them. */
export const WORKS_WITH_LABELS: ReadonlyArray<
  readonly [RegistryAppWorksWith, string]
> = [
  ['tasks', 'Tasks'],
  ['chats-and-agents', 'Chats and agents'],
  ['knowledge', 'Knowledge'],
  ['files-and-code', 'Files and code'],
];

export const OPENS_AS_LABELS: ReadonlyArray<
  readonly [RegistryAppPlacement, string]
> = [
  ['screen', 'Its own screen'],
  ['project-view', 'A view in a project'],
  ['pane', 'A pane'],
];

export interface DiscoverFilter {
  worksWith: RegistryAppWorksWith | null;
  opensAs: RegistryAppPlacement | null;
  query: string;
}

/**
 * Facet values with at least one app behind them, and how many. A value no
 * app declares is not offered: a filter that matches nothing is not a choice.
 */
export function facetCounts<T extends string>(
  items: readonly RegistryItem[],
  labels: ReadonlyArray<readonly [T, string]>,
  valuesOf: (facts: AppFacts) => readonly T[],
  selected: T | null = null,
): Array<{ value: T; label: string; count: number }> {
  return labels.flatMap(([value, label]) => {
    const count = items.filter((item) => {
      const facts = appFactsOf(item);
      return facts ? valuesOf(facts).includes(value) : false;
    }).length;
    // The chosen value stays at zero so it can still be cleared.
    return count > 0 || value === selected ? [{ value, label, count }] : [];
  });
}

function matchesQuery(item: RegistryItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const facts = appFactsOf(item);
  return [
    item.displayName,
    item.description,
    item.catalog?.itemId,
    ...(facts?.screens ?? []),
  ].some((value) => value?.toLowerCase().includes(needle));
}

/**
 * The entries a filter shows. A facet only ever selects apps whose facts
 * declare it; entries that are not apps, or whose facts Station could not
 * read, appear only while no facet is chosen.
 */
export function filterDiscover(
  items: readonly RegistryItem[],
  filter: DiscoverFilter,
): RegistryItem[] {
  const faceted = filter.worksWith !== null || filter.opensAs !== null;
  return items.filter((item) => {
    if (!matchesQuery(item, filter.query)) return false;
    if (!faceted) return true;
    const facts = appFactsOf(item);
    if (!facts) return false;
    if (filter.worksWith && !facts.worksWith.includes(filter.worksWith))
      return false;
    if (filter.opensAs && !facts.opensAs.includes(filter.opensAs)) return false;
    return true;
  });
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "1 agent · 3 prompts · 1 knowledge collection", or null when it brings nothing. */
export function bringsLine(facts: AppFacts): string | null {
  const parts = [
    facts.agents > 0 ? plural(facts.agents, 'agent', 'agents') : null,
    facts.promptActions.length > 0
      ? plural(facts.promptActions.length, 'prompt', 'prompts')
      : null,
    facts.knowledge.length > 0
      ? plural(
          facts.knowledge.length,
          'knowledge collection',
          'knowledge collections',
        )
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function opensAsLine(facts: AppFacts): string {
  return OPENS_AS_LABELS.filter(([value]) => facts.opensAs.includes(value))
    .map(([, label]) => label.toLowerCase())
    .join(', ');
}

/**
 * Where an app's screen code runs. In-process code has no isolation from
 * Station. An app with no screen code of its own whose views are MCP tool
 * UIs renders only in a sandboxed frame.
 */
export function trustLine(facts: AppFacts): 'in-window' | 'sandboxed' | null {
  // A server that predates this fact does not say where screen code runs,
  // so nothing is claimed about it.
  const inProcessScreen: unknown = (facts as { inProcessScreen?: unknown })
    .inProcessScreen;
  if (typeof inProcessScreen !== 'boolean') return null;
  if (inProcessScreen) return 'in-window';
  return facts.sandboxedToolView ? 'sandboxed' : null;
}
