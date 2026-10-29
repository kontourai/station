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
  test('withholds nested and mismatched PEM material while retaining later diagnostics', () => {
    const tail = new CodexStderrTail();
    const logged = [
      '-----BEGIN PRIVATE KEY-----',
      '-----BEGIN CERTIFICATE-----',
      '-----END CERTIFICATE-----',
      BODY,
      'abc=',
      '-----END PUBLIC KEY-----',
      'ready',
      'ERROR real failure',
    ].map((line) => tail.push(line));
    expect(logged.join('\n')).not.toContain(BODY);
    expect(logged.join('\n')).not.toContain('abc=');
    expect(tail.text()).toContain('ready');
    expect(tail.text()).toContain('ERROR real failure');
  });
  test.each([
    `before -----BEGIN PRIVATE KEY----- ${BODY} -----END PRIVATE KEY----- between -----BEGIN PRIVATE KEY----- ${BODY} -----END PRIVATE KEY----- after`,
    '-----END PRIVATE KEY----------BEGIN PRIVATE KEY-----',
    `cert -----BEGIN CERTIFICATE----- ${'Q'.repeat(1500)} -----END CERTIFICATE-----`,
    '\u001b[31m-----BE\u001b[0mGIN PRIVATE KEY-----\r',
  ])('withholds delimiter lines before truncation: %s', (line) => {
    const tail = new CodexStderrTail();
    expect(tail.push(line)).toBe('');
    expect(tail.text()).toBe('');
  });

  test('withholds key-like tokens and preserves realistic diagnostics', () => {
    const tail = new CodexStderrTail();
    expect(tail.push(`key=${BODY}`)).not.toContain(BODY);
    expect(tail.push('a'.repeat(38))).not.toContain('a'.repeat(38));
    expect(tail.push('abc=')).toBe('');
    const lines = [
      '2026-10-27T18:02:11.204Z INFO codex_core::config: loading /workspace/repo/.codex/config.toml',
      'request id 10000000-0000-4000-8000-000000000000',
      'ready',
      'ERROR real failure',
    ];
    expect(lines.map((line) => tail.push(line))).toEqual(lines);
  });

  test('handles a delimiter-dense line without repeated rescans', () => {
    const tail = new CodexStderrTail();
    const started = performance.now();
    expect(tail.push('-----END KEY-----'.repeat(4000))).toBe('');
    expect(performance.now() - started).toBeLessThan(1000);
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
