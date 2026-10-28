/**
 * #4266: what Station keeps of a Codex app-server's stderr never holds a
 * secret a whole-line pattern would have caught, nor a PEM body, and a
 * failure's text quotes one ERROR line that was not already reported.
 */
import { describe, expect, test } from 'vitest';
import {
  CodexStderrTail,
  cleanCodexDiagnosticLine,
} from '../adapters/codex-stderr-tail.js';

const KEY = `sk-proj-${'A'.repeat(60)}`;
// Fixture-only base64 shaped like a PEM body line; it decodes to no key.
const BODY = 'c3RhdGlvbi10ZXN0LWZpeHR1cmUtbm90LWEta2V5LWF0LWFsbC0wMTIzNDU2Nzg5';

describe('cleanCodexDiagnosticLine', () => {
  test('redacts a key the length cut would have split', () => {
    // The key starts 15 characters before the 1024-character cut.
    const line = `${'x'.repeat(1004)} key=${KEY}`;
    const cleaned = cleanCodexDiagnosticLine(line);
    expect(cleaned).not.toContain('sk-proj');
    expect(cleaned).not.toContain('AAAA');
    expect(cleaned).toContain('[REDACTED]');
  });
});

describe('CodexStderrTail', () => {
  test('keeps a PEM block as one marker, never its body', () => {
    const tail = new CodexStderrTail();
    const logged = [
      'loading identity',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      BODY,
      BODY,
      '-----END OPENSSH PRIVATE KEY-----',
      'continuing',
    ].map((line) => tail.push(line));
    expect(tail.text()).toBe(
      'loading identity\n[REDACTED PEM BLOCK]\ncontinuing',
    );
    // What is logged at debug level is what is kept: no body line.
    expect(logged.join('\n')).not.toContain(BODY);
  });

  test('a block on one line is kept as the marker with what surrounds it', () => {
    const tail = new CodexStderrTail();
    tail.push(
      `bad key -----BEGIN RSA PRIVATE KEY----- ${BODY} -----END RSA PRIVATE KEY----- rejected`,
    );
    expect(tail.text()).toBe('bad key [REDACTED PEM BLOCK] rejected');
  });

  test('an END whose BEGIN was never seen takes the body lines above it', () => {
    const tail = new CodexStderrTail();
    // The BEGIN sat past the cut of a long line, so it was never seen.
    tail.push(`${'x'.repeat(1100)} -----BEGIN EC PRIVATE KEY-----`);
    tail.push(BODY);
    tail.push(BODY);
    tail.push('-----END EC PRIVATE KEY-----');
    expect(tail.text()).not.toContain(BODY);
    expect(tail.text().endsWith('[REDACTED PEM BLOCK]')).toBe(true);
  });

  test('quotes the newest ERROR line, unless it restates a reported warning', () => {
    const tail = new CodexStderrTail();
    tail.push(
      '2026-10-27T18:02:11.204Z ERROR codex_core::config: project config was not loaded',
    );
    tail.push('  /workspace/repo/.codex/config.toml is not trusted.');
    tail.push(' WARN codex_core: continuing with user config only');
    expect(tail.lastErrorLine()).toBe(
      '2026-10-27T18:02:11.204Z ERROR codex_core::config: project config was not loaded',
    );
    tail.noteReported(
      'Project config was not loaded: the folder is not trusted.',
    );
    expect(tail.lastErrorLine()).toBeUndefined();
    tail.push('Error: unknown option --frobnicate');
    expect(tail.lastErrorLine()).toBe('Error: unknown option --frobnicate');
  });
});
