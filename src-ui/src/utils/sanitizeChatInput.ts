/** Prevent user-authored text from being interpreted as a trusted system event. */
export function sanitizeChatInput(value: string): string {
  return value.replace(/\[SYSTEM_EVENT\]\s*/g, '');
}
