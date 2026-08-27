export const PROJECT_ACCENT_PALETTE = [
  'var(--event-agent-start)',
  'var(--event-agent-complete)',
  'var(--event-tool-call)',
  'var(--event-tool-result)',
  'var(--event-agent-health)',
  'var(--event-reasoning)',
] as const;

/**
 * Assign an accent color to every slug in the current project set, using the
 * full palette before repeating any color. Assignment is over a deterministically
 * SORTED slug set (not API order), so a project keeps its color regardless of
 * how the backend returns projects and no two projects share a color while the
 * set fits within the palette.
 *
 * Returns a slug → color map. The caller (e.g. the project sidebar) computes
 * this once over its sorted project list and threads the resolved accent into
 * each row, so the accent reflects the whole set rather than a single slug.
 */
export function projectAccents(slugs: string[]): Map<string, string> {
  const sorted = [...new Set(slugs)].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const result = new Map<string, string>();
  sorted.forEach((slug, index) => {
    result.set(
      slug,
      PROJECT_ACCENT_PALETTE[index % PROJECT_ACCENT_PALETTE.length],
    );
  });
  return result;
}

/**
 * Compatibility single-slug helper. Prefer `projectAccents` at the call site
 * that owns the project set so the palette is allocated across the whole set
 * before repeating. This remains for surfaces that genuinely have one slug and
 * no set context.
 */
export function projectAccent(slug: string): string {
  return PROJECT_ACCENT_PALETTE[
    indexForSlug(slug) % PROJECT_ACCENT_PALETTE.length
  ];
}

function indexForSlug(slug: string): number {
  let hash = 0;
  for (let index = 0; index < slug.length; index += 1) {
    hash = (hash * 31 + slug.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}
