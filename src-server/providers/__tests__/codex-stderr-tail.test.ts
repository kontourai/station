/**
 * #4266: what Station keeps of a Codex app-server's stderr never holds a
 * secret a whole-line pattern would have caught, nor a PEM body, and a
 * failure's text quotes one ERROR line that was not already reported.
 */
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  CodexStderrTail,
  cleanCodexDiagnosticLine,
} from '../adapters/codex-stderr-tail.js';

const DASHES = '-'.repeat(5);
const begin = (label: string) => `${DASHES}BEGIN ${label}${DASHES}`;
const end = (label: string) => `${DASHES}END ${label}${DASHES}`;
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
      begin('PRIVATE KEY'),
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
    `before ${begin('PRIVATE KEY')} ${BODY} ${end('PRIVATE KEY')} between ${begin('PRIVATE KEY')} ${BODY} ${end('PRIVATE KEY')} after`,
    `${end('PRIVATE KEY')}${begin('PRIVATE KEY')}`,
    `cert -----BEGIN CERTIFICATE----- ${'Q'.repeat(1500)} -----END CERTIFICATE-----`,
    `\u001b[31m${DASHES}BE\u001b[0mGIN PRIVATE KEY${DASHES}\r`,
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

  test.each(['ed25519', 'rsa'] as const)(
    'withholds a real %s PEM body and keeps later errors',
    (kind) => {
      const key =
        kind === 'ed25519'
          ? generateKeyPairSync('ed25519').privateKey
          : generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
      const pem = key.export({ type: 'pkcs8', format: 'pem' }).toString();
      const body = pem.split('\n').slice(1, -2).join('');
      const width = kind === 'ed25519' ? 16 : 64;
      const parts = body.match(new RegExp('.{1,' + width + '}', 'g'))!;
      const tail = new CodexStderrTail();
      const outputs = [
        begin('PRIVATE KEY'),
        ...parts,
        end('PRIVATE KEY'),
        'ERROR real failure',
      ].map((line) => tail.push(line));
      for (const part of parts) {
        expect(outputs.join('\n')).not.toContain(part);
        expect(tail.text()).not.toContain(part);
      }
      const reconstructed = outputs.join('\n').replace(/[^A-Za-z0-9+/=]/g, '');
      expect(() =>
        createPrivateKey({
          key: Buffer.from(reconstructed, 'base64'),
          format: 'der',
          type: 'pkcs8',
        }),
      ).toThrow();
      expect(tail.text()).toContain('ERROR real failure');
    },
  );

  test('preserves tracing paths and UUIDs but redacts hashes', () => {
    const tail = new CodexStderrTail();
    const lines = [
      '2026-10-27T18:02:11Z ERROR codex_core: /workspace/a/very/long/project/src/some_module.rs:42 failed',
      '2026-10-27T18:02:11Z INFO codex_core: commit 0123456789abcdef0123456789abcdef01234567',
      '2026-10-27T18:02:11Z INFO codex_core: digest 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef request 10000000-0000-4000-8000-000000000000',
    ];
    const outputs = lines.map((line) => tail.push(line));
    expect(outputs[0]).toBe(lines[0]);
    expect(outputs[1]).toContain('[REDACTED]');
    expect(outputs[2]).toContain(
      `${'[REDACTED]'} request 10000000-0000-4000-8000-000000000000`,
    );
  });

  test('redacts orphaned RSA body lines, including a slash-prefixed line', () => {
    const bodies = Array.from({ length: 30 }, () =>
      generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString()
        .split('\n')
        .slice(1, -2),
    ).flat();
    bodies.push('/' + 'A'.repeat(63));
    const tail = new CodexStderrTail();
    for (const body of bodies) {
      expect(tail.push(body)).not.toContain(body);
      expect(cleanCodexDiagnosticLine(body)).not.toContain(body);
    }
  }, 30000);

  test('redacts a hex credential in an error', () => {
    const credential = `${'abcdef01'}${'23456789'}`.repeat(4);
    expect(
      new CodexStderrTail().push(`ERROR authentication rejected ${credential}`),
    ).not.toContain(credential);
  });

  test('ends PEM context on a diagnostic, an END, or the line cap', () => {
    const tail = new CodexStderrTail();
    expect(tail.push(`\u001b[31m${begin('PRIVATE KEY')}\u001b[0m\r`)).toBe('');
    expect(tail.push('  shortBody1234  \r')).toBe('');
    expect(tail.push('ready')).toBe('');
    expect(tail.push('EIO')).toBe('');
    expect(tail.push('ERROR real failure')).toBe('ERROR real failure');
    expect(tail.push('ready')).toBe('ready');
    tail.push(begin('PRIVATE KEY'));
    tail.push('-----END OTHER KEY-----');
    expect(tail.push('ready')).toBe('ready');
    tail.push(begin('PRIVATE KEY'));
    for (let i = 0; i < 200; i += 1)
      expect(tail.push('shortBody1234')).toBe('');
    expect(tail.push('ready')).toBe('ready');
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
