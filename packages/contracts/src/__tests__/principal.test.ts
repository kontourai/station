import { describe, expect, it } from 'vitest';
import {
  agentPrincipal,
  humanPrincipal,
  InvalidPrincipalComponentError,
  isPrincipalRef,
  LOCAL_OPERATOR_PROVIDER,
  LOCAL_OPERATOR_SUBJECT,
  principalIdMatchesKind,
  ReservedPrincipalKindError,
  ReservedPrincipalProviderError,
  servicePrincipal,
  tenantPrincipal,
} from '../principal.js';

describe('PrincipalRef — human', () => {
  it('builds a kind-prefixed human id from provider + subject, never the display', () => {
    const principal = humanPrincipal(
      'tailscale-serve',
      'brian@example.test',
      'Brian',
    );
    expect(principal).toEqual({
      id: 'human:tailscale-serve:brian@example.test',
      kind: 'human',
      display: 'Brian',
    });
  });

  it('allows colons, unicode, and uppercase in subject (it is always the final segment) and round-trips them', () => {
    const principal = humanPrincipal('a', 'b:c', 'Display');
    expect(principal.id).toBe('human:a:b:c');
    expect(principalIdMatchesKind(principal.id, 'human')).toBe(true);

    const unicode = humanPrincipal('a', 'Brián', 'Display');
    expect(unicode.id).toBe('human:a:Brián');
    expect(principalIdMatchesKind(unicode.id, 'human')).toBe(true);
  });

  it('rejects a provider containing a colon rather than fabricating a colliding id', () => {
    // This is the exact collision FINDING 1 named: humanPrincipal('a:b','c')
    // must NOT produce the same id as humanPrincipal('a','b:c').
    expect(() => humanPrincipal('a:b', 'c', 'Display')).toThrow(
      InvalidPrincipalComponentError,
    );
  });

  it('rejects an empty provider or subject rather than fabricating an id', () => {
    expect(() => humanPrincipal('', 'brian', 'Brian')).toThrow(
      InvalidPrincipalComponentError,
    );
    expect(() => humanPrincipal('tailscale-serve', '', 'Brian')).toThrow(
      InvalidPrincipalComponentError,
    );
  });

  it('N5 (round 2): rejects a whitespace-only subject — it names nobody', () => {
    expect(() => humanPrincipal('tailscale-serve', '   ', 'Brian')).toThrow(
      InvalidPrincipalComponentError,
    );
    expect(() => humanPrincipal('tailscale-serve', '\t\n', 'Brian')).toThrow(
      InvalidPrincipalComponentError,
    );
    // principalIdMatchesKind (and therefore isPrincipalRef) independently
    // reject a hand-built id carrying a whitespace-only subject too — the
    // guard is not only at construction time.
    expect(principalIdMatchesKind('human:a: ', 'human')).toBe(false);
  });

  // station#4075 stage 1 review round 3: the title above used to claim
  // "whitespace/control-only" coverage without ever testing a control
  // character — `trim()` does not strip control bytes, so
  // `humanPrincipal('a', '\u0000', 'D')` minted `human:a:\u0000` (a NUL
  // embedded in an identity id, a downstream log/serialization hazard).
  // These three tests are the actual discriminating coverage. Control
  // characters are built via `String.fromCharCode` rather than a `\u0000`
  // source literal so this test file itself never needs to contain a raw
  // control byte to exercise the guard.
  it('N5 (round 3): rejects a subject that is ONLY a control character (e.g. NUL)', () => {
    const nul = String.fromCharCode(0);
    // Capture the return value (rather than only asserting `toThrow`) so a
    // regression that silently mints a control-byte-bearing id shows that
    // exact minted id (with the raw NUL visible in the JSON-escaped diff)
    // in the failure output instead of a generic "expected throw" message.
    let minted: unknown;
    let thrown: unknown;
    try {
      minted = humanPrincipal('tailscale-serve', nul, 'Brian');
    } catch (error) {
      thrown = error;
    }
    expect(minted).toBeUndefined();
    expect(thrown).toBeInstanceOf(InvalidPrincipalComponentError);
    // Same rejection for a hand-built id, not just at construction time.
    expect(principalIdMatchesKind(`human:a:${nul}`, 'human')).toBe(false);
  });

  it('N5 (round 3): rejects a subject with an EMBEDDED control character, even alongside printable content', () => {
    const embedded = `a${String.fromCharCode(0)}b`;
    let minted: unknown;
    let thrown: unknown;
    try {
      minted = humanPrincipal('tailscale-serve', embedded, 'Brian');
    } catch (error) {
      thrown = error;
    }
    expect(minted).toBeUndefined();
    expect(thrown).toBeInstanceOf(InvalidPrincipalComponentError);
    expect(principalIdMatchesKind(`human:a:${embedded}`, 'human')).toBe(false);
  });

  it('N5 (round 3, discriminating control): a genuinely printable unicode subject still passes', () => {
    const principal = humanPrincipal('tailscale-serve', 'Brián', 'Brian');
    expect(principal.id).toBe('human:tailscale-serve:Brián');
    expect(principalIdMatchesKind(principal.id, 'human')).toBe(true);
  });

  it('N2: rejects an empty or whitespace-only display', () => {
    expect(() => humanPrincipal('tailscale-serve', 'brian', '')).toThrow(
      InvalidPrincipalComponentError,
    );
    expect(() => humanPrincipal('tailscale-serve', 'brian', '   ')).toThrow(
      InvalidPrincipalComponentError,
    );
  });

  it('N1: humanPrincipal REFUSES to mint the reserved local-operator provider, for any caller', () => {
    // Before this guard, any caller holding the two exported constants
    // could forge the exact `human:local:operator` id with no authority
    // check at all — humanPrincipal('local','operator','Forged') minted it.
    // Capture the return value (rather than only asserting `toThrow`) so a
    // regression that silently mints the forged operator shows that exact
    // forged principal in the failure diff instead of a generic "expected
    // throw" message.
    let forged: unknown;
    let thrown: unknown;
    try {
      forged = humanPrincipal(
        LOCAL_OPERATOR_PROVIDER,
        LOCAL_OPERATOR_SUBJECT,
        'Forged',
      );
    } catch (error) {
      thrown = error;
    }
    expect(forged).toBeUndefined();
    expect(thrown).toBeInstanceOf(ReservedPrincipalProviderError);
    expect((thrown as Error).message).toMatch(/reserved/i);
  });

  it('N1: isPrincipalRef still ACCEPTS the human:local:operator shape — validators describe, constructors mint', () => {
    // The asymmetry is the point: isPrincipalRef answers "is this
    // well-shaped", not "may this be minted". Only the authority-gated
    // resolver (principal-resolver.ts) is allowed to construct this exact
    // literal, and it does so WITHOUT calling humanPrincipal.
    expect(
      isPrincipalRef({
        id: `human:${LOCAL_OPERATOR_PROVIDER}:${LOCAL_OPERATOR_SUBJECT}`,
        kind: 'human',
        display: 'Operator',
      }),
    ).toBe(true);
  });
});

