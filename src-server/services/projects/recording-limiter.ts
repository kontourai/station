export const TASK_RECORDING_MAX_ACTIVE = 4;
export const TASK_RECORDING_MAX_PER_OWNER = 2;

/** One runtime's active recording budget, shared by every recording source. */
export class RecordingLimiter {
  private readonly counts = new Map<string, number>();
  private active = 0;

  acquire(owner: string): (() => void) | undefined {
    const count = this.counts.get(owner) ?? 0;
    if (
      !owner ||
      this.active >= TASK_RECORDING_MAX_ACTIVE ||
      count >= TASK_RECORDING_MAX_PER_OWNER
    )
      return undefined;
    this.active++;
    this.counts.set(owner, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const left = (this.counts.get(owner) ?? 1) - 1;
      if (left) this.counts.set(owner, left);
      else this.counts.delete(owner);
    };
  }
}
