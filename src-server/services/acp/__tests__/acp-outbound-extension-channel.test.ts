import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RequestError } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Mock the OTel instruments so counter WIRING can be asserted directly. The
// defining failure these tests guard against: notify() routing its three
// dispositions through the REQUESTS counter (a wiring gap that left
// acpOutboundExtensionNotifications with no data points and made the requests
// counter merge two distinct call types). Both counters become no-op spies;
// driving each channel path must touch ONLY its own counter. Re-routing either
// path to the wrong instrument turns these red. Mirrors the pattern in
// knowledge-store-metrics.test.ts.
vi.mock('../../../telemetry/metrics.js', () => ({
  acpOutboundExtensionRequests: { add: vi.fn() },
  acpOutboundExtensionNotifications: { add: vi.fn() },
}));

import {
  acpOutboundExtensionNotifications,
  acpOutboundExtensionRequests,
} from '../../../telemetry/metrics.js';
import {
  type AcpExtensionHandshakeMeta,
  AcpOutboundExtensionChannel,
  type AcpOutboundExtensionTarget,
  readDeclaredExtensionMethods,
} from '../acp-outbound-extension-channel.js';

/**
 * Outbound extension channel tests.
 *
 * The point of this module is the gate, so the tests execute the gate's
 * behaviour, not merely the happy path. The two assertions that matter most —
 * that an undeclared call makes NO wire call, and that the #1815 rename flips
 * the outcome — are kept unambiguous below.
 *
 * The wire-level half (that an `answered` outcome corresponds to a real
 * JSON-RPC round-trip through the ACP SDK) is not proven here: the target is a
 * fake. That is deliberate — this layer's contract is the gate and the
 * classification, and the SDK's own transport is tested by the SDK.
 */

/** Build a fake target with settable handshake and spied pass-throughs. */
function fakeTarget(
  initResult: AcpExtensionHandshakeMeta | null,
): AcpOutboundExtensionTarget & {
  extMethod: ReturnType<typeof vi.fn>;
  extNotification: ReturnType<typeof vi.fn>;
  setInitResult(next: AcpExtensionHandshakeMeta | null): void;
} {
  const state = { initResult };
  const extMethod = vi.fn();
  const extNotification = vi.fn();
  return {
    get initResult() {
      return state.initResult;
    },
    setInitResult(next) {
      state.initResult = next;
    },
    // The Mocks are callable, so they satisfy the target's call signatures
    // without a cast; keeping the Mock type is what lets tests call
    // .mockResolvedValue / .toHaveBeenCalledWith on the returned spies.
    extMethod,
    extNotification,
  };
}

/** A Kiro-v3-shaped handshake declaring a set of `_kiro/` methods. */
function handshakeDeclaring(
  vendorKey: string,
  methods: string[],
): AcpExtensionHandshakeMeta {
  return {
    agentCapabilities: {
      _meta: { [vendorKey]: { extensionMethods: methods } },
    },
  };
}

