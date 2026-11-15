/**
 * The station-docs tool names and descriptions, apart from the server that
 * serves them. The main server lists these in its tool catalogs; importing
 * them from `station-docs-mcp-server.ts` would carry the whole compiled
 * documentation bundle into it, which only the station-docs process reads.
 */
export const STATION_DOCS_TOOLS = [
  {
    name: 'list_station_docs_topics',
    title: 'Browse documentation',
    description:
      "List topics in Station's SHIPPED DOCUMENTATION, including the architecture learning tree. Filter parentId to manual, architecture, or a branch id returned by this tool. Returns bundled documentation, never live state: it cannot tell you what exists on this Station.",
    group: 'Documentation',
    readOnly: true,
  },
  {
    name: 'get_station_docs_topic',
    title: 'Read documentation',
    description:
      "Read one topic of Station's SHIPPED DOCUMENTATION by id (use list_station_docs_topics for the ids). Returns bundled documentation, never live state: it describes how Station works in general, not this Station's agents, runs, or settings.",
    group: 'Documentation',
    readOnly: true,
  },
  {
    name: 'search_station_docs',
    title: 'Search documentation',
    description:
      "Ranked search across Station's SHIPPED DOCUMENTATION, best match first. Returns bundled documentation topics, never live state: it searches Station's manual, not this Station's data.",
    group: 'Documentation',
    readOnly: true,
  },
];

export function stationDocsToolCatalog() {
  return STATION_DOCS_TOOLS;
}
