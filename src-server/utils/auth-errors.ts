/**
 * Auth error detection utility
 */

const AUTH_ERROR_PATTERNS = [
  'authentication failed',
  'status code 403',
  'Request failed with status code 403',
  '401',
  'unauthorized',
];

export function isAuthError(error: string | Error | unknown): boolean {
  const errorMsg =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error);

  const lowerMsg = errorMsg.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((pattern) =>
    lowerMsg.includes(pattern.toLowerCase()),
  );
}
