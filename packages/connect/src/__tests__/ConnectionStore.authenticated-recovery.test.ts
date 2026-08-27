/**
 * `recordAuthenticatedSuccess` — the ordering and binding rules, and the exact
 * credential state a recovery puts back.
 *
 * An accepted authenticated response retires the evidence a rejected
 * credential left behind. A connection ID alone is not enough to make that
 * acceptance CURRENT, which is what the delta review found: a 2xx that was
 * already in flight when the rejection was recorded would erase it (leaving
 * the user locked out with no banner), and a 2xx from an address the
 * connection no longer points at would "recover" the new one — and reselect
 * the old URL as verified while doing it.
 *
 * The visible half of the same behaviour — the "Request access to reconnect"
 * banner appearing and disappearing — is asserted against the real
 * `OnboardingGate` in
 * `src-ui/src/contexts/__tests__/ApiBaseContext.credential-recovery.test.tsx`.
 */
import { describe, expect, it } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import type { StorageAdapter } from '../core/types';

function memoryAdapter(): StorageAdapter {
  const store: Record<string, string> = {};
  return {
    get: (k) => store[k] ?? null,
    set: (k, v) => {
      store[k] = v;
    },
    remove: (k) => {
      delete store[k];
    },
  };
}

const REMOTE = 'https://station.example.test';
const LOOPBACK = 'http://localhost:3141';

function storeWith(url: string) {
  const store = new ConnectionStore({ storage: memoryAdapter() });
  const connection = store.add('Station', url);
  store.setActive(connection.id);
  return { store, id: connection.id };
}

/** Puts a connection into the state a 401 leaves it in. */
function reject(store: ConnectionStore, id: string) {
  store.markCredentialRequired(id, store.getCredential(id) ?? undefined);
  expect(store.getAll().find((item) => item.id === id)?.credentialState).toBe(
    'required',
  );
}

