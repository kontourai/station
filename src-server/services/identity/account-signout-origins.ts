import { DEPLOYMENT_AUTHENTICATION_BASE_PATH } from '@kontourai/station-contracts/deployment-authentication';
import { isStationNativeShellOrigin } from '@kontourai/station-shared/native-shell-origin';

/** Only a configured Station browser origin can request the local account sign-out exception. */
export function localAccountSignOutOrigin(
  request: Request,
  allowedOrigins: readonly string[],
): string | undefined {
  if (
    request.method !== 'POST' ||
    new URL(request.url).pathname !==
      `${DEPLOYMENT_AUTHENTICATION_BASE_PATH}/sign-out`
  )
    return undefined;
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins.includes(origin)) return undefined;
  if (isStationNativeShellOrigin(origin)) return origin;
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.origin !== origin
    )
      return undefined;
  } catch {
    return undefined;
  }
  return origin;
}
