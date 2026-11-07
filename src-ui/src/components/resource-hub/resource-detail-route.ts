/**
 * `<base>/<id>/<tab>` for a resource detail whose tabs are routes.
 *
 * The tab segment is optional and checked against the detail's allow-list:
 * a tab not on the list is a not-found route, never silently dropped (the
 * Connections parser used to ignore everything after the id). Adding a tab
 * is one entry in that list.
 */

export type ResourceDetailRoute<Tab extends string> =
  | { id: string; tab?: Tab }
  | { notFound: true };

/**
 * Parses `path` under `base`. `null` when the path is not a detail of `base`
 * (no id), so the caller's other rules still apply.
 */
export function parseResourceDetailPath<Tab extends string>(
  path: string,
  base: string,
  tabs: readonly Tab[],
): ResourceDetailRoute<Tab> | null {
  if (!path.startsWith(`${base}/`)) return null;
  // One trailing slash is the same route, with or without a tab.
  const rest = path.slice(base.length + 1).replace(/\/$/, '');
  const [rawId, tab, ...extra] = rest.split('/');
  if (!rawId) return null;
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return { notFound: true };
  }
  if (tab === undefined) return { id };
  const known = tabs.find((candidate) => candidate === tab);
  if (!known || extra.length > 0) return { notFound: true };
  return { id, tab: known };
}

/** The id is encoded, so an id holding `/` or `%` round-trips. */
export function resourceDetailPath(
  base: string,
  id: string,
  tab?: string,
): string {
  return `${base}/${encodeURIComponent(id)}${tab ? `/${tab}` : ''}`;
}
