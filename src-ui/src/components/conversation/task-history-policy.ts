/** A denied history read invalidates previously admitted records. */
export function taskHistoryReadDenied(error: unknown) {
  return (
    error instanceof Error &&
    'status' in error &&
    typeof error.status === 'number' &&
    [401, 403, 404].includes(error.status)
  );
}
