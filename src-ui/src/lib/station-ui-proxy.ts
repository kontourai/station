/**
 * The UI process stays alive while its sibling Station host is restarting and
 * answers API requests with this exact, documented readiness envelope. The
 * status alone is not enough: an arbitrary 503 remains an unknown responder.
 */
export async function isStationUiProxyUnavailableResponse(
  response: Response,
): Promise<boolean> {
  if (response.status !== 503) return false;
  try {
    const body = (await response.clone().json()) as {
      ready?: unknown;
      status?: unknown;
    };
    return body.ready === false && body.status === 'unavailable';
  } catch {
    return false;
  }
}
