import { RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, test, vi } from 'vitest';
import {
  AcpCredentialBridgingRefusedError,
  AcpInboundExtensionRegistry,
  CREDENTIAL_SHAPED_WORDS,
  createAcpInboundExtensionRequestHandler,
  extensionMethodWords,
  isCredentialShapedExtensionMethod,
} from '../acp-inbound-extension-policy.js';

/**
 * These tests execute the REJECTION paths, which is the point: the behavior
 * being replaced (`onExtMethod: () => ({})`) passed every happy-path
 * assertion anyone could have written, because it always succeeded.
 *
 * The wire-level half — that the refusal actually reaches an agent as a
 * JSON-RPC `-32601` through the real ACP SDK, and that the adapter is the
 * thing wired to it — lives in
 * `src-server/providers/__tests__/acp-adapter-inbound-extension.test.ts`.
 * A handler that throws is not evidence that a peer sees an error.
 */
describe('extensionMethodWords', () => {
  test('splits ACP method spellings and camelCase humps', () => {
    // Both spellings are live simultaneously in one vendor binary
    // (ADR 0013): bare `_kiro/` in v3's declared list, `_kiro.dev/` in the
    // notifications the same process emits.
    expect(extensionMethodWords('_kiro/auth/getAccessToken')).toEqual([
      'kiro',
      'auth',
      'get',
      'access',
      'token',
    ]);
    expect(extensionMethodWords('_kiro.dev/commands/execute')).toEqual([
      'kiro',
      'dev',
      'commands',
      'execute',
    ]);
  });
});

describe('isCredentialShapedExtensionMethod', () => {
  test('matches the live credential-channel method', () => {
    // Kiro's host-mediated token-refresh callback (kirodotdev/Kiro#10416),
    // sent to the CLIENT (ADR 0013 live evidence, 2026-08-03).
    expect(isCredentialShapedExtensionMethod('_kiro/auth/getAccessToken')).toBe(
      true,
    );
  });

  test('matches on whole words, not substrings', () => {
    // `authoring` contains `auth`; segment matching must not fire on it, or
    // the vocabulary would deny a large arbitrary surface for no reason.
    expect(isCredentialShapedExtensionMethod('_kiro/session/authoring')).toBe(
      false,
    );
    expect(isCredentialShapedExtensionMethod('_kiro/tokenizer/count')).toBe(
      false,
    );
    // ...but the real word still matches wherever it appears.
    expect(isCredentialShapedExtensionMethod('_vendor/refresh/Token')).toBe(
      true,
    );
  });

  test('does not match the other live inbound method', () => {
    // `_kiro/terminal/shell_type` was observed inbound too. It is refused —
    // but for the ordinary reason (no handler), not as a credential.
    expect(isCredentialShapedExtensionMethod('_kiro/terminal/shell_type')).toBe(
      false,
    );
  });

  test('every declared vocabulary word is actually reachable by the matcher', () => {
    // A vocabulary entry the tokenizer can never produce is decoration.
    // Pins the list independently as well as the loop: an entry silently
    // deleted from CREDENTIAL_SHAPED_WORDS would just shorten this loop, so
    // assert the count and two specific members too.
    for (const word of CREDENTIAL_SHAPED_WORDS) {
      expect(isCredentialShapedExtensionMethod(`_vendor/${word}/get`)).toBe(
        true,
      );
    }
    expect(CREDENTIAL_SHAPED_WORDS).toContain('token');
    expect(CREDENTIAL_SHAPED_WORDS).toContain('auth');
    expect(CREDENTIAL_SHAPED_WORDS.length).toBe(30);
  });
});

describe('AcpInboundExtensionRegistry', () => {
  test('refuses to register a handler for a credential-shaped method', () => {
    const registry = new AcpInboundExtensionRegistry();
    expect(() =>
      registry.register('_kiro/auth/getAccessToken', () => ({
        token: 'anything',
      })),
    ).toThrow(AcpCredentialBridgingRefusedError);
    expect(registry.size).toBe(0);
  });

  test('a non-credential handler registers and resolves', () => {
    const registry = new AcpInboundExtensionRegistry();
    const handler = vi.fn(() => ({ shell: 'zsh' }));
    registry.register('_kiro/terminal/shell_type', handler);
    expect(registry.resolve('_kiro/terminal/shell_type')).toBe(handler);
  });

  test('resolve is exact-match — a near-miss spelling gets nothing', () => {
    const registry = new AcpInboundExtensionRegistry();
    registry.register('_kiro/terminal/shell_type', () => ({}));
    expect(registry.resolve('_kiro.dev/terminal/shell_type')).toBeUndefined();
  });

  test('resolve re-checks the credential shape even for a bypassed handler', () => {
    // The second, independent enforcement point. Simulates a handler map
    // populated by any route other than register() — the exact way a comment
    // -only invariant gets defeated.
    const registry = new AcpInboundExtensionRegistry();
    (registry as unknown as { handlers: Map<string, unknown> }).handlers.set(
      '_kiro/auth/getAccessToken',
      () => ({ token: 'leaked' }),
    );
    expect(registry.resolve('_kiro/auth/getAccessToken')).toBeUndefined();
  });
});

describe('registry scoping — the property the guarantee rests on', () => {
  test('two handlers built without an explicit registry do not share one', async () => {
    // The honest ranking in the module header puts "the allowlist is empty
    // and both call sites own a private registry" ABOVE the name predicate.
    // That is only true while each factory call builds its own registry, so
    // assert it rather than assume it: registering on one handler's registry
    // must not make the method answerable on another's.
    const shared = new AcpInboundExtensionRegistry();
    shared.register('_vendor/thing', () => ({ answered: true }));

    const withShared = createAcpInboundExtensionRequestHandler({
      registry: shared,
    });
    const withOwn = createAcpInboundExtensionRequestHandler();

    await expect(withShared('_vendor/thing', {})).resolves.toEqual({
      answered: true,
    });
    // The default-registry handler is unaffected by the other's registrations.
    await expect(withOwn('_vendor/thing', {})).rejects.toMatchObject({
      code: -32601,
    });
  });
});

