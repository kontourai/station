type ControlState = 'text' | 'escape' | 'csi' | 'osc' | 'dcs' | 'ignored';

/** Streaming replay filter. Only known rendering controls are journaled. */
export class TerminalOutputSanitizer {
  private pending = '';
  private state: ControlState = 'text';
  private discarded = false;
  private surrogate = '';
  private stringEscape = false;

  constructor(private readonly hyperlinkProtocols?: readonly string[]) {}

  /** Speculate on one output record without spending credit or parser state. */
  fork(): TerminalOutputSanitizer {
    return Object.assign(
      new TerminalOutputSanitizer(this.hyperlinkProtocols),
      this,
    );
  }

  append(chunk: string): string {
    let input = this.surrogate + chunk;
    this.surrogate = '';
    if (/[\uD800-\uDBFF]$/.test(input)) {
      this.surrogate = input.slice(-1);
      input = input.slice(0, -1);
    }
    let output = '';
    for (const char of input) {
      const point = char.charCodeAt(0);
      // C1 introducers cancel pending sequences too, including other CSI/OSC.
      if (point >= 0x80 && point <= 0x9f) {
        if (char === '\x9c') {
          this.push(char);
          if (this.state === 'osc' && this.shouldStoreControl())
            output += this.pending;
          this.reset();
        } else if ('\x90\x98\x9b\x9d\x9e\x9f'.includes(char)) {
          this.begin(
            char === '\x9b'
              ? 'csi'
              : char === '\x9d'
                ? 'osc'
                : char === '\x90'
                  ? 'dcs'
                  : 'ignored',
            char,
          );
        } else {
          this.reset();
          if ('\x84\x85\x88\x8d\x8e\x8f'.includes(char)) output += char;
        }
        continue;
      }
      if (char === '\x18' || char === '\x1a') {
        this.reset();
        continue;
      }
      if (char === '\x05') continue;
      if (this.stringEscape) {
        this.stringEscape = false;
        if (char === '\\') {
          this.push(char);
          if (this.shouldStoreControl()) output += this.pending;
          this.reset();
          continue;
        }
        this.begin('escape', '\x1b');
      }
      if (char === '\x1b') {
        if (
          this.state === 'osc' ||
          this.state === 'dcs' ||
          this.state === 'ignored'
        ) {
          this.push(char);
          this.stringEscape = true;
        } else this.begin('escape', char);
        continue;
      }
      if (this.state === 'text') {
        output += char;
        continue;
      }
      if (
        (this.state === 'escape' || this.state === 'csi') &&
        (point < 0x20 || point === 0x7f)
      )
        continue;
      this.push(char);
      if (this.state === 'escape') {
        if (this.pending.length === 2 && '[]PX^_'.includes(char)) {
          this.state =
            char === '['
              ? 'csi'
              : char === ']'
                ? 'osc'
                : char === 'P'
                  ? 'dcs'
                  : 'ignored';
        } else if (point >= 0x30 && point <= 0x7e) {
          if (!this.discarded && this.shouldStoreEscape())
            output += this.pending;
          this.reset();
        }
      } else if (this.state === 'csi' && point >= 0x40 && point <= 0x7e) {
        if (this.shouldStoreControl()) output += this.pending;
        this.reset();
      } else if (this.state === 'osc' && char === '\x07') {
        if (this.shouldStoreControl()) output += this.pending;
        this.reset();
      }
    }
    return Buffer.from(output).toString('utf8');
  }

  private begin(state: ControlState, introducer: string): void {
    this.reset();
    this.state = state;
    this.pending = introducer;
  }

  private reset(): void {
    this.pending = '';
    this.state = 'text';
    this.discarded = false;
    this.stringEscape = false;
  }

  private push(char: string): void {
    if (!this.discarded) this.pending += char;
    if (this.pending.length > 4096) this.discarded = true;
  }

  private shouldStoreControl(): boolean {
    if (this.discarded) return false;
    const body = this.pending.slice(this.pending.startsWith('\x1b') ? 2 : 1);
    if (this.state === 'csi') {
      // Cursor movement, editing, scrolling, SGR and ordinary mode changes.
      // Private queries and unsupported control functions fail closed.
      return (
        /^[\d;:]*[@A-HI-MPSTXZ`abdefghlmrsu]$/.test(body) ||
        /^\?[\d;:]*[hl]$/.test(body) ||
        /^[\d;:]* q$/.test(body)
      );
    }
    if (this.state === 'osc') {
      const command = body
        .split(';', 1)[0]!
        .split('')
        .filter((char) => char.charCodeAt(0) >= 0x20 && char !== '\x7f')
        .join('');
      // Titles and hyperlinks have no terminal reply path. Color, clipboard,
      // graphics and extension strings are omitted until explicitly supported.
      if (Number(command) === 8 && this.hyperlinkProtocols) {
        const end = body.endsWith('\x1b\\') ? 2 : 1;
        const content = body.slice(0, -end);
        const uriStart = content.indexOf(';', content.indexOf(';') + 1);
        if (uriStart < 0) return false;
        const uri = content.slice(uriStart + 1);
        if (!uri) return true;
        for (const char of uri) {
          const point = char.charCodeAt(0);
          if (point <= 0x20 || (point >= 0x7f && point <= 0x9f)) return false;
        }
        try {
          return this.hyperlinkProtocols.includes(new URL(uri).protocol);
        } catch {
          return false;
        }
      }
      return /^\d+$/.test(command) && [0, 1, 2, 8].includes(Number(command));
    }
    return false;
  }

  private shouldStoreEscape(): boolean {
    return /^(?:[78DEHM=>c]|[()*+\-./][0-~]|#8)$/.test(this.pending.slice(1));
  }
}