describe('readDeclaredExtensionMethods', () => {
  test('null session (not initialised) declares nothing', () => {
    expect(readDeclaredExtensionMethods(null)).toEqual([]);
  });

  test('reads methods from the observed vendor key without hardcoding it', () => {
    const hs = handshakeDeclaring('kiro', [
      '_kiro/session/context',
      '_kiro/knowledge',
    ]);
    expect(readDeclaredExtensionMethods(hs).sort()).toEqual([
      '_kiro/knowledge',
      '_kiro/session/context',
    ]);
  });

  test('vendor-key independence — any key under _meta gates identically', () => {
    // The vendor key is vendor-chosen; `kiro` is one observed value. A second
    // vendor under a different key gates the same way.
    const a = handshakeDeclaring('kiro', ['_kiro/foo']);
    const b = handshakeDeclaring('somethingelse', ['_other/foo']);
    expect(readDeclaredExtensionMethods(a)).toEqual(['_kiro/foo']);
    expect(readDeclaredExtensionMethods(b)).toEqual(['_other/foo']);
  });

  test('W3C trace keys under _meta are never read as a declared list', () => {
    // `traceparent`/`tracestate`/`baggage` are reserved at `_meta` root for
    // W3C trace context (ACP extensibility spec). A method listed only under
    // one of these keys is NOT declared.
    const hs: AcpExtensionHandshakeMeta = {
      agentCapabilities: {
        _meta: {
          traceparent: { extensionMethods: ['_x/trace-secret'] },
          tracestate: { extensionMethods: ['_x/tracestate-secret'] },
          baggage: { extensionMethods: ['_x/baggage-secret'] },
        },
      },
    };
    expect(readDeclaredExtensionMethods(hs)).toEqual([]);
  });

  test('W3C trace keys are never mutated', () => {
    // Frozen objects would throw in strict mode if the walk tried to write.
    const secret = Object.freeze(['_x/trace-secret']);
    const hs: AcpExtensionHandshakeMeta = {
      agentCapabilities: {
        _meta: Object.freeze({
          traceparent: Object.freeze({ extensionMethods: secret }),
        }),
      },
    };
    expect(() => readDeclaredExtensionMethods(hs)).not.toThrow();
    expect(readDeclaredExtensionMethods(hs)).toEqual([]);
    // ...and the array is untouched.
    expect(secret).toEqual(['_x/trace-secret']);
  });

  test('a non-array extensionMethods field is ignored, not thrown on', () => {
    const hs: AcpExtensionHandshakeMeta = {
      agentCapabilities: {
        _meta: {
          kiro: { extensionMethods: 'not-an-array' },
          other: { extensionMethods: 42 },
        },
      },
    };
    expect(readDeclaredExtensionMethods(hs)).toEqual([]);
  });

  test('coalesces methods across multiple vendor keys, de-duplicated', () => {
    const hs: AcpExtensionHandshakeMeta = {
      agentCapabilities: {
        _meta: {
          kiro: { extensionMethods: ['_kiro/a', '_shared/x'] },
          other: { extensionMethods: ['_other/b', '_shared/x'] },
        },
      },
    };
    const result = readDeclaredExtensionMethods(hs).sort();
    expect(result).toEqual(['_kiro/a', '_other/b', '_shared/x']);
  });
});

