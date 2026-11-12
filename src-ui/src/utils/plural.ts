/** "1 check", "3 checks": a count with its regular English noun. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
