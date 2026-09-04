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

export interface SurfaceDeepLinkInput {
  surfaceId: string;
  sessionId?: string;
  focus?: ActivityFocusHint;
}

/** `/?surface=<enc>[&session=<enc>][&focus=evidence]`. `focus` is dropped without a session. */
export function surfaceDeepLink(input: SurfaceDeepLinkInput): string {
  const surface = encodeURIComponent(input.surfaceId);
  if (!input.sessionId) return `/?surface=${surface}`;

  const session = encodeURIComponent(input.sessionId);
  const focus = input.focus === 'evidence' ? '&focus=evidence' : '';
  return `/?surface=${surface}&session=${session}${focus}`;
}

/** `/?surface=activity[&session=<enc>][&focus=evidence]`. `focus` is dropped without a session. */
export function activityDeepLink(intent?: ActivityDeepLinkIntent): string {
  return surfaceDeepLink({ surfaceId: ACTIVITY_SURFACE_ID, ...intent });
}