describe('AcpOutboundExtensionChannel.call — the declared-list gate', () => {
  test('an undeclared call is not-declared AND provably makes no wire call', async () => {
    // The assertion that matters most: the underlying extMethod spy is never
    // invoked. Made unambiguous — not implied by the outcome.
    const target = fakeTarget(handshakeDeclaring('kiro', ['_kiro/knowledge']));
    const channel = new AcpOutboundExtensionChannel(target);

    const outcome = await channel.call('_kiro/unknown', { q: 'x' });

    expect(outcome.outcome).toBe('not-declared');
    expect(target.extMethod).not.toHaveBeenCalled();
    expect(target.extNotification).not.toHaveBeenCalled();
  });

  test('the not-declared receipt records what WAS declared at the time', async () => {
    const target = fakeTarget(
      handshakeDeclaring('kiro', ['_kiro/a', '_kiro/b']),
    );
    const channel = new AcpOutboundExtensionChannel(target);

    const outcome = await channel.call('_kiro/missing', {});

    expect(outcome).toMatchObject({
      outcome: 'not-declared',
      method: '_kiro/missing',
    });
    if (outcome.outcome === 'not-declared') {
      expect(outcome.receipt.declaredMethods.sort()).toEqual([
        '_kiro/a',
        '_kiro/b',
      ]);
    }
  });

  test('an uninitialised session (null initResult) declares nothing', async () => {
    const target = fakeTarget(null);
    const channel = new AcpOutboundExtensionChannel(target);

    const outcome = await channel.call('_kiro/anything', {});

    expect(outcome.outcome).toBe('not-declared');
    expect(target.extMethod).not.toHaveBeenCalled();
  });

  // ── The #1815 fault injection ──────────────────────────────────────────
  //
  // Renaming a declared method in the handshake (_kiro/foo -> _kiro.dev/foo)
  // must FLIP the outcome: a call that was answered becomes not-declared, and
  // the second call makes no wire call. A test that only asserts the happy
  // path does not satisfy this — the rename must change behaviour. This is the
  // core protection against hardcoding vendor method spellings.
  test('#1815 fault injection — renaming a declared method flips the outcome', async () => {
    const target = fakeTarget(handshakeDeclaring('kiro', ['_kiro/foo']));
    const channel = new AcpOutboundExtensionChannel(target);
    target.extMethod.mockResolvedValue({ ok: true });

    // Before: declared as _kiro/foo -> wire call -> answered.
    const before = await channel.call('_kiro/foo', {});
    expect(before.outcome).toBe('answered');
    expect(target.extMethod).toHaveBeenCalledTimes(1);

    // Rename the declared method in the live handshake (the namespace has
    // drifted within one vendor before — see ADR 0013).
    target.setInitResult(handshakeDeclaring('kiro', ['_kiro.dev/foo']));

    // After: _kiro/foo is no longer declared -> not-declared, no wire call.
    const after = await channel.call('_kiro/foo', {});
    expect(after.outcome).toBe('not-declared');
    // The spy count is STILL 1 — the rename added no wire call.
    expect(target.extMethod).toHaveBeenCalledTimes(1);
  });

  test('two sessions on different handshakes get different outcomes for the same method', async () => {
    // This is what proves the gate reads each SESSION's own handshake rather
    // than anything shared or cached: same method name, two channels, two
    // different live declared lists -> two different outcomes.
    const declaring = fakeTarget(handshakeDeclaring('kiro', ['_kiro/shared']));
    const silent = fakeTarget(handshakeDeclaring('kiro', ['_kiro/other']));
    declaring.extMethod.mockResolvedValue({ done: true });

    const declaringChannel = new AcpOutboundExtensionChannel(declaring);
    const silentChannel = new AcpOutboundExtensionChannel(silent);

    const a = await declaringChannel.call('_kiro/shared', {});
    const b = await silentChannel.call('_kiro/shared', {});

    expect(a.outcome).toBe('answered');
    expect(b.outcome).toBe('not-declared');
    // The silent session made no wire call for a method IT did not declare.
    expect(silent.extMethod).not.toHaveBeenCalled();
  });
});