describe('recordAuthenticatedSuccess — ordering', () => {
  it('recovers from an acceptance whose generation is still current', () => {
    const { store, id } = storeWith(REMOTE);
    store.markDeviceSession(id);
    const generation = store.credentialGeneration(id);
    reject(store, id);

    // A request issued AFTER the rejection captures the newer generation.
    store.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/settings`,
      store.credentialGeneration(id),
    );

    const recovered = store.getAll().find((item) => item.id === id);
    expect(recovered?.credentialState).not.toBe('required');
    expect(recovered?.lastError).toBeUndefined();
    // Guard against the test passing because nothing invalidated anything.
    expect(store.credentialGeneration(id)).not.toBe(generation);
  });

  it('ignores an acceptance that was issued before the rejection it would erase', () => {
    const { store, id } = storeWith(REMOTE);
    store.markDeviceSession(id);
    // Request A starts here and captures this generation.
    const generationAtRequestStart = store.credentialGeneration(id);

    // Request B is rejected while A is still in flight.
    reject(store, id);

    // A lands, carrying a 200 that predates the rejection.
    store.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/projects`,
      generationAtRequestStart,
    );

    expect(store.getAll().find((item) => item.id === id)?.credentialState).toBe(
      'required',
    );
  });

  it('ignores an acceptance that was issued before a recorded endpoint failure', () => {
    const { store, id } = storeWith(REMOTE);
    store.markDeviceSession(id);
    const generationAtRequestStart = store.credentialGeneration(id);
    reject(store, id);
    store.recordEndpointFailure(id, 'authentication-failed');

    store.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/projects`,
      generationAtRequestStart,
    );

    const item = store.getAll().find((entry) => entry.id === id);
    expect(item?.credentialState).toBe('required');
    expect(item?.lastError?.reason).toBe('authentication-failed');
  });
});

describe('recordAuthenticatedSuccess — binding to the current address', () => {
  it('ignores an acceptance from an address the connection no longer points at', () => {
    const { store, id } = storeWith(REMOTE);
    store.markDeviceSession(id);
    store.update(id, { url: 'https://moved.example.test' });
    expect(store.getAll().find((entry) => entry.id === id)?.url).toBe(
      'https://moved.example.test',
    );
    reject(store, id);

    // A 2xx from the OLD origin, carrying the CURRENT generation, so only the
    // origin check can reject it.
    store.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/settings`,
      store.credentialGeneration(id),
    );

    const item = store.getAll().find((entry) => entry.id === id);
    expect(item?.credentialState).toBe('required');
    // The old address must not have been reselected as the verified one.
    expect(item?.url).toBe('https://moved.example.test');
  });

  it('recovers from an acceptance on the current address', () => {
    const { store, id } = storeWith(REMOTE);
    store.markDeviceSession(id);
    reject(store, id);

    store.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/settings`,
      store.credentialGeneration(id),
    );

    expect(
      store.getAll().find((entry) => entry.id === id)?.credentialState,
    ).not.toBe('required');
  });
});

describe('recordAuthenticatedSuccess — the recovered credential state', () => {
  it('a stored bearer that still works comes back as saved', () => {
    const { store, id } = storeWith(REMOTE);
    store.setCredential(id, 'a-bearer-not-for-production');
    // A rejection that does NOT match the stored credential leaves it in place
    // — the shape of a 401 caused by something other than this bearer.
    store.recordEndpointFailure(id, 'authentication-failed');
    store.removeCredential(id);
    store.setCredential(id, 'a-bearer-not-for-production');
    store.recordEndpointFailure(id, 'authentication-failed');

    store.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/settings`,
      store.credentialGeneration(id),
    );

    expect(
      store.getAll().find((entry) => entry.id === id)?.credentialState,
    ).toBe('saved');
  });

  it('a LOOPBACK connection paired into a device session comes back as device-session, not not-required', () => {
    // The delta review's case. The address implies `not-required`, but the
    // pairing is a fact about the connection, and losing it silently downgrades
    // what the Connections UI reports about how this Station is reached.
    const { store, id } = storeWith(LOOPBACK);
    store.markDeviceSession(id);
    reject(store, id);

    store.recordAuthenticatedSuccess(
      id,
      `${LOOPBACK}/api/settings`,
      store.credentialGeneration(id),
    );

    expect(
      store.getAll().find((entry) => entry.id === id)?.credentialState,
    ).toBe('device-session');
  });

  it('a REMOTE connection with no stored bearer comes back as device-session', () => {
    // Nothing local could have authenticated it, so a cookie session did.
    const { store, id } = storeWith(REMOTE);
    reject(store, id);

    store.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/settings`,
      store.credentialGeneration(id),
    );

    expect(
      store.getAll().find((entry) => entry.id === id)?.credentialState,
    ).toBe('device-session');
  });

  it('a loopback device session survives a RELOAD between the 401 and the recovery', () => {
    // #3599. The displaced state used to live in store memory, so a page
    // reload between the rejection and the accepted request lost it and the
    // loopback address re-derived `not-required` — silently downgrading what
    // Connections reports about how this Station is reached.
    const storage = memoryAdapter();
    const store = new ConnectionStore({ storage });
    const connection = store.add('Station', LOOPBACK);
    store.setActive(connection.id);
    store.markDeviceSession(connection.id);
    reject(store, connection.id);

    // The page reloads: a NEW store over the SAME storage, with no memory of
    // what that rejection displaced.
    const reloaded = new ConnectionStore({ storage });
    expect(
      reloaded.getAll().find((item) => item.id === connection.id)
        ?.credentialState,
    ).toBe('required');

    reloaded.recordAuthenticatedSuccess(
      connection.id,
      `${LOOPBACK}/api/settings`,
      reloaded.credentialGeneration(connection.id),
    );

    expect(
      reloaded.getAll().find((item) => item.id === connection.id)
        ?.credentialState,
    ).toBe('device-session');
  });

  it('retires the displaced state once it has been used, so a later rejection re-derives', () => {
    // The recovery consumes the fact. A connection that is later un-paired
    // (its device session dropped for a saved bearer, then that bearer
    // removed) must not resurrect a device session the user has left behind.
    const storage = memoryAdapter();
    const store = new ConnectionStore({ storage });
    const connection = store.add('Station', LOOPBACK);
    store.setActive(connection.id);
    store.markDeviceSession(connection.id);
    reject(store, connection.id);
    store.recordAuthenticatedSuccess(
      connection.id,
      `${LOOPBACK}/api/settings`,
      store.credentialGeneration(connection.id),
    );
    expect(
      store.getAll().find((item) => item.id === connection.id)
        ?.displacedCredentialState,
    ).toBeUndefined();

    // A fresh rejection now displaces `device-session` again, and only
    // because the connection is genuinely in that state.
    reject(store, connection.id);
    expect(
      store.getAll().find((item) => item.id === connection.id)
        ?.displacedCredentialState,
    ).toBe('device-session');
    // A SECOND rejection displaces nothing and keeps the first one's fact.
    store.removeCredential(connection.id);
    expect(
      store.getAll().find((item) => item.id === connection.id)
        ?.displacedCredentialState,
    ).toBe('device-session');
  });

  it('a LOOPBACK connection that never needed credentials comes back as not-required', () => {
    const { store, id } = storeWith(LOOPBACK);
    reject(store, id);

    store.recordAuthenticatedSuccess(
      id,
      `${LOOPBACK}/api/settings`,
      store.credentialGeneration(id),
    );

    expect(
      store.getAll().find((entry) => entry.id === id)?.credentialState,
    ).toBe('not-required');
  });
});

describe('markCredentialRequired — a rejection is about the request that got it', () => {
  it('ignores a 401 whose generation was overtaken by a completed pairing', () => {
    // A device session has no credential VALUE, so the equality guard compares
    // `undefined` with `undefined` and cannot tell an obsolete rejection from a
    // current one. Without the generation, a 401 from a request that left
    // before the pairing deletes the session the pairing just established.
    const { store, id } = storeWith(REMOTE);
    reject(store, id);
    // Request A leaves here, carrying the unauthorized generation.
    const generationAtRequestStart = store.credentialGeneration(id);

    store.markDeviceSession(id);
    expect(store.getAll().find((item) => item.id === id)?.credentialState).toBe(
      'device-session',
    );
    const generationAfterPairing = store.credentialGeneration(id);

    store.markCredentialRequired(id, undefined, generationAtRequestStart);

    expect(store.getAll().find((item) => item.id === id)?.credentialState).toBe(
      'device-session',
    );
    // And the drop must be silent: bumping here would also invalidate the
    // paired device's FIRST request, which is typically already in flight.
    expect(store.credentialGeneration(id)).toBe(generationAfterPairing);
  });

  it("lets the paired device's first request recover after that dropped 401", () => {
    const { store, id } = storeWith(REMOTE);
    reject(store, id);
    // Request A leaves here, carrying the unauthorized generation.
    const generationAtRequestStart = store.credentialGeneration(id);
    // The health probe records its own evidence of the same outage.
    store.recordEndpointFailure(id, 'authentication-failed');

    store.markDeviceSession(id);
    // The paired device's FIRST request leaves now.
    const generationOfFirstPairedRequest = store.credentialGeneration(id);
    // A's obsolete 401 lands in between and must change nothing — including
    // the generation, or it would invalidate that first request too.
    store.markCredentialRequired(id, undefined, generationAtRequestStart);
    expect(store.credentialGeneration(id)).toBe(generationOfFirstPairedRequest);

    store.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/settings`,
      generationOfFirstPairedRequest,
    );

    const item = store.getAll().find((entry) => entry.id === id);
    expect(item?.lastError).toBeUndefined();
    expect(item?.credentialState).toBe('device-session');
  });

  it('still deletes a credential when the rejection is current', () => {
    const { store, id } = storeWith(REMOTE);
    store.setCredential(id, 'a-bearer-not-for-production');

    store.markCredentialRequired(
      id,
      'a-bearer-not-for-production',
      store.credentialGeneration(id),
    );

    expect(store.getCredential(id)).toBeNull();
    expect(store.getAll().find((item) => item.id === id)?.credentialState).toBe(
      'required',
    );
  });

  it('keeps working for a caller with no in-flight request to name', () => {
    // The UI's own "this credential is wrong" path supplies no generation.
    const { store, id } = storeWith(REMOTE);
    store.setCredential(id, 'a-bearer-not-for-production');

    store.markCredentialRequired(id, 'a-bearer-not-for-production');

    expect(store.getCredential(id)).toBeNull();
  });
});

