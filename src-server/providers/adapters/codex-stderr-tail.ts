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
 * Secrets: each line is redacted before it is cut to length, so a cut can
 * never leave the start of a key a pattern would have recognized whole. A
 * PEM block (`-----BEGIN …-----` to `-----END …-----`) is kept as one
 * marker and its body lines are never kept or logged; an END whose BEGIN
 * was never seen (cut off a long line) takes the base64 lines just above it
 * out of the tail with it, though they were already logged at debug level.
 */

/** Characters of stderr kept, newest last. */
export const CODEX_STDERR_TAIL_MAX_CHARS = 2048;
/** A longer single line is cut before it is kept or logged. */
const CODEX_STDERR_LINE_MAX_CHARS = 1024;
/**
 * A line is bounded to this before it is redacted, so a pathological line
 * costs bounded work. Far past the kept length: only a line holding more
 * redacted text than this could bring a fragment cut here into what is kept.
 */
const CODEX_STDERR_REDACT_MAX_CHARS = 64 * 1024;

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]+-----/;
const PEM_END = /-----END [A-Z0-9 ]+-----/;
/** A PEM body line: base64 only. */
const PEM_BODY_LINE = /^[A-Za-z0-9+/=]{16,}$/;
const PEM_REDACTED = '[REDACTED PEM BLOCK]';

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

/** One stderr line as Station keeps it: no escapes, redacted, bounded; empty when blank. */
export function cleanCodexDiagnosticLine(line: string): string {
  const plain = line
    .replace(ANSI_ESCAPE_SEQUENCE, '')
    .replace(CONTROL_CHARACTERS, '')
    .trim();
  if (!plain) return '';
  // Redacted before the cut: a key the cut split would no longer match.
  const redacted = redactSecrets(plain.slice(0, CODEX_STDERR_REDACT_MAX_CHARS));
  return redacted.length > CODEX_STDERR_LINE_MAX_CHARS ||
    plain.length > CODEX_STDERR_REDACT_MAX_CHARS
    ? `${redacted.slice(0, CODEX_STDERR_LINE_MAX_CHARS)}…`
    : redacted;
}

function joinParts(...parts: string[]): string {
  return parts.filter(Boolean).join(' ');
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export class CodexStderrTail {
  private lines: string[] = [];
  private chars = 0;
  private inPem = false;
  private readonly reported: string[] = [];

  /** Keeps a cleaned line; returns it, or '' for a blank or withheld one. */
  push(raw: string): string {
    const line = this.withoutPem(cleanCodexDiagnosticLine(raw));
    if (!line) return '';
    this.lines.push(line);
    this.chars += line.length + 1;
    while (this.chars > CODEX_STDERR_TAIL_MAX_CHARS && this.lines.length > 1) {
      this.chars -= (this.lines.shift() ?? '').length + 1;
    }
    return line;
  }

  /** `line` with any PEM block in it, or a body line, withheld. */
  private withoutPem(line: string): string {
    if (!line) return '';
    if (this.inPem) {
      const end = PEM_END.exec(line);
      if (!end) return '';
      this.inPem = false;
      return line.slice(end.index + end[0].length).trim();
    }
    const begin = PEM_BEGIN.exec(line);
    if (begin) {
      const before = line.slice(0, begin.index).trim();
      const rest = line.slice(begin.index + begin[0].length);
      const end = PEM_END.exec(rest);
      if (!end) {
        this.inPem = true;
        return joinParts(before, PEM_REDACTED);
      }
      return joinParts(
        before,
        PEM_REDACTED,
        rest.slice(end.index + end[0].length).trim(),
      );
    }
    const end = PEM_END.exec(line);
    if (!end) return line;
    // An END whose BEGIN was never seen: the body lines above it are its.
    while (PEM_BODY_LINE.test(this.lines.at(-1) ?? '')) {
      this.chars -= (this.lines.pop() ?? '').length + 1;
    }
    return joinParts(
      line.slice(0, end.index).trim(),
      PEM_REDACTED,
      line.slice(end.index + end[0].length).trim(),
    );
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
