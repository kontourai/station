/**
 * Decide whether a send should carry ambient, model-facing context (#685).
 *
 * The composed context (timezone, geolocation, …) is delivered OUT-OF-BAND
 * via the send path's `ambientContext` field — never spliced into the typed
 * message — so the rendered and persisted user turn stays exactly what the
 * user typed.
 *
 * Short-circuits (kept from the original `handleSendWithContext` splice):
 * - `[`-prefixed input: legacy messages/markers that already carry a
 *   context-style prefix are sent untouched, with no extra context.
 * - `/`-prefixed input: slash commands (/mcp, /tools, …) route to the slash
 *   handler in `useSendMessage` and must not carry chat context.
 *
 * Returns the context string to attach, or undefined for a plain send.
 */
export function ambientContextForSend(
  composedContext: string | null | undefined,
  input: string,
): string | undefined {
  if (!composedContext || !input) {
    return undefined;
  }
  if (input.startsWith('[') || input.startsWith('/')) {
    return undefined;
  }
  return composedContext;
}
