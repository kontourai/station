/** Keep transient cards readable; overflow is linked to notification history. */
const TOAST_STACK_VISIBLE_CAP = 3;

export function selectToastStackItems<T>(items: readonly T[]): T[] {
  return items.slice(0, TOAST_STACK_VISIBLE_CAP);
}