describe('PrincipalRef — service / agent', () => {
  it('builds a service principal id with a service: prefix', () => {
    const principal = servicePrincipal('invoke-user', 'Invoke API');
    expect(principal).toEqual({
      id: 'service:invoke-user',
      kind: 'service',
      display: 'Invoke API',
    });
  });

  it('a service id can never collide with a human id — kind-prefixed grammar', () => {
    // Pre-FINDING-1, servicePrincipal('tailscale-serve:alice') would have
    // shared a bare id with a human derived from that provider/subject.
    // Now every service slug is rejected if it contains a colon at all,
    // AND every service id carries its own `service:` prefix regardless.
    expect(() => servicePrincipal('tailscale-serve:alice', 'x')).toThrow(
      InvalidPrincipalComponentError,
    );
    const service = servicePrincipal('tailscale-serve', 'x');
    const human = humanPrincipal('tailscale-serve', 'alice', 'y');
    expect(service.id).not.toBe(human.id);
    expect(service.id.startsWith('service:')).toBe(true);
    expect(human.id.startsWith('human:')).toBe(true);
  });

  it('rejects an empty or colon-bearing service slug', () => {
    expect(() => servicePrincipal('', 'Invoke API')).toThrow(
      InvalidPrincipalComponentError,
    );
    expect(() => servicePrincipal('a:b', 'Invoke API')).toThrow(
      InvalidPrincipalComponentError,
    );
  });

  it('N2: rejects an empty or whitespace-only display', () => {
    expect(() => servicePrincipal('invoke-user', '')).toThrow(
      InvalidPrincipalComponentError,
    );
    expect(() => servicePrincipal('invoke-user', '  ')).toThrow(
      InvalidPrincipalComponentError,
    );
  });

  it('builds an agent principal id with an agent: prefix, same slug grammar', () => {
    const principal = agentPrincipal('voice', 'Voice');
    expect(principal).toEqual({
      id: 'agent:voice',
      kind: 'agent',
      display: 'Voice',
    });
    expect(() => agentPrincipal('a:b', 'x')).toThrow(
      InvalidPrincipalComponentError,
    );
  });

  it('N2: agentPrincipal also rejects an empty or whitespace-only display', () => {
    expect(() => agentPrincipal('voice', '')).toThrow(
      InvalidPrincipalComponentError,
    );
  });
});

/**
 * station#4075 stage 2 review round 3: `tenant` is RESERVED exactly like
 * `LOCAL_OPERATOR_PROVIDER` — no public constructor mints it. Unlike the
 * local-operator reservation (one specific `provider` value refused inside
 * `humanPrincipal`), the WHOLE kind is reserved, so `tenantPrincipal()`
 * itself always throws, regardless of input.
 */
