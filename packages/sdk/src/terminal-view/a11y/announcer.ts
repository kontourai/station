/**
 * Polite announcements for a terminal: new output, bell and exit. Output is
 * coalesced and rate-limited so a flooding command produces one short
 * summary per window instead of drowning the screen reader.
 */

export interface AnnouncerOptions {
  /** Minimum time between announcements, ms. */
  intervalMs?: number;
  /** Longest announcement, characters; longer output is summarized. */
  maxLength?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class Announcer {
  private readonly intervalMs: number;
  private readonly maxLength: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private pendingLines: string[] = [];
  private pendingEvents: string[] = [];
  private droppedLines = 0;
  private lastSpoken = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;

  constructor(
    private readonly speak: (text: string) => void,
    options: AnnouncerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 1000;
    this.maxLength = options.maxLength ?? 300;
    this.now = options.now ?? (() => performance.now());
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel =
      options.cancel ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** New output lines, as the emulator rows show them. */
  output(lines: readonly string[]): void {
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      if (this.pendingLines.join(' ').length + text.length > this.maxLength)
        this.droppedLines += 1;
      else this.pendingLines.push(text);
    }
    this.queue();
  }

  /** A discrete event (bell, exit). Never dropped; repeats coalesce. */
  event(text: string): void {
    if (!this.pendingEvents.includes(text)) this.pendingEvents.push(text);
    this.queue();
  }

  private queue(): void {
    if (this.timer !== null) return;
    const wait = Math.max(0, this.lastSpoken + this.intervalMs - this.now());
    this.timer = this.schedule(() => this.flush(), wait);
  }

  flush(): void {
    this.timer = null;
    const parts = [...this.pendingEvents];
    if (this.pendingLines.length) parts.push(this.pendingLines.join(' '));
    if (this.droppedLines)
      parts.push(
        `${this.droppedLines} more ${this.droppedLines === 1 ? 'line' : 'lines'}`,
      );
    this.pendingEvents = [];
    this.pendingLines = [];
    this.droppedLines = 0;
    if (!parts.length) return;
    this.lastSpoken = this.now();
    this.speak(parts.join('. '));
  }

  dispose(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }
}

/**
 * Lines that are new since the previous screen. The screen may have
 * scrolled by `s` rows; the shift that explains the most rows unchanged is
 * chosen, and only rows that differ under it are new. A redraw in place
 * announces only the rows it changed; scrolled output only what scrolled in.
 */
export function newLines(
  previous: readonly string[],
  next: readonly string[],
): string[] {
  const n = next.length;
  let bestShift = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let shift = 0; shift <= n; shift += 1) {
    let cost = shift;
    for (let i = 0; i < n - shift && cost < bestCost; i += 1)
      if (next[i] !== previous[i + shift]) cost += 1;
    if (cost < bestCost) {
      bestCost = cost;
      bestShift = shift;
    }
  }
  const changed: string[] = [];
  for (let i = 0; i < n - bestShift; i += 1)
    if (next[i] !== previous[i + bestShift]) changed.push(next[i]!);
  return [...changed, ...next.slice(n - bestShift)];
}