describe('AcpOutboundExtensionChannel.call — outcome classification', () => {
  test('a declared method returning any JSON-RPC result is answered', async () => {
    const target = fakeTarget(handshakeDeclaring('kiro', ['_kiro/knowledge']));
    target.extMethod.mockResolvedValue({ items: [1, 2, 3] });
    const channel = new AcpOutboundExtensionChannel(target);

    const outcome = await channel.call('_kiro/knowledge', { q: 'x' });

    expect(outcome).toEqual({
      outcome: 'answered',
      method: '_kiro/knowledge',
      result: { items: [1, 2, 3] },
    });
    expect(target.extMethod).toHaveBeenCalledWith('_kiro/knowledge', {
      q: 'x',
    });
  });

  // A `{success: false}` envelope is a JSON-RPC *result*, not an error. The
  // channel must NOT interpret result payloads (ADR 0013); returning
  // `answered` here is correct and intended. Deciding what "working" means is
  // a later binding's conformance probe.
  test('a {success: false} result is answered, not failed', async () => {
    const target = fakeTarget(
      handshakeDeclaring('kiro', ['_kiro/session/context']),
    );
    // Live-observed soft-failure dialect: a success=false envelope returned as
    // a JSON-RPC result (the SDK resolves it, it does not reject).
    target.extMethod.mockResolvedValue({
      success: false,
      message: 'context unavailable',
    });
    const channel = new AcpOutboundExtensionChannel(target);

    const outcome = await channel.call('_kiro/session/context', {});

    expect(outcome.outcome).toBe('answered');
    if (outcome.outcome === 'answered') {
      expect(outcome.result).toEqual({
        success: false,
        message: 'context unavailable',
      });
    }
  });

  test('-32601 from a declared method is unsupported', async () => {
    const target = fakeTarget(handshakeDeclaring('kiro', ['_kiro/knowledge']));
    target.extMethod.mockRejectedValue(
      RequestError.methodNotFound('_kiro/knowledge'),
    );
    const channel = new AcpOutboundExtensionChannel(target);

    const outcome = await channel.call('_kiro/knowledge', {});

    expect(outcome.outcome).toBe('unsupported');
    if (outcome.outcome === 'unsupported') {
      expect((outcome.error as RequestError).code).toBe(-32601);
    }
  });

  test('-32603 (Kiro v3 undeclared-method dialect) is failed', async () => {
    const target = fakeTarget(handshakeDeclaring('kiro', ['_kiro/knowledge']));
    target.extMethod.mockRejectedValue(
      RequestError.internalError({
        detail:
          '[PersistenceClassification] Ext method "x" has no persistence classification',
      }),
    );
    const channel = new AcpOutboundExtensionChannel(target);

    const outcome = await channel.call('_kiro/knowledge', {});

    expect(outcome.outcome).toBe('failed');
    if (outcome.outcome === 'failed') {
      expect((outcome.error as RequestError).code).toBe(-32603);
    }
  });

  test('-32000 (vendor dialect) is failed', async () => {
    const target = fakeTarget(handshakeDeclaring('kiro', ['_kiro/knowledge']));
    target.extMethod.mockRejectedValue(
      new RequestError(-32000, 'permission failed'),
    );
    const channel = new AcpOutboundExtensionChannel(target);

    const outcome = await channel.call('_kiro/knowledge', {});

    expect(outcome.outcome).toBe('failed');
  });

  test('a non-JSON-RPC transport error is failed', async () => {
    const target = fakeTarget(handshakeDeclaring('kiro', ['_kiro/knowledge']));
    target.extMethod.mockRejectedValue(new Error('EPIPE: broken pipe'));
    const channel = new AcpOutboundExtensionChannel(target);

    const outcome = await channel.call('_kiro/knowledge', {});

    expect(outcome.outcome).toBe('failed');
    if (outcome.outcome === 'failed') {
      expect((outcome.error as Error).message).toContain('broken pipe');
    }
  });

  test('none of the error outcomes crash the turn — they resolve, classified', async () => {
    // Every rejection path resolves to a discriminated outcome rather than
    // throwing; the caller's turn continues. Iterate the dialects to prove no
    // path re-throws.
    const dialects = [
      RequestError.methodNotFound('_kiro/knowledge'),
      RequestError.internalError({}),
      new RequestError(-32000, 'permission failed'),
      new Error('transport'),
    ];
    for (const error of dialects) {
      const target = fakeTarget(
        handshakeDeclaring('kiro', ['_kiro/knowledge']),
      );
      target.extMethod.mockRejectedValue(error);
      const channel = new AcpOutboundExtensionChannel(target);
      const outcome = await channel.call('_kiro/knowledge', {});
      expect(['unsupported', 'failed']).toContain(outcome.outcome);
    }
  });

  test('the raw error is preserved, not normalised', async () => {
    // `-32603` messages carry vendor-internal detail the caller may need. The
    // channel passes the raw thrown value through; it does not flatten it.
    const target = fakeTarget(handshakeDeclaring('kiro', ['_kiro/knowledge']));
    const raw = new RequestError(
      -32603,
      'Internal error: vendor-specific detail',
    );
    target.extMethod.mockRejectedValue(raw);
    const channel = new AcpOutboundExtensionChannel(target);

    const outcome = await channel.call('_kiro/knowledge', {});

    if (outcome.outcome === 'failed') {
      expect(outcome.error).toBe(raw);
    }
  });
});

