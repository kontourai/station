export const INVITATION_STATE_KEY = 'station-pending-project-invitation';
export interface SharedWorkDestination {
  projectId: string;
  shareId?: string;
}

function boundedId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    ? value
    : undefined;
}

export function rememberSharedWork(destination?: SharedWorkDestination) {
  const fragment = new URLSearchParams();
  if (destination) fragment.set('project', destination.projectId);
  if (destination?.shareId) fragment.set('share', destination.shareId);
  window.history.replaceState(
    window.history.state,
    '',
    `/account${fragment.size ? `#${fragment}` : ''}`,
  );
}

export function readAccountEntryContinuation() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const query = new URLSearchParams(window.location.search);
  const authenticationError =
    window.location.pathname === '/account' && query.has('error');
  if (authenticationError) {
    query.delete('error');
    query.delete('error_description');
    query.delete('error_uri');
  }
  const provided = fragment.get('invitation');
  let invitation: string | undefined;
  let shareId = boundedId(fragment.get('share'));
  if (provided && /^[A-Za-z0-9_-]{43}$/.test(provided)) {
    invitation = provided;
    try {
      sessionStorage.setItem(
        INVITATION_STATE_KEY,
        JSON.stringify({
          token: provided,
          shareId,
          until: Date.now() + 3600_000,
        }),
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
      ) {
        invitation = stored.token;
        shareId = boundedId('shareId' in stored ? stored.shareId : undefined);
      } else sessionStorage.removeItem(INVITATION_STATE_KEY);
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
  if (provided || candidate || authenticationError)
    window.history.replaceState(
      null,
      '',
      window.location.pathname + (query.toString() ? `?${query}` : ''),
    );
  const projectId =
    !invitation && provided === null && window.location.pathname === '/account'
      ? boundedId(fragment.get('project'))
      : undefined;
  return {
    ...(invitation && shareId ? { invitationShareId: shareId } : {}),
    ...(projectId ? { destination: { projectId, shareId } } : {}),
    invitation,
    resetToken,
    ...(authenticationError ? { authenticationError: true } : {}),
    ...(provided !== null && !invitation ? { invalidInvitation: true } : {}),
  };
}

/** An older acceptance must not erase a newer link received while it was pending. */
export function clearAccountEntryContinuation(invitation: string): void {
  try {
    const stored = JSON.parse(
      sessionStorage.getItem(INVITATION_STATE_KEY) ?? 'null',
    ) as unknown;
    if (
      stored &&
      typeof stored === 'object' &&
      'token' in stored &&
      stored.token === invitation
    )
      sessionStorage.removeItem(INVITATION_STATE_KEY);
  } catch {
    /* Page-local continuation state is not authority. */
  }
}
