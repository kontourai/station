/**
 * #1796: the `approval-full-access-not-granted` refusal, made actionable
 * without weakening it.
 *
 * The refusal was one fixed sentence. A person on a paired CLI could not tell
 * which Station refused, which device it meant, or what exactly the operator
 * had to do. It now names:
 *
 *  - what the caller asked for (its own consent to full access), apart from
 *    what only this Station's operator can grant;
 *  - who asked, identified from the request's own VERIFIED credential: a
 *    paired device by short id and display name (never a credential), an
 *    Agent, or another person. The requester chooses its pairing name, so
 *    the name is sanitized and carried only in `details`, never in the
 *    `error` prose a client might render as Markdown or print to a terminal;
 *  - the refusing Station (its environment id);
 *  - the operator's grant path, when one exists: the Station UI path and the
 *    exact host command. An Agent's call has none: an agent never gives
 *    itself, or any session, full access.
 *
 * Nothing here decides anything. `mayGrantFullAccess` (coding-authority.ts)
 * is still the one derivation; this only words its refusal.
 */
import {
  APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE,
  type ApprovalFullAccessRefusalDetails,
  type ApprovalFullAccessRequester,
  sanitizeRefusalDeviceName,
} from '@kontourai/station-contracts/orchestration';
import { requestMayBeAnAgent } from './coding-authority.js';
import { getRuntimeAuthenticatedRequestPrincipal } from './runtime-request-security.js';

/** What the refusal may say about this Station and its paired devices. */
export interface FullAccessRefusalIdentitySource {
  environmentId(): string | undefined;
  /** A paired device's display name, by its id. */
  deviceName(deviceId: string): string | undefined;
}

const identitySources = new WeakMap<Request, FullAccessRefusalIdentitySource>();

/**
 * Bound once per request by the runtime composition, so every route that
 * refuses full access can name the Station and device without each carrying
 * the pairing service.
 */
export function bindFullAccessRefusalIdentity(
  request: Request,
  source: FullAccessRefusalIdentitySource,
): void {
  identitySources.set(request, source);
}

/** A device's short id: enough to tell devices apart, and a unique prefix. */
function shortDeviceId(deviceId: string): string {
  return deviceId.slice(0, 8);
}

/**
 * The Station UI path to a device's full-access grant, as the UI labels it:
 * the Station name at the top right opens the connection manager, whose
 * "Paired devices" list has "Change access" per device. It needs the
 * operator's own session (the Station desktop app on its host); a paired
 * browser cannot list devices, so the host command comes first. Fixed text:
 * no step names the device.
 */
const FULL_ACCESS_GRANT_UI_STEPS: readonly string[] = [
  "Open the Station desktop app on the Station's host.",
  'Select the Station name (top right), then Paired devices.',
  'Select the device by its name, then Change access.',
  'Turn on Allow full access, then Apply.',
];

/** The operator command, run on the Station's own host. */
function fullAccessGrantCommand(deviceId: string): string {
  return `station environment access scope ${shortDeviceId(deviceId)} --add approval:full-access`;
}

function requesterOf(request: Request): ApprovalFullAccessRequester {
  if (requestMayBeAnAgent(request)) return { kind: 'agent' };
  const deviceId = getRuntimeAuthenticatedRequestPrincipal(request)?.deviceId;
  if (deviceId) {
    let name: string | undefined;
    try {
      name = identitySources.get(request)?.deviceName(deviceId);
    } catch {
      name = undefined;
    }
    return {
      kind: 'device',
      deviceId: shortDeviceId(deviceId),
      deviceName: sanitizeRefusalDeviceName(name ?? ''),
    };
  }
  return { kind: 'person' };
}

function detailsFor(
  request: Request,
  requester: ApprovalFullAccessRequester,
): ApprovalFullAccessRefusalDetails {
  let environmentId: string | undefined;
  try {
    environmentId = identitySources.get(request)?.environmentId();
  } catch {
    environmentId = undefined;
  }
  const station = environmentId ? { environmentId } : {};
  const fullDeviceId =
    requester.kind === 'device'
      ? getRuntimeAuthenticatedRequestPrincipal(request)?.deviceId
      : undefined;
  return {
    requested: 'never',
    requester,
    station,
    grant:
      requester.kind === 'agent'
        ? null
        : {
            by: 'operator',
            scope: 'approval:full-access',
            uiSteps: FULL_ACCESS_GRANT_UI_STEPS,
            ...(fullDeviceId
              ? { cli: fullAccessGrantCommand(fullDeviceId) }
              : {}),
          },
  };
}

function messageFor(details: ApprovalFullAccessRefusalDetails): string {
  const { requester, grant } = details;
  if (requester.kind === 'agent' || !grant)
    return 'Full access was not applied. An agent can never put itself, or any session, at full access. A person must choose it in Station, from a device the operator has allowed full access.';
  const who =
    requester.kind === 'device'
      ? `this device (id ${requester.deviceId})`
      : 'the device you are using';
  return (
    `Full access was not applied. Only this Station's operator can allow full access, for ${who}.` +
    (grant.cli
      ? ` On the Station's host, the operator can run: ${grant.cli}`
      : ' The operator can allow it in the Station desktop app on its host, under Paired devices.')
  );
}

/** The 403 body for a refused full-access request. */
export function fullAccessRefusalBody(request: Request): {
  success: false;
  code: typeof APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE;
  error: string;
  details: ApprovalFullAccessRefusalDetails;
} {
  const details = detailsFor(request, requesterOf(request));
  return {
    success: false,
    code: APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE,
    error: messageFor(details),
    details,
  };
}
