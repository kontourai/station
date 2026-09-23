/**
 * The eligibility query's cache key, in its own module so the eager gate and
 * the lazily loaded Start flow (which invalidates it) share it without
 * importing each other.
 */
export const pluginScaffoldEligibilityKey = (
  apiBase: string,
  projectSlug: string,
) => ['plugin-scaffold-eligibility', apiBase, projectSlug] as const;
