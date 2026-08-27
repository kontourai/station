import { isCleartextNonLoopback, normalizeHostInput } from '../core/hostInput';
import './ConnectionManagerModal.css';

/**
 * Non-blocking advisory shown beneath a manual host-address field when the
 * address the user typed resolves to cleartext `http://` against a raw IP or
 * remote hostname. It never blocks submission — raw HTTP to a LAN/direct host
 * is valid — it only nudges toward the HTTPS path that carries a verified
 * Station identity.
 *
 * `address` is the raw field value; it is normalized the same way submission
 * normalizes it, so a bare host (defaulted to HTTPS) shows no hint.
 */
export function HttpsPreferenceHint({ address }: { address: string }) {
  if (!isCleartextNonLoopback(normalizeHostInput(address))) return null;
  return (
    <p className="station-connect-hint" role="note">
      Connecting over http to a raw address works, but an HTTPS hostname (like
      your Tailscale name) gives this device a verified Station identity and an
      encrypted connection.
    </p>
  );
}
