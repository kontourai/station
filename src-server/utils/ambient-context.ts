/**
 * Ambient chat context composition (archive#685).
 *
 * The UI sends ambient, model-facing context (timezone, geolocation, …)
 * out-of-band via an optional `ambientContext` field instead of splicing it
 * into the typed message. This is the single composition rule both server
 * send pipelines apply at their model-facing choke point:
 *
 * - orchestration `sendTurn` dispatch (`orchestration-service.ts`)
 * - the `/:slug/chat` route's model input assembly (`chat-context.ts`)
 *
 * The persisted/rendered user turn is always the typed content alone;
 * only the model-facing input carries the composed context.
 */
export function composeAmbientTurnText(
  ambientContext: string | null | undefined,
  text: string,
): string {
  if (!ambientContext?.trim()) {
    return text;
  }
  return `${ambientContext}\n${text}`;
}
