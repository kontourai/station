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
  test('redacts every block on a line and keeps the following text', () => {
    const tail = new CodexStderrTail();
    const logged = tail.push(
      `before -----BEGIN PRIVATE KEY----- ${BODY} -----END PRIVATE KEY----- between -----BEGIN PRIVATE KEY----- ${BODY} -----END PRIVATE KEY----- after`,
    );
    expect(logged).toBe(
      'before [REDACTED PEM BLOCK] between [REDACTED PEM BLOCK] after',
    );
    expect(tail.text()).toBe(logged);
  });

  test('continues redacting when a block starts after an END', () => {
    const tail = new CodexStderrTail();
    const logged = [
      '-----BEGIN PRIVATE KEY-----',
      BODY,
      '-----END PRIVATE KEY----------BEGIN PRIVATE KEY-----',
      BODY,
      '-----END PRIVATE KEY----- done',
    ].map((line) => tail.push(line));
    expect(logged.join('\n')).not.toContain(BODY);
    expect(tail.text()).toBe(
      '[REDACTED PEM BLOCK]\n[REDACTED PEM BLOCK]\ndone',
    );
  });

  test('withholds body after a line exceeding the scanning bound', () => {
    const tail = new CodexStderrTail();
    const logged = [
      `${'x'.repeat(131073)}-----BEGIN PRIVATE KEY-----`,
      BODY,
      'ERROR real failure',
    ].map((line) => tail.push(line));
    expect(logged.join('\n')).not.toContain(BODY);
    expect(tail.text()).not.toContain(BODY);
    expect(tail.text()).toContain('ERROR real failure');
  });
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

  test('a BEGIN past the cut of a long line still opens the block', () => {
    const tail = new CodexStderrTail();
    tail.push(`${'x'.repeat(1100)} -----BEGIN EC PRIVATE KEY-----`);
    tail.push(BODY);
    tail.push(BODY);
    tail.push('-----END EC PRIVATE KEY-----');
    tail.push('continuing');
    expect(tail.text()).not.toContain(BODY);
    expect(tail.text()).not.toContain('-----');
    expect(tail.text().endsWith('…\ncontinuing')).toBe(true);
  });

  test('an END whose BEGIN was never seen takes the body lines above it', () => {
    const tail = new CodexStderrTail();
    // Station started reading after the BEGIN.
    tail.push(BODY);
    tail.push(BODY);
    tail.push('-----END EC PRIVATE KEY-----');
    expect(tail.text()).toBe('[REDACTED PEM BLOCK]');
  });

  test('a block on one line longer than the cut is still one marker, and later stderr is kept', () => {
    const tail = new CodexStderrTail();
    // BEGIN before the 1024-character cut, END after it.
    tail.push(
      `cert -----BEGIN CERTIFICATE----- ${'Q'.repeat(1500)} -----END CERTIFICATE-----`,
    );
    tail.push('ERROR codex_core: the real failure after');
    expect(tail.text()).toBe(
      'cert [REDACTED PEM BLOCK]\nERROR codex_core: the real failure after',
    );
    expect(tail.lastErrorLine()).toBe(
      'ERROR codex_core: the real failure after',
    );
  });

  test('a block whose END never comes ends at the next line that is not its own', () => {
    const tail = new CodexStderrTail();
    tail.push('-----BEGIN PRIVATE KEY-----');
    tail.push(BODY);
    tail.push('ERROR codex_core: the real failure after');
    expect(tail.text()).toBe(
      '[REDACTED PEM BLOCK]\nERROR codex_core: the real failure after',
    );
  });

  test('an END whose BEGIN was never seen takes a short last body line too', () => {
    const tail = new CodexStderrTail();
    tail.push('loading key');
    tail.push('a'.repeat(38));
    tail.push('b'.repeat(38));
    tail.push('abc=');
    tail.push('-----END RSA PRIVATE KEY-----');
    expect(tail.text()).toBe('loading key\n[REDACTED PEM BLOCK]');
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
