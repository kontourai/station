/**
 * How streamed answer text reaches the screen on this device (#585, epic
 * #2144 slice 6 item B).
 *
 * `smoothReveal` owns paint pacing. `bufferedDelivery` owns when this device
 * applies canonical deltas to its chat projection. Keeping both in the
 * device store lets two viewers choose independently without changing the
 * durable event stream they share.
 */

export type AnswerDeliveryMode = 'token' | 'smooth' | 'buffered';

export const ANSWER_DELIVERY_OPTIONS = [
  { value: 'token', label: 'Show text as it arrives' },
  { value: 'smooth', label: 'Reveal text at a steady pace' },
  { value: 'buffered', label: 'Show text at action boundaries' },
] as const satisfies readonly { value: AnswerDeliveryMode; label: string }[];

/** The mode the stored boolean means. Absent reads as `token` — the default. */
export function answerDeliveryModeOf(
  smoothReveal: boolean | undefined,
  bufferedDelivery: boolean | undefined,
): AnswerDeliveryMode {
  // Imported settings from a newer/older build can contain both. Buffered
  // wins because it is the stronger delivery constraint; the next explicit
  // selection normalizes the pair.
  if (bufferedDelivery === true) return 'buffered';
  return smoothReveal === true ? 'smooth' : 'token';
}

/**
 * The boolean a picked mode stores. Both directions live here so a surface
 * cannot invent its own mapping — the Settings row and the chat panel write
 * the same key with the same meaning.
 */
export function settingsForAnswerDelivery(mode: AnswerDeliveryMode) {
  return {
    smoothReveal: mode === 'smooth',
    bufferedDelivery: mode === 'buffered',
  };
}
