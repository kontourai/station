import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { OPENCODE_NATIVE_ROUTES } from '../adapters/opencode-serve-client.js';
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
        'sha256:29aae9835157f4c97f226f4939a340098443c3d4754c0225227b1ec5cd27447e',
    });
    expect(verifyOpenCodeServeSchema('2.3.0', capturedDoc())).toEqual({
      verified: true,
      fingerprint:
        'sha256:29aae9835157f4c97f226f4939a340098443c3d4754c0225227b1ec5cd27447e',
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

  test('documentation text in a used shape does not unverify the server', () => {
    const doc = capturedDoc();
    const prompt = doc.paths['/api/session/{sessionID}/prompt'].post;
    prompt.description = 'reworded';
    prompt.summary = 'reworded';
    const schema = doc.components.schemas['Session.Inbox.User'];
    schema.description = 'reworded';
    expect(verifyOpenCodeServeSchema('2.3.0', doc).verified).toBe(true);
  });

  test('a property named description is a shape, not documentation', () => {
    const doc = capturedDoc();
    const projected = projectOpenCodeServeSchema(doc);
    if (!projected.ok) throw new Error(projected.reason);
    const holder = Object.entries(doc.components.schemas).find(
      ([name, schema]: [string, any]) =>
        (projected.projection as any).schemas[name] !== undefined &&
        schema?.properties?.description !== undefined,
    );
    expect(holder).toBeDefined();
    delete (holder![1] as any).properties.description;
    expect(verifyOpenCodeServeSchema('2.3.0', doc).verified).toBe(false);
  });

  test('the fingerprinted operations are exactly the client route table', () => {
    const doc = capturedDoc();
    const declared = new Map<string, string>();
    for (const [path, item] of Object.entries<any>(doc.paths))
      for (const [method, operation] of Object.entries<any>(item))
        if (operation?.operationId)
          declared.set(
            operation.operationId,
            `${method.toUpperCase()} ${path}`,
          );
    for (const route of OPENCODE_NATIVE_ROUTES) {
      if (route.operationId === null) continue;
      expect(declared.get(route.operationId)).toBe(
        `${route.method} ${route.template}`,
      );
    }
    expect(OPENCODE_NATIVE_OPERATIONS).toEqual(
      OPENCODE_NATIVE_ROUTES.flatMap((route) =>
        route.operationId ? [route.operationId] : [],
      ),
    );
    expect(OPENCODE_NATIVE_OPERATIONS).toContain('session.prompt');
  });
});
