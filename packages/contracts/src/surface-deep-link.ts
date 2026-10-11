export const ACTIVITY_SURFACE_ID = 'activity' as const;

export const SURFACE_DEEP_LINK_QUERY_KEYS = {
  surface: 'surface',
  session: 'session',
  focus: 'focus',
  messageSession: 'messageSession',
  messageDirection: 'messageDirection',
  messageRequest: 'messageRequest',
} as const;

export interface SessionMessageAnchor {
  direction: 'sent' | 'received';
  requestKey: string;
}

/** Presentation-only exact join key; it grants no conversation access. */
export function isSessionMessageAnchor(
  value: unknown,
): value is SessionMessageAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const anchor = value as Record<string, unknown>;
  return (
    (anchor.direction === 'sent' || anchor.direction === 'received') &&
    typeof anchor.requestKey === 'string' &&
    anchor.requestKey.length > 0 &&
    anchor.requestKey.length <= 128
  );
}

export type ActivityFocusHint = 'evidence';

export interface ActivityDeepLinkIntent {
  sessionId?: string;
  focus?: ActivityFocusHint;
  messageAnchor?: SessionMessageAnchor;
}

export interface SurfaceDeepLinkIntent {
  surfaceId: string;
  sessionId?: string;
  focus?: ActivityFocusHint;
  messageAnchor?: SessionMessageAnchor;
}

export interface SurfaceDeepLinkInput {
  surfaceId: string;
  sessionId?: string;
  focus?: ActivityFocusHint;
  messageAnchor?: SessionMessageAnchor;
}

/**
 * `/?surface=<enc>[&session=<enc>][&focus=evidence]` with optional
 * `messageSession`, `messageDirection`, and `messageRequest` for an exact record.
 * An anchor requires a Session of 1–512 characters, a sent/received direction,
 * and a request key of 1–128 characters. An invalid or sessionless anchor is
 * omitted; Session navigation remains available. All values are URL-encoded.
 */
export function surfaceDeepLink(input: SurfaceDeepLinkInput): string {
  const surface = encodeURIComponent(input.surfaceId);
  if (!input.sessionId) return `/?surface=${surface}`;

  const session = encodeURIComponent(input.sessionId);
  const focus = input.focus === 'evidence' ? '&focus=evidence' : '';
  const message =
    input.sessionId.length <= 512 && isSessionMessageAnchor(input.messageAnchor)
      ? `&${new URLSearchParams({ messageSession: input.sessionId, messageDirection: input.messageAnchor.direction, messageRequest: input.messageAnchor.requestKey })}`
      : '';
  return `/?surface=${surface}&session=${session}${focus}${message}`;
}

/** Activity destination with the same bounded optional message anchor as surfaceDeepLink. */
export function activityDeepLink(intent?: ActivityDeepLinkIntent): string {
  return surfaceDeepLink({ surfaceId: ACTIVITY_SURFACE_ID, ...intent });
}
