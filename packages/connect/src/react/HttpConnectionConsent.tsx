import { useState } from 'react';
import { isCleartextNonLoopback, normalizeHostInput } from '../core/hostInput';

/** A device-local exception for one origin; never a blanket HTTP preference. */
export function useHttpConnectionConsent(address: string) {
  const [, refresh] = useState(0);
  const [error, setError] = useState('');
  const normalized = normalizeHostInput(address);
  const required = isCleartextNonLoopback(normalized);
  let origin = '';
  try {
    origin = new URL(normalized).origin;
  } catch {
    /* URL validation belongs to the form. */
  }
  const key = `station-http-development:${origin}`;
  let accepted = false;
  try {
    accepted = localStorage.getItem(key) === 'allowed';
  } catch {
    /* Fail closed. */
  }
  return {
    required,
    allowed: !required || accepted,
    origin,
    error,
    setAllowed(value: boolean) {
      try {
        if (value) localStorage.setItem(key, 'allowed');
        else localStorage.removeItem(key);
        setError('');
      } catch {
        setError('Could not save this device setting. Use an HTTPS address.');
      }
      refresh((value) => value + 1);
    },
  };
}

export function HttpConnectionConsent({
  consent,
}: {
  consent: ReturnType<typeof useHttpConnectionConsent>;
}) {
  if (!consent.required) return null;
  return (
    <div className="pairing-target">
      <label
        style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}
      >
        <input
          type="checkbox"
          checked={consent.allowed}
          onChange={(event) => consent.setAllowed(event.target.checked)}
        />
        <span>Allow an unencrypted connection</span>
      </label>
      <p className="station-connect-hint">
        Use only for local testing on a network you trust. Messages sent this
        way are not encrypted.
      </p>
      {consent.error && <p role="alert">{consent.error}</p>}
    </div>
  );
}
