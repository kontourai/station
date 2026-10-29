import { redactSecrets } from '@kontourai/station-shared/redaction';

/**
 * What Station keeps of a Codex app-server's stderr: a bounded, redacted,
 * ANSI-stripped tail held in memory, never a live event per line.
 *
 * Codex writes diagnostics to stderr that are not failures: an inherited
 * `RUST_LOG=info` gives dozens of INFO lines, and an untrusted project
 * folder gives one multi-line ERROR block that restates the `configWarning`
 * notification it also sends on stdout. Each line goes to the server log at
 * debug level. The whole tail goes with a failure as its diagnostics (the
 * app-server exiting at startup or mid-turn); the failure's own text quotes
 * only the newest ERROR line that was not already reported as a
 * `configWarning` (`lastErrorLine`). Mirrors Claude's `stderrTail`
 * (`claude-code-spawn.ts`).
 *
 * Each line is redacted before truncation. A bounded PEM context withholds
 * short body lines, while orphaned key-like tokens are filtered independently.

 */

/** Characters of stderr kept, newest last. */
export const CODEX_STDERR_TAIL_MAX_CHARS = 2048;
/** A longer single line is cut before it is kept or logged. */
const CODEX_STDERR_LINE_MAX_CHARS = 1024;
// Long base64-like runs and padded short body lines are withheld even when
// the surrounding PEM delimiters were never observed.
const KEY_MATERIAL = /[A-Za-z0-9+/=]{32,}/g;
const PADDED_BODY_LINE = /^[A-Za-z0-9+/]+={1,2}$/;

/**
 * A tracing ERROR line (`<time> ERROR <target>: <message>`) or a CLI's own
 * `Error:` / `error:` line, or a Rust panic.
 */
const ERROR_LINE =
  /(?:^|\s)ERROR\s|^(?:error|fatal)(?:\[[^\]]*\])?:|panicked at/i;
/** The message of a tracing line, after its `target:`. */
const TRACING_MESSAGE = /\sERROR\s+[\w:]+:\s*(.*)$/;

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

/** A stderr line without escapes or controls. */
function plainLine(line: string): string {
  return line
    .replace(ANSI_ESCAPE_SEQUENCE, '')
    .replace(CONTROL_CHARACTERS, '')
    .trim();
}

/** One stderr line as Station keeps it: no escapes, redacted, bounded; empty when blank. */
export function cleanCodexDiagnosticLine(line: string): string {
  return boundedLine(plainLine(line));
}

/** A plain line redacted, then cut to the kept length. */
function boundedLine(plain: string): string {
  if (!plain) return '';
  const redacted = redactSecrets(plain);
  if (/-----BEGIN|-----END/.test(plain) || PADDED_BODY_LINE.test(plain))
    return '';
  const safe = redacted.replace(/\S+/g, (token) => {
    if (
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(token) ||
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(token) ||
      /^(?:\/|\.\/)/.test(token) ||
      /\/[^\s/]+\.[A-Za-z0-9]+(?::\d+)?$/.test(token)
    )
      return token;
    return token.replace(KEY_MATERIAL, '[REDACTED]');
  });
  return safe.length > CODEX_STDERR_LINE_MAX_CHARS
    ? `${safe.slice(0, CODEX_STDERR_LINE_MAX_CHARS)}…`
    : safe;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export class CodexStderrTail {
  private lines: string[] = [];
  private chars = 0;
  private pemLines = 0;
  private readonly reported: string[] = [];

  /** Keeps a cleaned line; returns it, or '' for a blank or withheld one. */
  push(raw: string): string {
    const plain = plainLine(raw);
    if (/-----END/.test(plain)) {
      this.pemLines = 0;
      return '';
    }
    if (/-----BEGIN/.test(plain)) {
      this.pemLines = 200;
      return '';
    }
    if (this.pemLines > 0) {
      if (/^[A-Za-z0-9+/=]+$/.test(plain)) {
        this.pemLines -= 1;
        return '';
      }
      this.pemLines = 0;
    }
    const line = boundedLine(plain);
    if (!line) return '';
    this.lines.push(line);
    this.chars += line.length + 1;
    while (this.chars > CODEX_STDERR_TAIL_MAX_CHARS && this.lines.length > 1) {
      this.chars -= (this.lines.shift() ?? '').length + 1;
    }
    return line;
  }

  /** Notes text already shown to the user (a `configWarning`). */
  noteReported(text: string | undefined): void {
    if (text) this.reported.push(normalized(text));
  }

  /**
   * The newest ERROR line kept, unless it only restates something already
   * reported; undefined when there is none.
   */
  lastErrorLine(): string | undefined {
    for (let index = this.lines.length - 1; index >= 0; index -= 1) {
      const line = this.lines[index] ?? '';
      if (!ERROR_LINE.test(line)) continue;
      const message = normalized(TRACING_MESSAGE.exec(line)?.[1] ?? line);
      if (message && this.reported.some((text) => text.includes(message)))
        continue;
      return line;
    }
    return undefined;
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

/** `detail`, followed on its own line by a stderr line when there is one. */
export function withCodexStderrLine(
  detail: string,
  line: string | undefined,
): string {
  return line ? `${detail}\nstderr: ${line}` : detail;
}
