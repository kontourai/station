export const ROUTE_JSON_MAX_BYTES = 2 * 1024 * 1024;

export function assertBoundedJsonResponse<T>(payload: T, label: string): T {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > ROUTE_JSON_MAX_BYTES) {
    throw new Error(`${label} exceeded the response byte limit.`);
  }
  return payload;
}
