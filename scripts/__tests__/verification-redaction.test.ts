import { describe, expect, test } from 'vitest';
import {
  createVerificationRedactor,
  REDACTED,
  redactVerificationOutput,
  redactVerificationValue,
} from '../lib/verification-redaction.mjs';

function privateKeyMarker(position: 'BEGIN' | 'END', kind: string): string {
  return ['-----', position, ' ', kind, ' PRIVATE', ' KEY', '-----'].join('');
}

describe('verification output redaction', () => {
  test('redacts canonical provider and GitHub token forms without changing safe text', () => {
    const output = redactVerificationOutput(
      'safe=keep ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD sk-abcdefghijklmnopqrstuvwxyz012345 Bearer top-secret',
    );
    expect(output).toContain('safe=keep');
    expect(output).toContain(REDACTED);
    expect(output).not.toContain('top-secret');
    expect(output).not.toContain('ghp_');
    expect(output).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });

  test.each([
    'prefix AKIAIOSFODNN7',
    'prefix ghp_abcdefghij',
    'prefix github_pat_abcdefghij',
    'prefix sk-abcdefghij',
    'prefix https://user:partia',
  ])(
    'redacts a canonical secret prefix cut at a capture boundary: %s',
    (value) => {
      const output = redactVerificationOutput(value);
      expect(output).toContain(REDACTED);
      expect(output).not.toContain(value.split(' ').at(-1));
    },
  );

  test('redacts complete and capture-truncated private-key blocks', () => {
    const beginOpenSsh = privateKeyMarker('BEGIN', 'OPENSSH');
    const endOpenSsh = privateKeyMarker('END', 'OPENSSH');
    const beginRsa = privateKeyMarker('BEGIN', 'RSA');
    const complete = `${beginOpenSsh}\nprivate-material\n${endOpenSsh}`;
    const truncated = `prefix ${beginRsa}\nprivate-material-without-end`;
    expect(redactVerificationOutput(complete)).toBe(REDACTED);
    const bounded = redactVerificationOutput(truncated);
    expect(bounded).toContain(REDACTED);
    expect(bounded).not.toContain('private-material');
  });

  test('redacts contextual, JSON, and URL credentials while preserving unrelated values', () => {
    const output = redactVerificationOutput(
      'name=station password=hunter2 https://user:pass@example.test/x {"cookie":"abc","safe":"keep"}',
    );
    expect(output).toContain('name=station');
    expect(output).toContain('"safe":"keep"');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain(':pass@');
    expect(output).not.toContain('"cookie":"abc"');
  });

  test('matches shared segmented token-key exceptions and recursive JSON handling', () => {
    const output = redactVerificationOutput(
      'tokenCount=12 contextTokenLimit=4 outputToken=secret',
    );
    expect(output).toContain('tokenCount=12');
    expect(output).toContain('contextTokenLimit=4');
    expect(output).not.toContain('outputToken=secret');
    expect(
      redactVerificationValue('{"password":"nested","safe":"ok"}'),
    ).toContain('"password":"[REDACTED]"');
  });
  test('redacts JSON encoded inside textual logs without changing safe fields', () => {
    const output = redactVerificationOutput(
      'nested="{\\"password\\":\\"hunter2\\"}" apiKey="secret with spaces" safe=keep',
    );
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('secret with spaces');
    expect(output).toContain('safe=keep');
  });

  test('scans nested and encoded objects across keys, depths, offsets and buffer caps', () => {
    const keys = ['password', 'apiKey', 'client_secret', 'accessToken', 'authorization'];
    let checked = 0;
    for (const key of keys) {
      for (const depth of [1, 2, 8, 32]) {
        let value: unknown = { [key]: 'corpus-secret', safe: 'keep' };
        for (let i = 0; i < depth; i += 1) value = { context: value };
        const json = JSON.stringify(value);
        for (const encoded of [json, JSON.stringify(json), JSON.stringify(JSON.stringify(json))]) {
          for (const offset of [0, 7, 63]) {
            const raw = `${'x'.repeat(offset)} prefix ${encoded} suffix`;
            for (const cap of [64, Buffer.byteLength(raw), Buffer.byteLength(raw) + 16]) {
              const redactor = createVerificationRedactor({ maxBytes: Math.max(64, cap) });
              redactor.push(raw.slice(0, 13));
              redactor.push(raw.slice(13));
              const output = redactor.flush();
              expect(output).not.toContain('corpus-secret');
              if (Buffer.byteLength(raw) <= Math.max(64, cap)) {
                expect(output).toContain('keep');
                expect(output).toContain('prefix');
                expect(output).toContain('suffix');
                expect(redactVerificationOutput(output)).toBe(output);
              } else expect(output).toContain('output omitted');
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBe(540);
  });

  test.each([' ', '\n', `${String.fromCharCode(27)}[32m\n`])(
    'does not let a harmless assignment hide a following secret across %j',
    (boundary) => {
      const output = redactVerificationOutput(`xxx=${boundary}apiKey: "boundary-secret"Basic dXNlcjpwYXNz`);
      expect(output).not.toContain('boundary-secret');
      expect(output).not.toContain('dXNlcjpwYXNz');
      expect(output).toContain('xxx=');
      expect(redactVerificationOutput(output)).toBe(output);
    },
  );

  test('keeps JSON delimiters and existing markers stable', () => {
    const raw = '{"context":{"password":"secret","safe":"keep"},"token":[REDACTED],"other":42}';
    const output = redactVerificationOutput(raw);
    expect(output).toBe('{"context":{"password":"[REDACTED]","safe":"keep"},"token":[REDACTED],"other":42}');
    expect(redactVerificationOutput(output)).toBe(output);
  });

  test.each([
    'attachment: /tmp/token=report-secret.zip',
    String.raw`attachment: E:\tmp\token=report-secret.zip`,
  ])('redacts secret assignments nested inside path values: %s', (value) => {
    const output = redactVerificationOutput(value);
    expect(output).toContain('token=[REDACTED]');
    expect(output).not.toContain('report-secret');
  });

  test.each([1, 2, 3, 4, 5, 6])(
    'redacts password through encoded JSON depth %i without changing safe log bytes',
    (depth) => {
      let encoded = JSON.stringify({ password: 'depth-secret', safe: 'keep' });
      for (let index = 1; index < depth; index += 1)
        encoded = JSON.stringify(encoded);
      const output = redactVerificationOutput(
        `prefix-safe ${encoded} suffix-safe`,
      );
      expect(output).toContain('prefix-safe');
      expect(output).toContain('suffix-safe');
      expect(output).not.toContain('depth-secret');
      expect(output).toContain(REDACTED);
      if (depth <= 5) expect(output).toContain('keep');
      else expect(output).not.toContain('"safe"');
    },
  );

  test('redacts tokens split across chunk boundaries', () => {
    const redactor = createVerificationRedactor({ tailChars: 8 });
    const output = `${redactor.push('before ghp_abcdefghijkl')}${redactor.push('mnopqrstuvwxyz0123456789ABCD after')}${redactor.flush()}`;
    expect(output).toContain('before');
    expect(output).toContain('after');
    expect(output).not.toContain('ghp_');
  });
});
