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
 * So the routes refuse the two caller classes that are never a person, both
 * read off the principal the auth boundary bound (`runtime-http.ts`), never a
 * header:
 *
 * - `principal.kind === 'internal'`: set ONLY for a request that proved the
 *   per-boot internal token on a direct loopback socket with
 *   `x-station-proxy-caller: local` and presented no bearer or device-session
 *   credential. That is station-control (stdio child or in-process HTTP),
 *   Station's own agent adapter, and the CLI's identity probe.
 * - a paired-device credential whose `principal.deviceKind` is not
 *   `'device'`: another Station's delegation grant (another Station is not
 *   a person, #2323 S5 review M5), or a device whose kind the boundary did
 *   not resolve, which fails closed.
 *
 * Who is not refused: the browser (Station's UI proxy always sends
 * `x-station-proxy-caller: remote` and forwards the browser's own
 * credential), a person's paired device, and the `station` CLI's plugin
 * commands, which authenticate with a bearer credential and never send the
 * internal token.
 *
 * WHAT THIS DOES NOT CLAIM, stated plainly because it is the accepted limit
 * (#2323 S5 review H1): it closes the path through Station's agent TOOLS. It
 * does not stop code running as the same operating-system user as Station.
 * An engine with a shell (Claude Code or Codex running Bash, say) can read
 * the owner-only files under Station's home (the local-grant secret among
 * them), pair itself, or run `station plugin install --yes`, and each of
 * those is indistinguishable here from the person doing it. What is true:
 * Station's agent tools cannot perform these verbs; their path is a proposal
 * a person completes.
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

/**
 * A paired-device credential that the auth boundary did not bind as a
 * person's device. Fails CLOSED (#2323 S5 delta review): a delegation grant
 * is refused, and so is a device whose kind the boundary could not resolve
 * (a composition without `resolveCredentialDeviceKind`, or a registry read
 * that raced a revocation). Only `deviceKind === 'device'` is a person.
 */
function isUnconfirmedPersonDeviceCaller(request: Request): boolean {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (!principal) return false;
  const isDevice =
    principal.authority === 'device-credential' || !!principal.deviceId;
  return isDevice && principal.deviceKind !== 'device';
}

/**
 * The callers these verbs refuse: never a person. Also what keeps proposal
 * reads from Station's own agents and delegated Stations (#2323 S5 delta
 * review): the internal caller resolves as the operator, and a proposal
 * carries other conversations' rationales and people's principal ids.
 */
export function isNonPersonCaller(request: Request): boolean {
  return (
    isInternalControlCaller(request) || isUnconfirmedPersonDeviceCaller(request)
  );
}

function personApprovalRequiredBody(what: string) {
  return {
    success: false as const,
    code: PLUGIN_PERSON_APPROVAL_REQUIRED,
    error: `A person must approve this in Station: Station's agent tools and delegated Stations cannot ${what}. Station's agent tools can propose it instead (propose_plugin_install, update_plugin or remove_plugin), and a person completes it from Plugins.`,
  };
}

/** The 403 for a non-person caller, or null when the request may proceed. */
export function refuseInternalControlCaller(
  c: Context,
  what: string,
): Response | null {
  if (!isNonPersonCaller(c.req.raw)) return null;
  return c.json(personApprovalRequiredBody(what), 403);
}

/**
 * Route middleware form. Registered BEFORE body validation, so a refused
 * caller learns what to do instead of which field it got wrong.
 */
export function personOnly(what: string): MiddlewareHandler {
  return async (c, next) => {
    const refused = refuseInternalControlCaller(c, what);
    if (refused) return refused;
    await next();
  };
}