describe('AcpOutboundExtensionChannel.notify — declared-list gate on notifications', () => {
  test('a declared notification is sent', async () => {
    const target = fakeTarget(
      handshakeDeclaring('kiro', ['_kiro/session/compact']),
    );
    target.extNotification.mockResolvedValue(undefined);
    const channel = new AcpOutboundExtensionChannel(target);

    const outcome = await channel.notify('_kiro/session/compact', {
      deep: true,
    });

    expect(outcome).toEqual({
      outcome: 'sent',
      method: '_kiro/session/compact',
    });
    expect(target.extNotification).toHaveBeenCalledWith(
      '_kiro/session/compact',
      {
        deep: true,
      },
    );
  });

  test('an undeclared notification is not-declared and makes no wire call', async () => {
    const target = fakeTarget(
      handshakeDeclaring('kiro', ['_kiro/session/compact']),
    );
    target.extNotification.mockResolvedValue(undefined);
    const channel = new AcpOutboundExtensionChannel(target);

    const outcome = await channel.notify('_kiro/unknown', {});

    expect(outcome.outcome).toBe('not-declared');
    expect(target.extNotification).not.toHaveBeenCalled();
  });

  test('a notification transport failure is failed', async () => {
    const target = fakeTarget(
      handshakeDeclaring('kiro', ['_kiro/session/compact']),
    );
    target.extNotification.mockRejectedValue(new Error('stream closed'));
    const channel = new AcpOutboundExtensionChannel(target);

    const outcome = await channel.notify('_kiro/session/compact', {});

    expect(outcome.outcome).toBe('failed');
  });
});

// ── OTel counter wiring (ADR 0013 Layer 1) ─────────────────────────────────
//
// `acpOutboundExtensionRequests` and `acpOutboundExtensionNotifications` are
// distinct instruments with disjoint documented disposition sets. The property
// pinned here: call() routes to the REQUESTS counter only, and notify() routes
// to the NOTIFICATIONS counter only. An earlier wiring gap routed notify()'s
// three dispositions through the requests counter — which both understated the
// notifications instrument (zero data points) and merged two distinct call
// types into the requests counter, while metrics.ts asserted a routing nothing
// computed. Each test asserts the positive routing AND the negative (the other
// counter is never touched); reverting either path to the wrong counter turns
// the negative assertion red.
describe('AcpOutboundExtensionChannel — OTel counter wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('notify() routes all three dispositions to acpOutboundExtensionNotifications, never the requests counter', async () => {
    // not-declared: no wire call, so no extNotification mock is consulted.
    const t1 = fakeTarget(handshakeDeclaring('kiro', ['_kiro/x']));
    await new AcpOutboundExtensionChannel(t1).notify('_kiro/other', {});

    // sent.
    const t2 = fakeTarget(handshakeDeclaring('kiro', ['_kiro/x']));
    t2.extNotification.mockResolvedValue(undefined);
    await new AcpOutboundExtensionChannel(t2).notify('_kiro/x', {});

    // failed.
    const t3 = fakeTarget(handshakeDeclaring('kiro', ['_kiro/x']));
    t3.extNotification.mockRejectedValue(new Error('stream closed'));
    await new AcpOutboundExtensionChannel(t3).notify('_kiro/x', {});

    expect(acpOutboundExtensionNotifications.add).toHaveBeenCalledWith(1, {
      disposition: 'not-declared',
    });
    expect(acpOutboundExtensionNotifications.add).toHaveBeenCalledWith(1, {
      disposition: 'sent',
    });
    expect(acpOutboundExtensionNotifications.add).toHaveBeenCalledWith(1, {
      disposition: 'failed',
    });
    // The defining assertion: notify() never touches the requests instrument.
    expect(acpOutboundExtensionRequests.add).not.toHaveBeenCalled();
  });

  test('call() routes every disposition to acpOutboundExtensionRequests, never the notifications counter', async () => {
    // not-declared.
    const t1 = fakeTarget(handshakeDeclaring('kiro', ['_kiro/x']));
    await new AcpOutboundExtensionChannel(t1).call('_kiro/other', {});

    // answered.
    const t2 = fakeTarget(handshakeDeclaring('kiro', ['_kiro/x']));
    t2.extMethod.mockResolvedValue({ ok: true });
    await new AcpOutboundExtensionChannel(t2).call('_kiro/x', {});

    // unsupported (-32601).
    const t3 = fakeTarget(handshakeDeclaring('kiro', ['_kiro/x']));
    t3.extMethod.mockRejectedValue(RequestError.methodNotFound('_kiro/x'));
    await new AcpOutboundExtensionChannel(t3).call('_kiro/x', {});

    // failed (non-JSON-RPC transport error).
    const t4 = fakeTarget(handshakeDeclaring('kiro', ['_kiro/x']));
    t4.extMethod.mockRejectedValue(new Error('EPIPE: broken pipe'));
    await new AcpOutboundExtensionChannel(t4).call('_kiro/x', {});

    expect(acpOutboundExtensionRequests.add).toHaveBeenCalledWith(1, {
      disposition: 'not-declared',
    });
    expect(acpOutboundExtensionRequests.add).toHaveBeenCalledWith(1, {
      disposition: 'answered',
    });
    expect(acpOutboundExtensionRequests.add).toHaveBeenCalledWith(1, {
      disposition: 'unsupported',
    });
    expect(acpOutboundExtensionRequests.add).toHaveBeenCalledWith(1, {
      disposition: 'failed',
    });
    expect(acpOutboundExtensionNotifications.add).not.toHaveBeenCalled();
  });
});

