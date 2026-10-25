/** Streaming query/reply filter. Incomplete control strings never reach disk. */
export class TerminalOutputSanitizer {
  private pending = '';
  private state: 'text' | 'escape' | 'csi' | 'osc' | 'dcs' = 'text';
  private discarded = false;
  private surrogate = '';
  private previous = '';

  append(chunk: string): string {
    let input = this.surrogate + chunk;
    this.surrogate = '';
    if (/[\uD800-\uDBFF]$/.test(input)) {
      this.surrogate = input.slice(-1);
      input = input.slice(0, -1);
    }
    let output = '';
    for (const char of input) {
      if (this.state === 'text') {
        if (char === '\x1b' || '\x9b\x9d\x90'.includes(char)) {
          this.pending = char;
          this.state =
            char === '\x1b'
              ? 'escape'
              : char === '\x9b'
                ? 'csi'
                : char === '\x9d'
                  ? 'osc'
                  : 'dcs';
        } else output += char;
        continue;
      }
      const previous = this.previous;
      this.previous = char;
      if (!this.discarded) this.pending += char;
      if (this.pending.length > 4096) this.discarded = true;
      if (char === '\x18' || char === '\x1a') {
        this.reset();
      } else if (this.state === 'escape') {
        if (char === '[') this.state = 'csi';
        else if (char === ']') this.state = 'osc';
        else if (char === 'P') this.state = 'dcs';
        else {
          output += this.pending;
          this.reset();
        }
      } else if (this.state === 'csi' && /[\x40-\x7e]/.test(char)) {
        if (
          !this.discarded &&
          !/^(?:[?>=]?[\d;]*[cnR]|[?\d;]*\$[py]|>\d*q|[?>=][\d;]*u)$/.test(
            this.body(),
          )
        )
          output += this.pending;
        this.reset();
      } else if (
        (this.state === 'osc' && char === '\x07') ||
        char === '\x9c' ||
        (previous === '\x1b' && char === '\\')
      ) {
        if (
          !this.discarded &&
          !(this.state === 'osc' && /^(?:10|11|12);/.test(this.body())) &&
          !(this.state === 'dcs' && this.body().startsWith('>|'))
        )
          output += this.pending;
        this.reset();
      }
    }
    return Buffer.from(output).toString('utf8');
  }

  private reset(): void {
    this.pending = '';
    this.state = 'text';
    this.discarded = false;
    this.previous = '';
  }

  private body(): string {
    return this.pending.slice(this.pending.startsWith('\x1b') ? 2 : 1);
  }
}
