import { redactSecrets } from '@kontourai/station-shared/redaction';

/**
 * What Station keeps of a Codex app-server's stderr: a bounded, redacted,
 * ANSI-stripped tail held in memory, never a live event per line.
 *
 * Codex writes diagnostics to stderr that are not failures: an inherited
 * `RUST_LOG=info` gives dozens of INFO lines, and an untrusted project
 * folder gives one multi-line ERROR block that restates the `configWarning`
 * notification it also sends on stdout. Each line goes to the server log at
 * debug level; the tail is shown only when it can explain a failure (the
 * app-server exiting at startup or mid-turn). Mirrors Claude's `stderrTail`
 * (`claude-code-spawn.ts`).
 */

/** Characters of stderr kept, newest last. */
export const CODEX_STDERR_TAIL_MAX_CHARS = 2048;
/** A longer single line is cut before it is kept or logged. */
const CODEX_STDERR_LINE_MAX_CHARS = 1024;

const ESC = String.fromCharCode(0x1b);
/** CSI and two-character escape sequences (colour, cursor), as terminals emit them. */
const ANSI_ESCAPE_SEQUENCE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|[@-_][0-?]*[ -/]*[@-~])`,
  'g',
);
/** Remaining C0 controls except tab. */
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

/** One stderr line as Station keeps it: no escapes, redacted, bounded; empty when blank. */
export function cleanCodexDiagnosticLine(line: string): string {
  const plain = line
    .replace(ANSI_ESCAPE_SEQUENCE, '')
    .replace(CONTROL_CHARACTERS, '')
    .trim();
  if (!plain) return '';
  const cut =
    plain.length > CODEX_STDERR_LINE_MAX_CHARS
      ? `${plain.slice(0, CODEX_STDERR_LINE_MAX_CHARS)}…`
      : plain;
  return redactSecrets(cut);
}

export class CodexStderrTail {
  private lines: string[] = [];
  private chars = 0;

  /** Keeps a cleaned line; returns it, or '' for a blank one. */
  push(raw: string): string {
    const line = cleanCodexDiagnosticLine(raw);
    if (!line) return '';
    this.lines.push(line);
    this.chars += line.length + 1;
    while (this.chars > CODEX_STDERR_TAIL_MAX_CHARS && this.lines.length > 1) {
      this.chars -= (this.lines.shift() ?? '').length + 1;
    }
    return line;
  }

  /** The kept tail, oldest line first; empty when nothing was written. */
  text(): string {
    // Redacted again whole: a secret can span the lines it was split into.
    const joined = redactSecrets(this.lines.join('\n'));
    return joined.length > CODEX_STDERR_TAIL_MAX_CHARS
      ? joined.slice(-CODEX_STDERR_TAIL_MAX_CHARS)
      : joined;
  }
}

/** `detail`, followed on its own line by the stderr tail when there is one. */
export function withCodexStderrTail(detail: string, tail: string): string {
  return tail ? `${detail}\nstderr: ${tail}` : detail;
}