// ── The version-gating trap, refused (ADR 0013) ─────────────────────────────
//
// kiro-cli's `--v3 --version` flag prints "2.16.0" while the two engines
// declare DISJOINT capability sets (ADR 0013 live evidence). No version — not
// a CLI flag, not a handshake field — can ever gate capability: the live
// declared list is the only gate.
//
// Three complementary assertions hold that line, weakest to strongest:
//
// 1. MECHANISM GREP (the cheap one): the channel source contains no CLI version
//    flag and no child_process import, banning the distinct spawn-a-binary
//    mechanism. The channel is a pure gate + pass-through; if that ever
//    changes, this catches it.
// 2. BEHAVIOURAL (the named-fields one): drive readDeclaredExtensionMethods
//    with a handshake carrying the version-shaped fields a real
//    InitializeResult is known to carry, and assert the returned list is
//    IDENTICAL across every value. Fails fast and reads clearly — but it is
//    still an enumeration of named fields, so it holds only for the names it
//    knows.
// 3. ACCESS-SET (the general one): wrap the handshake in a recording Proxy and
//    assert readDeclaredExtensionMethods reads ONLY agentCapabilities._meta and
//    the extensionMethods arrays beneath it. A version gate must READ a version
//    field to gate on it; whatever that field is named and wherever it lives,
//    reading it is a property access outside the structural walk, and this
//    catches it without enumerating field names.
const channelSourcePath = fileURLToPath(
  new URL('../acp-outbound-extension-channel.ts', import.meta.url),
);

