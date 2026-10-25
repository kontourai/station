/** Streaming query/reply filter. Incomplete control strings never reach disk. */
export class TerminalOutputSanitizer {
  private pending = '';
  private state: 'text' | 'escape' | 'csi' | 'osc' | 'dcs' = 'text';
  private discarded = false;
  private surrogate = '';
  private previous = '';
  private stringEscape = false;

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
      if (this.stringEscape && char !== '\\') {
        this.pending = '\x1b';
        this.state = 'escape';
        this.discarded = false;
      }
      this.stringEscape = false;
      const previous = this.previous;
      this.previous = char;
      // VT parsers restart an escape sequence on ESC, and execute C0 inside
      // CSI without leaving it. Neither may hide a query from classification.
      if (
        char === '\x1b' &&
        (this.state === 'escape' || this.state === 'csi')
      ) {
        this.pending = char;
        this.state = 'escape';
        this.discarded = false;
        continue;
      }
      if (
        (this.state === 'csi' || this.state === 'escape') &&
        (char.charCodeAt(0) < 0x20 || char === '\x7f') &&
        char !== '\x18' &&
        char !== '\x1a'
      )
        continue;
      if (char === '\x1b' && (this.state === 'osc' || this.state === 'dcs'))
        this.stringEscape = true;
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
        if (!this.discarded && this.shouldStoreControl())
          output += this.pending;
        this.reset();
      } else if (
        (this.state === 'osc' && char === '\x07') ||
        char === '\x9c' ||
        (previous === '\x1b' && char === '\\')
      ) {
        if (!this.discarded && this.shouldStoreControl())
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
    this.stringEscape = false;
  }

  private body(): string {
    return this.pending.slice(this.pending.startsWith('\x1b') ? 2 : 1);
  }

  private shouldStoreControl(): boolean {
    const body = this.body()
      .split('')
      .filter((char) => char.charCodeAt(0) >= 0x20 && char !== '\x7f')
      .join('');
    if (this.state === 'csi')
      return !/^(?:[?>=]?[\d;]*[cnR]|[?\d;]*\$[py]|>\d*q|[?>=][\d;]*u)$/.test(
        body,
      );
    if (this.state === 'osc') {
      const command = body.split(';', 1)[0]!;
      return !(/^\d+$/.test(command) && [10, 11, 12].includes(Number(command)));
    }
    if (this.state === 'dcs')
      return !/^[\d;:?>=]*(?:>\||\$[qr]|\+[qr])/.test(body);
    return true;
  }
}
