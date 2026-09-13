// SDK calls run at the actual Station origin. Browser cookie handling stays native.
/** @param {{ operation: string, path?: string, body?: Record<string, unknown>, invitation?: string }} input */
export async function accountLabOperation({
  operation,
  path,
  body,
  invitation,
}) {
  const api = window.stationAccountLab;
  if (operation === 'descriptor')
    return api.getAccountAuthentication(location.origin);
  if (operation === 'session') return api.getAccountSession(location.origin);
  try {
    const result = await api.runAccountOperation(
      location.origin,
      path,
      body,
      invitation,
    );
    return { status: 200, result };
  } catch (error) {
    if (!Number.isInteger(error?.status)) throw error;
    return { status: error.status };
  }
}

export async function accountLabDeniedRead(path) {
  const response = await fetch(path, {
    credentials: 'include',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.text() };
}

export function accountLabReadableSessionCookie() {
  return document.cookie.includes('session_token');
}
