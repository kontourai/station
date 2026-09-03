export const ACTIVITY_SURFACE_ID = 'activity' as const;

export const SURFACE_DEEP_LINK_QUERY_KEYS = {
  surface: 'surface',
  session: 'session',
  focus: 'focus',
} as const;

export type ActivityFocusHint = 'evidence';

export interface ActivityDeepLinkIntent {
  sessionId?: string;
  focus?: ActivityFocusHint;
}

export interface SurfaceDeepLinkIntent {
  surfaceId: string;
  sessionId?: string;
  focus?: ActivityFocusHint;
}

/** `/?surface=activity[&session=<enc>][&focus=evidence]`. `focus` is dropped without a session. */
export function activityDeepLink(intent?: ActivityDeepLinkIntent): string {
  const sessionId = intent?.sessionId;
  if (!sessionId) return `/?surface=${ACTIVITY_SURFACE_ID}`;

  const session = encodeURIComponent(sessionId);
  const focus = intent.focus === 'evidence' ? '&focus=evidence' : '';
  return `/?surface=${ACTIVITY_SURFACE_ID}&session=${session}${focus}`;
}

/** Reads only `surface`/`session`/`focus`; returns null without a non-empty `surface`. `focus` is honored only with a session. */
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

/** `{ surface: null, session: null, focus: null }` — the `updateParams` clear patch. */
export function clearSurfaceDeepLinkParams(): Record<
  'surface' | 'session' | 'focus',
  null
> {
  return { surface: null, session: null, focus: null };
}
