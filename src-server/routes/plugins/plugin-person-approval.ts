/**
 * Plugin lifecycle verbs a person must take (#2323 S5).
 *
 * Installing, recovering, updating and removing a plugin changes what code
 * runs in Station, and in the shell's own page. `install_plugin` in
 * station-control already refused to install, but the refusal lived only in
 * the tool: `POST /api/plugins/install` accepted a consent body from any
 * caller holding `orchestration:operate`, including station-control's own
 * per-boot internal token. An agent could read `POST /preview` back and echo
 * its digest into `/install`, and the record would say an operator decided
 * when nobody saw anything. Update and remove had no refusal anywhere.
 *
 * So the route refuses the caller class that is never a person. That class
 * is the one the auth boundary already names: `principal.kind === 'internal'`
 * is set in `runtime-http.ts` ONLY for a request that proved the per-boot
 * internal token on a direct loopback socket with `x-station-proxy-caller:
 * local` AND presented no bearer or device-session credential. Who reaches
 * that branch:
 *
 * - station-control (`station-control-shared.ts` `api()` and
 *   `controlRequestOptions()`), in its stdio child or in-process HTTP form;
 * - Station's own agent adapter (`station-agent-adapter.ts`);
 * - the CLI's lifecycle readiness probe, which only reads identity.
 *
 * Who does not: the browser (Station's UI proxy always sends
 * `x-station-proxy-caller: remote` and forwards the browser's own
 * credential), and the `station` CLI's plugin commands, which authenticate
 * with a bearer credential through `authenticatedFetch` and never send the
 * internal token. Both keep working unchanged.
 *
 * What this does NOT claim: that every non-internal caller is a person. A
 * paired device holding `orchestration:operate` is still admitted, as it is
 * for every other operate-tier route; a process that can read this user's
 * credential files can act as this user anyway. The claim is narrower and
 * checkable: Station's own agent surface cannot perform these verbs, so an
 * agent's only path is a proposal a person completes.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';

/** The refusal code, shared by the routes and the tools that read it. */
export const PLUGIN_PERSON_APPROVAL_REQUIRED = 'person-approval-required';

/**
 * Whether this request came from Station's own internal caller class, the
 * one station-control and Station's agent adapter use. Read from the
 * principal the auth boundary bound to the request, never from a header.
 */
export function isInternalControlCaller(request: Request): boolean {
  return getRuntimeAuthenticatedRequestPrincipal(request)?.kind === 'internal';
}

export function personApprovalRequiredBody(what: string) {
  return {
    success: false as const,
    code: PLUGIN_PERSON_APPROVAL_REQUIRED,
    error: `A person must approve this in Station: Station's agent tools cannot ${what}. Propose it instead (propose_plugin_install, update_plugin or remove_plugin create a proposal), and a person completes it from Plugins.`,
  };
}

/** The 403 for an internal caller, or null when the request may proceed. */
export function refuseInternalControlCaller(
  c: Context,
  what: string,
): Response | null {
  if (!isInternalControlCaller(c.req.raw)) return null;
  return c.json(personApprovalRequiredBody(what), 403);
}

/**
 * Route middleware form. Registered BEFORE body validation, so an internal
 * caller learns what to do instead of which field it got wrong.
 */
export function personOnly(what: string): MiddlewareHandler {
  return async (c, next) => {
    const refused = refuseInternalControlCaller(c, what);
    if (refused) return refused;
    await next();
  };
}
