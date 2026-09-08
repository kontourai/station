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
        <span>Allow HTTP for this Station on this device</span>
      </label>
      <p className="station-connect-hint">
        For development only. HTTP does not encrypt Station traffic; use HTTPS
        for regular connections. This exception applies only to {consent.origin}
        .
      </p>
      {consent.error && <p role="alert">{consent.error}</p>}
    </div>
  );
}
