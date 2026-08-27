import { useProjectsQuery } from '@kontourai/station-sdk';

/**
 * Resolves the current project slug from the URL path/hash,
 * falling back to the first project returned by the SDK.
 */
export function useProjectSlug(): string | undefined {
  const { data: projects } = useProjectsQuery();

  // Try to extract from URL: /projects/:slug/... or #/projects/:slug/...
  const match = (window.location.pathname + window.location.hash).match(
    /\/projects\/([^/#?]+)/,
  );
  if (match?.[1]) return match[1];

  return projects?.[0]?.slug;
}
