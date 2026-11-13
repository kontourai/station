/**
 * Whether an engine's `session/load` or `session/resume` answer attached the
 * session Station asked for. ACP's `LoadSessionResponse` and
 * `ResumeSessionResponse` carry no session id, so the protocol itself cannot
 * say an engine answered a reattach by starting a new, empty session. Some
 * engines name the session they attached in their own `_meta`; this table
 * reads that name, keyed on what the live handshake says about the engine
 * (ADR 0013), never on the launch command.
 *
 * An answer without the field is no verdict: the reattach stands as before.
 */
import {
  type AcpHandshakeIdentity,
  type AcpIdentityHandshake,
  matchesAcpHandshakeIdentity,
} from '../../services/acp/acp-handshake-facts.js';
import { isRecord } from '../../utils/is-record.js';

const ACP_REATTACHED_SESSION_NAMES: ReadonlyArray<{
  identity: AcpHandshakeIdentity;
  /** Keys under the answer's `_meta` to the attached session's ACP id. */
  path: readonly string[];
  observed: string;
}> = [
  {
    // Hermes answers new/load/resume with `_meta.hermes.sessionProvenance`,
    // whose `acpSessionId` is the session the answer is about
    // (acp_adapter/provenance.py). Its in-process agent answers a resume of
    // an unknown id by creating a new session and returning success, with
    // the new id there (acp_adapter/server.py resume_session: "not found,
    // creating new"); `hermes acp` ran that agent up to v0.22.0 and in
    // v0.22.2. The gateway viewer `hermes acp` runs from v0.22.1 on errors
    // instead, and names the requested id (acp_adapter/gateway_server.py
    // _resume). Both name themselves `hermes-agent` at initialize.
    identity: { agentInfoName: 'hermes-agent' },
    path: ['hermes', 'sessionProvenance', 'acpSessionId'],
    observed:
      'NousResearch/hermes-agent v0.22.0 (e06df9c2eae6) acp_adapter/server.py resume_session; v0.23.1 (bf0073dadb47) acp_adapter/gateway_server.py _resume, acp_adapter/provenance.py',
  },
];

/**
 * The id an engine says its reattach answer attached, when its handshake
 * identifies one that names it, or `undefined`.
 */
export function acpReattachedSessionId(
  handshake: AcpIdentityHandshake | null | undefined,
  answer: unknown,
): string | undefined {
  if (!handshake || !isRecord(answer)) return undefined;
  for (const { identity, path } of ACP_REATTACHED_SESSION_NAMES) {
    if (!matchesAcpHandshakeIdentity(handshake, identity)) continue;
    let value: unknown = answer._meta;
    for (const key of path) value = isRecord(value) ? value[key] : undefined;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Throws when the engine names a session other than the one asked for: the
 * reattach then holds none of the conversation's context, so it is a failed
 * resume, never a silent fresh start.
 */
export function assertAcpReattachedRequestedSession(
  handshake: AcpIdentityHandshake | null | undefined,
  requestedSessionId: string,
  answer: unknown,
): void {
  const attached = acpReattachedSessionId(handshake, answer);
  if (attached !== undefined && attached !== requestedSessionId) {
    throw new AcpReattachedOtherSessionError(requestedSessionId, attached);
  }
}

export class AcpReattachedOtherSessionError extends Error {
  constructor(
    readonly requestedSessionId: string,
    readonly attachedSessionId: string,
  ) {
    super(
      "The engine did not restore this conversation: it answered the resume with a different, new session, which holds none of the conversation's context.",
    );
    this.name = 'AcpReattachedOtherSessionError';
  }
}
