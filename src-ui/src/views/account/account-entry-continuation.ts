export const INVITATION_STATE_KEY = 'station-pending-project-invitation';
export function readAccountEntryContinuation() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const provided = fragment.get('invitation');
  let invitation: string | undefined;
  if (provided && /^[A-Za-z0-9_-]{43}$/.test(provided)) {
    invitation = provided;
    try {
      sessionStorage.setItem(
        INVITATION_STATE_KEY,
        JSON.stringify({ token: provided, until: Date.now() + 3600_000 }),
      );
    } catch {
      /* The open page still carries this in memory. */
    }
  } else if (provided !== null) {
    // An invalid new link must never silently select a previous invitation.
    try {
      sessionStorage.removeItem(INVITATION_STATE_KEY);
    } catch {
      /* There is no invitation in this page's state. */
    }
  } else {
    try {
      const stored = JSON.parse(
        sessionStorage.getItem(INVITATION_STATE_KEY) ?? 'null',
      ) as unknown;
      if (
        stored &&
        typeof stored === 'object' &&
        'token' in stored &&
        'until' in stored &&
        typeof stored.token === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(stored.token) &&
        typeof stored.until === 'number' &&
        stored.until > Date.now()
      )
        invitation = stored.token;
      else sessionStorage.removeItem(INVITATION_STATE_KEY);
    } catch {
      /* Local continuation state is not authority. */
    }
  }
  const candidate =
    window.location.pathname === '/account/reset'
      ? fragment.get('token')
      : undefined;
  const resetToken =
    candidate && /^[A-Za-z0-9_-]{16,256}$/.test(candidate)
      ? candidate
      : undefined;
  if (provided || candidate)
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    );
  return { invitation, resetToken };
}
