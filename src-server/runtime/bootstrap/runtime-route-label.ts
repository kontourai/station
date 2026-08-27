import type { RuntimeHttpRouteRegistration } from '../../security/pairing-route-scopes.js';

const UNKNOWN_ROUTE_SEGMENT = '*';

function routeSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function isStaticRouteSegment(segment: string): boolean {
  return !segment.startsWith(':') && !segment.includes('*');
}

/**
 * Builds the only literals an audit route label may disclose. Pattern
 * parameters and wildcards are caller-controlled positions, never labels.
 */
export function buildRuntimeRouteVocabulary(
  routes: readonly RuntimeHttpRouteRegistration[],
): ReadonlySet<string> {
  const vocabulary = new Set<string>();
  for (const route of routes) {
    for (const segment of routeSegments(route.path)) {
      if (isStaticRouteSegment(segment)) vocabulary.add(segment);
    }
  }
  return vocabulary;
}

/**
 * Produces a leading-slash-free route label that survives the shared absolute
 * path redactor. Every visible segment is either server-declared vocabulary
 * or the fixed unknown placeholder.
 */
export function labelRuntimeRoutePath(
  path: string,
  vocabulary: ReadonlySet<string>,
): string {
  return routeSegments(path)
    .map((segment) =>
      vocabulary.has(segment) ? segment : UNKNOWN_ROUTE_SEGMENT,
    )
    .join('/');
}
