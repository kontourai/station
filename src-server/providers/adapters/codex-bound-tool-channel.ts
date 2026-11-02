/** A single app-server's dynamic-tool admission, retired with its Session. */
export class CodexBoundToolChannel {
  private readonly calls = new Set<string>();
  private closed = false;

  constructor(
    private readonly threadId: string,
    private readonly names: ReadonlySet<string>,
    private readonly currentTurn: () => string | undefined,
    private readonly isCurrent: () => boolean,
  ) {}

  close(): void {
    this.closed = true;
  }

  async invoke<T>(
    call: { threadId: string; turnId: string; callId: string; name: string },
    approve: () => Promise<boolean>,
    execute: (current: () => boolean) => Promise<T>,
    invocationCurrent: () => boolean,
  ): Promise<T> {
    const current = () => {
      try {
        return (
          !this.closed &&
          this.isCurrent() &&
          invocationCurrent() &&
          call.threadId === this.threadId &&
          call.turnId === this.currentTurn() &&
          this.names.has(call.name)
        );
      } catch {
        return false;
      }
    };
    if (
      !current() ||
      !call.callId ||
      this.calls.has(call.callId) ||
      this.calls.size >= 4096
    )
      throw new Error('bound-tool-refused');
    this.calls.add(call.callId);
    if (!(await approve()) || !current()) throw new Error('bound-tool-refused');
    const result = await execute(current);
    if (!current()) throw new Error('bound-tool-refused');
    return result;
  }
}
