import './ConversationLoadingStage.css';

/**
 * The step a conversation's first load is on, each one named only by the read
 * that is actually in flight (ConversationBody's `loadingStep`): the open point-read, the transcript's first read, or a
 * catch-up refetch.
 */
export type ConversationLoadingStep =
  | 'opening'
  | 'reading'
  | 'catching-up'
  | 'rendering';

const STEP_TEXT: Record<ConversationLoadingStep, string> = {
  opening: 'Opening conversation',
  reading: 'Loading messages',
  'catching-up': 'Catching up',
  rendering: 'Preparing messages',
};

export function conversationLoadingStepText(
  step: ConversationLoadingStep,
): string {
  return STEP_TEXT[step];
}

/** The long-wait sentence, shared by the stage and the dock's announcer. */
export function conversationLoadingLongText(stationName?: string): string {
  return `Taking longer than usual. Waiting on ${stationName?.trim() || 'Station'}.`;
}

/**
 * The launch splash's idea at the size of a transcript: the Station mark and
 * one status line saying which step the load is on, with "taking longer" as
 * just another, quieter step rather than an alarm row under the composer.
 *
 * The whole stage fades in after a short delay (CSS), so a load that lands in
 * the ordinary fraction of a second paints nothing between the click and the
 * rows. Its words are `aria-hidden`: the dock's one persistent announcement
 * region speaks them, and the filler this sits in is itself a status region,
 * so visible copy here would be announced twice.
 */
export function ConversationLoadingStage({
  step,
  long = false,
  stationName,
}: {
  step: ConversationLoadingStep;
  /** The load has run past `loadingEscapeDelayMs`. */
  long?: boolean;
  stationName?: string;
}) {
  const text = conversationLoadingStepText(step);
  return (
    <div className="conversation-loading" data-step={step}>
      <img
        className="conversation-loading__mark"
        src="/favicon.png"
        alt=""
        width="32"
        height="32"
      />
      {/* Keyed on the step, so each new step plays the splash's entrance. */}
      <p key={text} className="conversation-loading__step" aria-hidden="true">
        {text}
      </p>
      {/* Always present, so the mark and step stay put when the long wait
          begins; only its words fade in. */}
      <p
        key={long ? 'long' : 'waiting'}
        className="conversation-loading__long"
        aria-hidden="true"
      >
        {long ? conversationLoadingLongText(stationName) : null}
      </p>
    </div>
  );
}
