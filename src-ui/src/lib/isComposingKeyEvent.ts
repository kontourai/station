type CompositionKeyEvent = {
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
};

/** Returns true while an IME is using the key event to confirm composition. */
export function isComposingKeyEvent(event: CompositionKeyEvent): boolean {
  return event.nativeEvent?.isComposing === true || event.keyCode === 229;
}