describe('createAcpInboundExtensionRequestHandler', () => {
  test('refuses an unknown request with JSON-RPC -32601', async () => {
    const onExtMethod = createAcpInboundExtensionRequestHandler();
    let thrown: unknown;
    try {
      await onExtMethod('_kiro/terminal/shell_type', {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RequestError);
    expect((thrown as RequestError).code).toBe(-32601);
  });

  /**
   * NOTE ON TEST POWER (independent review, L8): the ACP SDK already answers
   * `-32601` for a method with no handler, so an assertion that says only
   * "an unknown request is refused with -32601" would still pass with this
   * entire module deleted and `onExtMethod` simply not supplied. The tests
   * that actually discriminate this module are the log, dedupe, structured-
   * fields, registry and warning ones — plus fault injection #1, which
   * reverts the adapter to `() => ({})` rather than to "no handler".
   */
  test('refuses a credential-shaped request with the SAME code', async () => {
    // Deliberate: a probing agent must not learn from the response code
    // whether Station recognised the method.
    const onExtMethod = createAcpInboundExtensionRequestHandler();
    await expect(
      onExtMethod('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });
  });

  test('never returns a value for any input — no fabricated success', async () => {
    const onExtMethod = createAcpInboundExtensionRequestHandler();
    for (const method of [
      '_kiro/auth/getAccessToken',
      '_kiro/terminal/shell_type',
      '_kiro.dev/commands/execute',
      '_zed.dev/workspace/buffers',
      'totally/unknown',
    ]) {
      await expect(onExtMethod(method, {})).rejects.toBeInstanceOf(
        RequestError,
      );
    }
  });

  test('names the refused method and reason in the log', async () => {
    // The log is the primary observability channel: OTel instruments are
    // no-ops without OTEL_EXPORTER_OTLP_ENDPOINT, so a refusal that only
    // incremented a counter would be invisible on a default install.
    const warn = vi.fn();
    const onExtMethod = createAcpInboundExtensionRequestHandler({
      logger: { warn },
      connectionId: 'kiro',
    });
    await expect(
      onExtMethod('_kiro/auth/getAccessToken', {}),
    ).rejects.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const [, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(fields.method).toBe('_kiro/auth/getAccessToken');
    expect(fields.code).toBe(-32601);
    expect(fields.reason).toBe('credential-shaped');
    expect(fields.connectionId).toBe('kiro');
  });

  test('reports the ordinary refusal reason for an unknown non-credential method', async () => {
    const refusals: Array<[string, string]> = [];
    const onExtMethod = createAcpInboundExtensionRequestHandler({
      onRefused: (method, reason) => refusals.push([method, reason]),
    });
    await expect(
      onExtMethod('_kiro/terminal/shell_type', {}),
    ).rejects.toThrow();
    expect(refusals).toEqual([['_kiro/terminal/shell_type', 'no-handler']]);
  });

  test('a registered non-credential handler is what answers — and only it', async () => {
    // Weakening direction: proves the refusal is bound to "no reviewed
    // handler", not to something incidental. If this could not pass, the
    // refusal test above would prove nothing about the mechanism.
    const registry = new AcpInboundExtensionRegistry();
    registry.register('_kiro/terminal/shell_type', async () => ({
      shell: 'zsh',
    }));
    const onExtMethod = createAcpInboundExtensionRequestHandler({ registry });

    await expect(onExtMethod('_kiro/terminal/shell_type', {})).resolves.toEqual(
      { shell: 'zsh' },
    );
    // ...and the credential channel stays refused with the handler present.
    await expect(
      onExtMethod('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });
  });

  test('defaults to an empty registry — nothing is answerable out of the box', async () => {
    // Exercises the FACTORY's default, not a hand-built registry: the
    // previous version asserted `new AcpInboundExtensionRegistry().size === 0`
    // and never called `createAcpInboundExtensionRequestHandler()` at all,
    // so it proved nothing about the default the adapter actually gets.
    const onExtMethod = createAcpInboundExtensionRequestHandler();
    await expect(onExtMethod('_vendor/anything', {})).rejects.toMatchObject({
      code: -32601,
    });
  });

  test('logs a refused method ONCE per handler, not once per request', async () => {
    // A refused method is a standing condition, not an event. The
    // availability probe re-runs every 60s forever; an undeduped line is one
    // warning per connection per minute, permanently.
    const warn = vi.fn();
    const onExtMethod = createAcpInboundExtensionRequestHandler({
      logger: { warn },
      connectionId: 'kiro',
    });
    for (let i = 0; i < 5; i += 1) {
      await expect(
        onExtMethod('_kiro/auth/getAccessToken', {}),
      ).rejects.toThrow();
    }
    expect(warn).toHaveBeenCalledTimes(1);

    // ...but a DIFFERENT method is still its own first-sighting.
    await expect(
      onExtMethod('_kiro/terminal/shell_type', {}),
    ).rejects.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test('the log is structured and filterable, not an interpolated string', async () => {
    const warn = vi.fn();
    const onExtMethod = createAcpInboundExtensionRequestHandler({
      logger: { warn },
      connectionId: 'kiro',
    });
    await expect(
      onExtMethod('_kiro/auth/getAccessToken', {}),
    ).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('refused inbound ACP extension request'),
      {
        method: '_kiro/auth/getAccessToken',
        reason: 'credential-shaped',
        code: -32601,
        connectionId: 'kiro',
      },
    );
  });
});
