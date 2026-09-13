/**
 * `error instanceof Error ? error.message : String(error)`, which src-server
 * had written inline ~170 times and wrapped in seven differently-named private
 * helpers (`errorMessage`, `errorText`, `messageOf`, `message`).
 *
 * This is NOT the `errorMessage` exported by `routes/schemas/schema-validation.ts`.
 * That one sanitizes the message and answers a fixed `'Request failed'` for a
 * non-Error, because it feeds HTTP responses. This one is the verbatim
 * rendering used for logs, telemetry attributes and internal diagnostics, and
 * it must not be substituted for the route-seam one.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
