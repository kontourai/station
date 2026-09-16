/**
 * How streamed answer text reaches the screen on this device (#585, epic
 * #2144 slice 6 item B).
 *
 * This is a PRESENTATION of the existing `featureSettings.smoothReveal`
 * boolean, not a new setting: the consumer is unchanged
 * (`ChatMessageList.tsx` picks the steady-cadence streaming message
 * component when the boolean is true). Two surfaces render it — the
 * Appearance row in Settings and the in-chat gear panel — and they used to
 * carry two independently written toggles labelled "Smooth answer reveal",
 * which named the mechanism rather than the choice and left "off" unnamed
 * entirely. Naming both ends is the whole change.
 *
 * `'paragraph'` is deliberately NOT here. #585 sketches it, but nothing on
 * the client can deliver it — a third option would be a control with no
 * consumer, which is exactly what this slice's audit excluded. It stays on
 * #585 until a consumer exists.
 */

export type AnswerDeliveryMode = 'token' | 'smooth';

export const ANSWER_DELIVERY_OPTIONS = [
  { value: 'token', label: 'Show text as it arrives' },
  { value: 'smooth', label: 'Reveal text at a steady pace' },
] as const satisfies readonly { value: AnswerDeliveryMode; label: string }[];

export function isAnswerDeliveryMode(
  value: unknown,
): value is AnswerDeliveryMode {
  return value === 'token' || value === 'smooth';
}

/** The mode the stored boolean means. Absent reads as `token` — the default. */
export function answerDeliveryModeOf(
  smoothReveal: boolean | undefined,
): AnswerDeliveryMode {
  return smoothReveal === true ? 'smooth' : 'token';
}

/**
 * The boolean a picked mode stores. Both directions live here so a surface
 * cannot invent its own mapping — the Settings row and the chat panel write
 * the same key with the same meaning.
 */
export function smoothRevealForAnswerDelivery(mode: AnswerDeliveryMode) {
  return mode === 'smooth';
}
