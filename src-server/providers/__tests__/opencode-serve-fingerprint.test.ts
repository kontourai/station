import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  OPENCODE_NATIVE_OPERATIONS,
  OPENCODE_SERVE_VERIFIED_FINGERPRINTS,
  openCodeServeFingerprint,
  projectOpenCodeServeSchema,
  verifyOpenCodeServeSchema,
} from '../adapters/opencode-serve-fingerprint.js';

/** The document OpenCode 2.3.0 served at `/openapi.json`, scrubbed. */
function capturedDoc(): any {
  return JSON.parse(
    readFileSync(
      new URL('./fixtures/opencode-serve-2.3.0-openapi.json', import.meta.url),
      'utf8',
    ),
  );
}

describe('OpenCode serve schema fingerprint', () => {
  test('the captured 2.3.0 document is the one allowlisted', () => {
    // Pinned beside the computation: a changed projection must change this
    // line on purpose, not follow the code.
    expect(OPENCODE_SERVE_VERIFIED_FINGERPRINTS).toEqual({
      '2.3.0':
        'sha256:9a91cd5d1ef1217ccfb9797f1848038987cb88503309d557124dd7a8c127c17c',
    });
    expect(verifyOpenCodeServeSchema('2.3.0', capturedDoc())).toEqual({
      verified: true,
      fingerprint:
        'sha256:9a91cd5d1ef1217ccfb9797f1848038987cb88503309d557124dd7a8c127c17c',
    });
  });

  test('a change to a shape the transport reads unverifies the server', () => {
    const doc = capturedDoc();
    doc.components.schemas['Session.Inbox.User'].properties.extra = {
      type: 'string',
    };
    const verdict = verifyOpenCodeServeSchema('2.3.0', doc);
    expect(verdict.verified).toBe(false);
    expect(verdict).toMatchObject({
      reason: expect.stringMatching(/differs from the one verified/),
    });
  });

  test('a new event type unverifies the server', () => {
    const doc = capturedDoc();
    const types =
      doc.paths['/api/event'].get.parameters[0].schema.anyOf[0].enum;
    types.push('session.something.new');
    expect(verifyOpenCodeServeSchema('2.3.0', doc).verified).toBe(false);
  });

  test('a missing operation is named, and an unlisted version is unverified', () => {
    const doc = capturedDoc();
    delete doc.paths['/api/session/{sessionID}/revert/stage'];
    expect(verifyOpenCodeServeSchema('2.3.0', doc)).toEqual({
      verified: false,
      reason: 'missing operations: session.revert.stage',
    });
    expect(verifyOpenCodeServeSchema('2.3.1', capturedDoc())).toMatchObject({
      verified: false,
      reason: 'OpenCode 2.3.1 was not verified for the native transport',
    });
  });

  test('an operation the transport never calls may change', () => {
    const doc = capturedDoc();
    doc.paths['/api/credential'].get.description = 'changed';
    expect(verifyOpenCodeServeSchema('2.3.0', doc).verified).toBe(true);
  });

  test('key order does not change the fingerprint', () => {
    const projected = projectOpenCodeServeSchema(capturedDoc());
    if (!projected.ok) throw new Error(projected.reason);
    const reversed = JSON.parse(
      JSON.stringify(projected.projection, (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    );
    expect(openCodeServeFingerprint(reversed)).toBe(
      openCodeServeFingerprint(projected.projection),
    );
  });

  test('every operation the transport calls exists in the captured document', () => {
    const projected = projectOpenCodeServeSchema(capturedDoc());
    expect(projected.ok).toBe(true);
    expect(OPENCODE_NATIVE_OPERATIONS).toContain('session.prompt');
  });
});
