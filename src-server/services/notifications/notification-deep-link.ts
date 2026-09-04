import { activityDeepLink } from '@kontourai/station-contracts/surface-deep-link';

/**
 * Resolves the exact-session deep link for a notification's metadata —
 * shared by `AttentionProjectionService`'s approval projection (the attention
 * inbox's "Open session" action) and the web push payload composer
 * (`push-payload-composer.ts`, archive#1100 AC3) so both surfaces resolve
 * the SAME target from the SAME metadata instead of drifting.
 *
 * Extracted verbatim from `attention-projection.ts`'s former private
 * `approvalOpenHref` — no behavior change, only where it lives (plus the
 * `metadata.link` fallback added below, archive#1100 review fix MEDIUM).
 *
 * Resolves to `undefined` — never a same-page fallback like `/notifications`
 * — when the notification's metadata does not carry enough to deep-link
 * into an owning session or a validated own link; callers fall back to a
 * generic destination themselves rather than rendering/sending a dead link.
 */
export function resolveNotificationOpenHref(
  metadata: Record<string, unknown> | undefined,
  sessionId?: string,
  sessionKind?: string,
): string | undefined {
  const meta = metadata ?? {};
  const projectSlug = stringValue(meta.projectSlug);
  // archive#1284 (AC4): both dock-targeting hrefs below carry `dock=open` so
  // the deep link actually opens the chat dock (`navigation-store.ts`'s
  // `isDockOpen` reads this param) — the Activity surface deep link is not a
  // dock target and deliberately carries no `dock=open`.
  if (projectSlug && sessionId) {
    return `/projects/${encodeURIComponent(projectSlug)}?chat=${encodeURIComponent(sessionId)}&dock=open`;
  }
  if (sessionKind === 'runtime' && sessionId) {
    return activityDeepLink({ sessionId });
  }
  if (sessionKind === 'managed' && sessionId) {
    return `/?chat=${encodeURIComponent(sessionId)}&dock=open`;
  }
  // Final fallback (archive#1100 review fix MEDIUM): a notification with no
  // resolvable session (e.g. a scheduled job failure — no session at all)
  // can still carry its OWN deep link in `metadata.link`
  // (builtin-scheduler-execution.ts sets `/schedule?job=<name>`). Only a
  // same-origin relative path is trusted here — a notification's metadata
  // is not an authenticated navigation target, so an absolute/external or
  // protocol-relative ("//host/...") value is rejected rather than handed
  // to a push notification's click target or an "Open" action's href.
  return resolveRelativePathLink(meta.link);
}

function resolveRelativePathLink(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return undefined;
  // Reject protocol-relative ("//host/...") and backslash-normalized
  // ("/\host/...", which some browsers coerce to "//host/...") variants —
  // both resolve to an external origin despite starting with '/'.
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) return undefined;
  return trimmed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
