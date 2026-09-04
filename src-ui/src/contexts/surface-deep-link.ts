import {
  SURFACE_DEEP_LINK_QUERY_KEYS,
  type SurfaceDeepLinkIntent,
} from '@kontourai/station-contracts/surface-deep-link';

export function parseSurfaceDeepLink(
  params: URLSearchParams,
): SurfaceDeepLinkIntent | null {
  const surfaceId = params.get(SURFACE_DEEP_LINK_QUERY_KEYS.surface)?.trim();
  if (!surfaceId) return null;
  const sessionId = params.get(SURFACE_DEEP_LINK_QUERY_KEYS.session)?.trim();
  if (!sessionId) return { surfaceId };
  return params.get(SURFACE_DEEP_LINK_QUERY_KEYS.focus) === 'evidence'
    ? { surfaceId, sessionId, focus: 'evidence' }
    : { surfaceId, sessionId };
}

export function clearSurfaceDeepLinkParams(): Record<
  keyof typeof SURFACE_DEEP_LINK_QUERY_KEYS,
  null
> {
  return {
    [SURFACE_DEEP_LINK_QUERY_KEYS.surface]: null,
    [SURFACE_DEEP_LINK_QUERY_KEYS.session]: null,
    [SURFACE_DEEP_LINK_QUERY_KEYS.focus]: null,
  };
}