describe('version-gating refused (ADR 0013 trap)', () => {
  test('the declared list is returned identically regardless of any version field in the handshake', () => {
    // The property: capability is derived from the declared list and from
    // nothing else in the handshake. The cast lets us attach fields the typed
    // slice (AcpExtensionHandshakeMeta) doesn't model — exactly the fields a
    // version gate would read off the real InitializeResult.
    const declared = ['_kiro/foo', '_kiro/bar'];
    const expected = ['_kiro/bar', '_kiro/foo'];

    // Baseline: no version fields anywhere.
    const baseline: AcpExtensionHandshakeMeta = {
      agentCapabilities: { _meta: { kiro: { extensionMethods: declared } } },
    };
    type WithExtra = AcpExtensionHandshakeMeta & Record<string, unknown>;

    // protocolVersion at the InitializeResult root — the field the SDK
    // actually carries, the likeliest gate target, and the field the fault
    // injection that defeated the prior grep-only pin read. Low numeric so a
    // `< n` gate trips, plus a high string form.
    const lowProtocol: WithExtra = { ...baseline, protocolVersion: 1 };
    const highProtocol: WithExtra = {
      ...baseline,
      protocolVersion: '2025-06-18',
    };

    // A vendor `version` under the declared key, and a root `version` string —
    // the other observed shapes a gate might consult.
    const vendorVersion: WithExtra = {
      agentCapabilities: {
        _meta: { kiro: { extensionMethods: declared, version: '2.16.0' } },
      },
    };
    const rootVersion: WithExtra = { ...baseline, version: '2.16.0' };

    expect(readDeclaredExtensionMethods(baseline).sort()).toEqual(expected);
    expect(readDeclaredExtensionMethods(lowProtocol).sort()).toEqual(expected);
    expect(readDeclaredExtensionMethods(highProtocol).sort()).toEqual(expected);
    expect(readDeclaredExtensionMethods(vendorVersion).sort()).toEqual(
      expected,
    );
    expect(readDeclaredExtensionMethods(rootVersion).sort()).toEqual(expected);
  });

  test('readDeclaredExtensionMethods reads only agentCapabilities._meta and the extensionMethods arrays beneath it', () => {
    // The general property, checked directly rather than by enumerating field
    // names: readDeclaredExtensionMethods reads agentCapabilities._meta and the
    // extensionMethods arrays beneath it, and NOTHING else in the handshake. A
    // version gate must READ a version field to gate on it; whatever that
    // field is named and wherever it lives (root protocolVersion, a vendor
    // version under agentCapabilities, a field neither of us has imagined),
    // reading it is a property access outside the structural walk, and this
    // assertion catches it. The behavioural fixtures above fail faster and read
    // more clearly when they do; this one holds for the names nobody thought
    // of yet.
    //
    // Mechanism: wrap the handshake in a recording Proxy whose get / has /
    // ownKeys / getOwnPropertyDescriptor traps log every access as a dotted
    // path, then reject any access outside the permitted structural set.
    // Object.entries(meta) legitimately fires ownKeys + getOwnPropertyDescriptor
    // + get for every own key of _meta, so all of those are permitted at the
    // _meta level; only the structural keys are permitted above it.

    type AccessOp = 'get' | 'has' | 'ownKeys' | 'getOwnPropertyDescriptor';
    type Access = { path: string; op: AccessOp; key?: string };

    function recordAccesses(root: AcpExtensionHandshakeMeta): {
      proxy: AcpExtensionHandshakeMeta;
      accesses: Access[];
    } {
      const accesses: Access[] = [];
      // Cache the PROXY, not the raw target. A WeakSet that returns the raw
      // object on a repeat visit (the prior shape) makes every read off a
      // twice-reached object invisible to `accesses` — a version gate that
      // re-reads agentCapabilities passes silently. Keying on the raw value to
      // its Proxy means a repeat visit returns the same recording Proxy, so a
      // second read of any object is still instrumented.
      const wrapped = new WeakMap<object, object>();

      const wrap = <T extends object>(value: T, path: string): T => {
        // Arrays are returned unwrapped so iteration (length / indexes /
        // Symbol.iterator) is not recorded as noise; the structural reads a
        // version gate would touch live above any array, not inside it. Arrays
        // are never proxied and never cached.
        if (Array.isArray(value)) return value;
        const cached = wrapped.get(value);
        if (cached) return cached as T;
        const proxy: T = new Proxy(value, {
          get(target, key, receiver) {
            if (typeof key === 'string') {
              accesses.push({ path, op: 'get', key });
            }
            const next = Reflect.get(target, key, receiver);
            if (next && typeof next === 'object' && !Array.isArray(next)) {
              // key is string | symbol; String(...) avoids the symbol→string
              // template-literal coercion (a symbol property whose value is an
              // object would otherwise throw at runtime, and TS2731 flags it).
              return wrap(
                next as object,
                path ? `${path}.${String(key)}` : String(key),
              );
            }
            return next;
          },
          has(target, key) {
            if (typeof key === 'string') {
              accesses.push({ path, op: 'has', key });
            }
            return Reflect.has(target, key);
          },
          ownKeys(target) {
            accesses.push({ path, op: 'ownKeys' });
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, key) {
            if (typeof key === 'string') {
              accesses.push({ path, op: 'getOwnPropertyDescriptor', key });
            }
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        }) as T;
        wrapped.set(value, proxy as object);
        return proxy;
      };

      const proxy = wrap(
        root as unknown as object,
        '',
      ) as AcpExtensionHandshakeMeta;
      return { proxy, accesses };
    }

    // A multi-vendor handshake exercising the full walk: two declared
    // namespaces plus one _meta entry with no extensionMethods (the branch
    // that probes a value but finds no array).
    const handshake: AcpExtensionHandshakeMeta = {
      agentCapabilities: {
        _meta: {
          kiro: { extensionMethods: ['_kiro/foo', '_kiro/bar'] },
          other: { extensionMethods: ['_other/baz'] },
          notype: { note: 'no extensionMethods here' },
        },
      },
    };

    const { proxy, accesses } = recordAccesses(handshake);
    const result = readDeclaredExtensionMethods(proxy).sort();

    // Sanity: the walk still produced the right list through the proxy.
    expect(result).toEqual(['_kiro/bar', '_kiro/foo', '_other/baz']);

    // Permitted structural access:
    //   - root:               get(agentCapabilities) only
    //   - agentCapabilities:  get(_meta) only
    //   - _meta:              ownKeys + getOwnPropertyDescriptor + get (any own
    //                         key) — the legitimate Object.entries walk
    //   - each value below    get(extensionMethods) only — the only field the
    //     _meta:              walk reads off a vendor namespace
    const violations: string[] = [];
    for (const a of accesses) {
      if (a.path === '') {
        if (a.op === 'get' && a.key === 'agentCapabilities') continue;
        violations.push(`root.${a.op}(${a.key ?? ''})`);
      } else if (a.path === 'agentCapabilities') {
        if (a.op === 'get' && a.key === '_meta') continue;
        violations.push(`agentCapabilities.${a.op}(${a.key ?? ''})`);
      } else if (a.path === 'agentCapabilities._meta') {
        // The Object.entries walk: enumeration and read of every own key is
        // permitted here by design — no violation is pushed, so this branch
        // is intentionally empty.
      } else {
        // A value beneath _meta: only extensionMethods is read by the walk. A
        // version field read here (e.g. _meta.<vendor>.version) is still a
        // gate and still a violation.
        if (a.op === 'get' && a.key === 'extensionMethods') continue;
        violations.push(`${a.path}.${a.op}(${a.key ?? ''})`);
      }
    }
    expect(
      violations,
      `readDeclaredExtensionMethods read properties outside agentCapabilities._meta -> extensionMethods: ${violations.join(', ')}`,
    ).toEqual([]);
  });

  test('the channel source spawns no subprocess and parses no CLI version flag', () => {
    // The distinct spawn-a-binary mechanism: banning the literal CLI version
    // flag (the only way to ask a binary for its version) and any import of
    // node:child_process (the only way to spawn it) keeps that path closed.
    // Weaker than the behavioural assertion above — kept alongside, not
    // instead of it.
    const source = readFileSync(channelSourcePath, 'utf8');
    expect(source).not.toContain('--version');
    expect(source).not.toMatch(
      /node:child_process|from\s+['"]child_process['"]/,
    );
  });
});