describe('selectAccessMethod invalidates in-flight credential evidence', () => {
  it('drops a same-origin acceptance captured before the access method changed', () => {
    // The origin guard cannot see this one: the endpoint changes within the
    // same origin, so a stale response would reach `recordConnectionSuccess`
    // and reselect its own URL as the verified one.
    const { store, id } = storeWith(REMOTE);
    store.markDeviceSession(id);
    const generationAtRequestStart = store.credentialGeneration(id);
    reject(store, id);

    const method = store.getAll().find((item) => item.id === id)
      ?.selectedAccessMethodId as string;
    store.selectAccessMethod(id, method);

    store.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/settings`,
      generationAtRequestStart,
    );

    expect(store.getAll().find((item) => item.id === id)?.credentialState).toBe(
      'required',
    );
  });

  it('bumps the generation even when the selected method is unchanged', () => {
    const { store, id } = storeWith(REMOTE);
    const before = store.credentialGeneration(id);
    const method = store.getAll().find((item) => item.id === id)
      ?.selectedAccessMethodId as string;

    store.selectAccessMethod(id, method);

    expect(store.credentialGeneration(id)).not.toBe(before);
  });
});

describe('credential AUTHORITY is only regained where authority was lost', () => {
  it('a recovery from a TIMEOUT does not claim a credential started working', () => {
    // #3602 review, MEDIUM. An accepted response retires a stale `lastError`
    // whatever its reason, but a timeout says nothing about credentials —
    // and bumping authority for it wakes every parked SSE stream and blocked
    // supervisor on a fact that was never in doubt.
    const { store, id } = storeWith(REMOTE);
    store.markDeviceSession(id);
    const before = store.credentialAuthorityGeneration(id);
    store.recordEndpointFailure(id, 'timeout');

    store.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/settings`,
      store.credentialGeneration(id),
    );

    const recovered = store.getAll().find((item) => item.id === id);
    // The recovery still happened — this is about what it CLAIMS, not whether
    // it runs.
    expect(recovered?.lastError).toBeUndefined();
    expect(store.credentialAuthorityGeneration(id)).toBe(before);
  });

  it('a recovery from an AUTHENTICATION failure does', () => {
    const { store, id } = storeWith(REMOTE);
    store.markDeviceSession(id);
    const before = store.credentialAuthorityGeneration(id);
    store.recordEndpointFailure(id, 'authentication-failed');

    store.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/settings`,
      store.credentialGeneration(id),
    );

    expect(store.credentialAuthorityGeneration(id)).toBeGreaterThan(before);
  });

  it('a recovery from a rejected credential does, even with no recorded failure', () => {
    // The 401 path records `required` through the SDK reporter; the health
    // probe may never have run.
    const { store, id } = storeWith(REMOTE);
    store.markDeviceSession(id);
    reject(store, id);
    const before = store.credentialAuthorityGeneration(id);

    store.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/settings`,
      store.credentialGeneration(id),
    );

    expect(store.credentialAuthorityGeneration(id)).toBeGreaterThan(before);
  });
});