describe('PrincipalRef — tenant (reserved)', () => {
  it('tenantPrincipal() ALWAYS throws — no public constructor mints this kind', () => {
    expect(() => tenantPrincipal('alpha', 'Alpha')).toThrow(
      ReservedPrincipalKindError,
    );
    // Not a validation-shaped refusal (a bad slug, a bad display) — it
    // refuses even a perfectly well-formed request, proving the reservation
    // is unconditional.
    expect(() => tenantPrincipal('a', 'A')).toThrow(ReservedPrincipalKindError);
  });

  it('a tenant:<id> shape still parses under isPrincipalRef/principalIdMatchesKind — validators describe, constructors mint', () => {
    // Same asymmetry N1 proves for human:local:operator: the SHAPE is
    // well-formed and describable even though no public constructor may
    // MINT it — only the authority-gated resolver may.
    expect(principalIdMatchesKind('tenant:alpha', 'tenant')).toBe(true);
    expect(
      isPrincipalRef({ id: 'tenant:alpha', kind: 'tenant', display: 'alpha' }),
    ).toBe(true);
  });

  it('a tenant id must match the same slug grammar as service/agent — no colons, lowercase-and-hyphen only', () => {
    expect(principalIdMatchesKind('tenant:a:b', 'tenant')).toBe(false);
    expect(principalIdMatchesKind('tenant:', 'tenant')).toBe(false);
    expect(principalIdMatchesKind('tenant:Alpha', 'tenant')).toBe(false);
    expect(principalIdMatchesKind('tenant:alpha_co', 'tenant')).toBe(false);
  });

  it('a tenant id can never collide with a service/agent/human id — kind-prefixed grammar', () => {
    expect(principalIdMatchesKind('tenant:alpha', 'service')).toBe(false);
    expect(principalIdMatchesKind('tenant:alpha', 'agent')).toBe(false);
    expect(principalIdMatchesKind('tenant:alpha', 'human')).toBe(false);
  });
});

describe('principalIdMatchesKind', () => {
  it('accepts every constructor-built id under its own kind', () => {
    expect(
      principalIdMatchesKind(humanPrincipal('a', 'b', 'x').id, 'human'),
    ).toBe(true);
    expect(
      principalIdMatchesKind(servicePrincipal('svc', 'x').id, 'service'),
    ).toBe(true);
    expect(principalIdMatchesKind(agentPrincipal('a', 'x').id, 'agent')).toBe(
      true,
    );
  });

  it('rejects a well-formed id parsed against the WRONG kind', () => {
    const serviceId = servicePrincipal('invoke-user', 'x').id;
    expect(principalIdMatchesKind(serviceId, 'human')).toBe(false);
    expect(principalIdMatchesKind(serviceId, 'agent')).toBe(false);
  });

  it('rejects a human id missing the subject segment', () => {
    expect(principalIdMatchesKind('human:provider-only', 'human')).toBe(false);
    expect(principalIdMatchesKind('human:', 'human')).toBe(false);
  });

  it('rejects a service/agent id carrying a colon in its slug', () => {
    expect(principalIdMatchesKind('service:a:b', 'service')).toBe(false);
  });
});

describe('isPrincipalRef', () => {
  it('accepts a well-shaped, grammar-valid value', () => {
    expect(
      isPrincipalRef({ id: 'human:a:b', kind: 'human', display: 'A' }),
    ).toBe(true);
    expect(
      isPrincipalRef({
        id: 'service:invoke-user',
        kind: 'service',
        display: 'A',
      }),
    ).toBe(true);
  });

  it('rejects an id whose grammar does not match its declared kind (was a bare shape sniff)', () => {
    // FINDING 1: the old isPrincipalRef accepted ANY non-empty id string —
    // it must now reject a service-shaped id declared as kind:'human'.
    expect(
      isPrincipalRef({
        id: 'service:invoke-user',
        kind: 'human',
        display: 'A',
      }),
    ).toBe(false);
    expect(
      isPrincipalRef({ id: 'not-namespaced', kind: 'human', display: 'A' }),
    ).toBe(false);
  });

  it('rejects a missing id, unknown kind, or wrong-typed display', () => {
    expect(isPrincipalRef({ kind: 'human', display: 'A' })).toBe(false);
    expect(
      isPrincipalRef({ id: 'human:a:b', kind: 'robot', display: 'A' }),
    ).toBe(false);
    expect(isPrincipalRef({ id: 'human:a:b', kind: 'human', display: 1 })).toBe(
      false,
    );
    expect(isPrincipalRef(null)).toBe(false);
    expect(isPrincipalRef('a')).toBe(false);
  });

  it('N2: rejects a hand-built ref with an empty or whitespace-only display (belt for hand-built refs)', () => {
    expect(
      isPrincipalRef({ id: 'human:a:b', kind: 'human', display: '' }),
    ).toBe(false);
    expect(
      isPrincipalRef({ id: 'human:a:b', kind: 'human', display: '   ' }),
    ).toBe(false);
  });

  it('N4: rejects an array, even one carrying id/kind/display as own properties', () => {
    const forged = Object.assign([], {
      id: 'human:a:b',
      kind: 'human',
      display: 'A',
    });
    expect(Array.isArray(forged)).toBe(true);
    expect(isPrincipalRef(forged)).toBe(false);
  });

  it('rejects unknown extra fields', () => {
    expect(
      isPrincipalRef({
        id: 'human:a:b',
        kind: 'human',
        display: 'A',
        extra: 'nope',
      }),
    ).toBe(false);
  });
});
