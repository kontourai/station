import {
  isSessionMessageAnchor,
  type SessionMessageAnchor,
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
  const direction = params.get(SURFACE_DEEP_LINK_QUERY_KEYS.messageDirection);
  const requestKey = params.get(SURFACE_DEEP_LINK_QUERY_KEYS.messageRequest);
  const messageSession = params.get(
    SURFACE_DEEP_LINK_QUERY_KEYS.messageSession,
  );
  const candidate = { direction, requestKey };
  const messageAnchor: SessionMessageAnchor | undefined =
    messageSession === sessionId &&
    sessionId.length <= 512 &&
    isSessionMessageAnchor(candidate)
      ? candidate
      : undefined;
  return {
    surfaceId,
    sessionId,
    ...(params.get(SURFACE_DEEP_LINK_QUERY_KEYS.focus) === 'evidence'
      ? { focus: 'evidence' as const }
      : {}),
    ...(messageAnchor ? { messageAnchor } : {}),
  };
}

export function clearSurfaceDeepLinkParams(): Record<
  keyof typeof SURFACE_DEEP_LINK_QUERY_KEYS,
  null
> {
  return {
    [SURFACE_DEEP_LINK_QUERY_KEYS.surface]: null,
    [SURFACE_DEEP_LINK_QUERY_KEYS.session]: null,
    [SURFACE_DEEP_LINK_QUERY_KEYS.focus]: null,
    [SURFACE_DEEP_LINK_QUERY_KEYS.messageSession]: null,
    [SURFACE_DEEP_LINK_QUERY_KEYS.messageDirection]: null,
    [SURFACE_DEEP_LINK_QUERY_KEYS.messageRequest]: null,
  };
}