describe('a displaced credential state does not survive a change of subject', () => {
  const handshake = (environmentId: string) => ({
    environmentId,
    authentication: { scheme: 'bearer' as const, protocolVersion: 1 },
  });

  it('is cleared when the connection is bound to a server-owned identity', () => {
    // #3599 review, LOW. Binding gives the connection an identity and moves
    // its credential reference: a device session displaced before the bind is
    // provenance about the connection this WAS, and must not decide the
    // recovery of the one it became.
    const { store, id } = storeWith(LOOPBACK);
    store.markDeviceSession(id);
    reject(store, id);
    expect(
      store.getAll().find((item) => item.id === id)?.displacedCredentialState,
    ).toBe('device-session');

    const bound = store.reconcileHandshake(id, handshake('environment-1'));

    expect(bound?.displacedCredentialState).toBeUndefined();
    store.recordAuthenticatedSuccess(
      bound!.id,
      `${LOOPBACK}/api/settings`,
      store.credentialGeneration(bound!.id),
    );
    // Derived from the address it now has, not from the pre-bind pairing.
    expect(
      store.getAll().find((item) => item.id === bound!.id)?.credentialState,
    ).toBe('not-required');
  });

  it('is cleared when the connection is pointed at a different address', () => {
    const { store, id } = storeWith(LOOPBACK);
    store.markDeviceSession(id);
    reject(store, id);

    store.update(id, { url: 'http://127.0.0.1:4242' });

    expect(
      store.getAll().find((item) => item.id === id)?.displacedCredentialState,
    ).toBeUndefined();
  });

  it('survives a rename, which changes no subject', () => {
    const { store, id } = storeWith(LOOPBACK);
    store.markDeviceSession(id);
    reject(store, id);

    store.update(id, { name: 'Renamed' });

    expect(
      store.getAll().find((item) => item.id === id)?.displacedCredentialState,
    ).toBe('device-session');
  });
});
