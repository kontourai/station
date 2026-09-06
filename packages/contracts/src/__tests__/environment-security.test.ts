import { describe, expect, test } from 'vitest';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  DEVICE_PAIRING_BROWSER_COOKIE_DELIVERY,
  DEVICE_PAIRING_SCOPE,
  type DevicePairingBrowserExchangeResponse,
  ENVIRONMENT_SECURITY_SCHEMA_VERSION,
  type EnvironmentSecurityRecord,
  isPairingScopeSubset,
  PAIRING_SCOPE_ACCESS_APPROVE,
  PAIRING_SCOPE_ACCESS_MANAGE,
  PAIRING_SCOPE_CONSENT_DECIDE,
  PAIRING_SCOPE_GRANT_PATHS,
  PAIRING_SCOPE_HOME_CONTROL,
  PAIRING_SCOPE_HOME_TRANSFER,
  PAIRING_SCOPE_INFERENCE_INVOKE,
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  PAIRING_SCOPE_ORCHESTRATION_READ,
  PAIRING_SCOPE_PRESETS,
  PAIRING_SCOPE_TERMINAL_OPERATE,
  PAIRING_SCOPES,
  type PairingScope,
  PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  PUBLIC_STATION_HANDSHAKE_PATH,
  type PublicStationHandshake,
  pairingScopeIncludes,
  pairingScopePresetString,
  parsePairingScope,
  REMOTE_AUTH_PROTOCOL_VERSION,
  STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
  type StationCapabilityFlags,
} from '../environment-security.js';

describe('environment security contracts', () => {
  test('owns the exact versioned public handshake path', () => {
    expect(PUBLIC_STATION_HANDSHAKE_PATH).toBe('/.well-known/station/v1');
  });
  test('fixes the private record at one versioned identity and credential shape', () => {
    const record = {
      schemaVersion: ENVIRONMENT_SECURITY_SCHEMA_VERSION,
      environmentId: 'environment-fixture',
      credential: 'credential-fixture',
    } satisfies EnvironmentSecurityRecord;

    expect(Object.keys(record).sort()).toEqual([
      'credential',
      'environmentId',
      'schemaVersion',
    ]);
  });

  test('keeps browser pairing exchange metadata credential-free', () => {
    const exchange = {
      environmentId: 'environment-fixture',
      device: {
        id: 'device-fixture',
        name: 'Phone',
        scope: 'station:interactive',
        kind: 'device',
        createdAt: 1,
        activityTracking: 'tracked-since-issued',
        lastSeenFrom: null,
        usageCount: 0,
        lastActiveDay: null,
        revokedAt: null,
        revocation: { state: 'not-revoked' },
      },
      delivery: DEVICE_PAIRING_BROWSER_COOKIE_DELIVERY,
    } satisfies DevicePairingBrowserExchangeResponse;

    expect(exchange).not.toHaveProperty('credential');
    expect(Object.keys(exchange).sort()).toEqual([
      'delivery',
      'device',
      'environmentId',
    ]);
  });

  test('fixes the public handshake to exact minimal versioned keys', () => {
    const handshake = {
      schemaVersion: PUBLIC_HANDSHAKE_SCHEMA_VERSION,
      environmentId: 'environment-fixture',
      authentication: {
        scheme: 'bearer',
        protocolVersion: REMOTE_AUTH_PROTOCOL_VERSION,
      },
      transports: {
        http: REMOTE_AUTH_PROTOCOL_VERSION,
        sse: REMOTE_AUTH_PROTOCOL_VERSION,
        websocket: REMOTE_AUTH_PROTOCOL_VERSION,
      },
      compatibility: {
        serverVersion: '0.4.1',
        protocolVersion: STATION_COMPAT_PROTOCOL_VERSION,
        minClientProtocol: STATION_COMPAT_MIN_CLIENT_PROTOCOL,
      },
    } satisfies PublicStationHandshake;

    expect(Object.keys(handshake).sort()).toEqual([
      'authentication',
      'compatibility',
      'environmentId',
      'schemaVersion',
      'transports',
    ]);
    expect(Object.keys(handshake.authentication).sort()).toEqual([
      'protocolVersion',
      'scheme',
    ]);
    expect(Object.keys(handshake.transports).sort()).toEqual([
      'http',
      'sse',
      'websocket',
    ]);
    const allKeys = [
      ...Object.keys(handshake),
      ...Object.keys(handshake.authentication),
      ...Object.keys(handshake.transports),
    ];
    for (const sensitiveKey of [
      'credential',
      'secret',
      'token',
      'user',
      'home',
      'workspace',
      'hostname',
      'endpoint',
      'port',
    ]) {
      expect(allKeys).not.toContain(sensitiveKey);
    }
  });
});

describe('handshake capability flags (station#1095, AC1: two-way fixture decode)', () => {
  /** Everything a pre-#1095 handshake consumer's type declaration knows about. */
  interface PreCapabilitiesHandshake {
    schemaVersion: number;
    environmentId: string;
    authentication: { scheme: 'bearer'; protocolVersion: number };
    transports: { http: number; sse: number; websocket: number };
  }

  const OLD_PAYLOAD_NO_CAPABILITIES = {
    schemaVersion: PUBLIC_HANDSHAKE_SCHEMA_VERSION,
    environmentId: 'environment-fixture',
    authentication: {
      scheme: 'bearer',
      protocolVersion: REMOTE_AUTH_PROTOCOL_VERSION,
    },
    transports: {
      http: REMOTE_AUTH_PROTOCOL_VERSION,
      sse: REMOTE_AUTH_PROTOCOL_VERSION,
      websocket: REMOTE_AUTH_PROTOCOL_VERSION,
    },
    compatibility: {
      serverVersion: '0.4.1',
      protocolVersion: STATION_COMPAT_PROTOCOL_VERSION,
      minClientProtocol: STATION_COMPAT_MIN_CLIENT_PROTOCOL,
    },
  } satisfies PublicStationHandshake;

  const NEW_PAYLOAD_WITH_CAPABILITIES = {
    ...OLD_PAYLOAD_NO_CAPABILITIES,
    capabilities: {
      sshEnvironments: true,
      webPushNotifications: false,
    } satisfies StationCapabilityFlags,
  } satisfies PublicStationHandshake;

  test('new code decodes an old-shaped payload (no `capabilities` field) fine', () => {
    const wire = JSON.parse(JSON.stringify(OLD_PAYLOAD_NO_CAPABILITIES));
    // The whole point of every field being optional: this type-checks and
    // decodes with no missing required field, on a payload from a host that
    // predates station#1095.
    const decoded: PublicStationHandshake = wire;

    expect(decoded.capabilities).toBeUndefined();
    expect(decoded.environmentId).toBe('environment-fixture');
  });

  test('an old-shaped consumer decodes a new payload (with `capabilities`) fine, ignoring the unknown field', () => {
    const wire = JSON.parse(JSON.stringify(NEW_PAYLOAD_WITH_CAPABILITIES));
    const decoded: PreCapabilitiesHandshake = wire;

    expect(decoded.environmentId).toBe('environment-fixture');
    expect(decoded.schemaVersion).toBe(PUBLIC_HANDSHAKE_SCHEMA_VERSION);
    expect(decoded.authentication.scheme).toBe('bearer');
    // The extra field is present on the wire object but not part of the old
    // type's contract — an old-shaped consumer simply never reads it.
    expect((wire as PublicStationHandshake).capabilities).toEqual({
      sshEnvironments: true,
      webPushNotifications: false,
    });
  });

  test('absence of the whole object AND absence of an individual key both mean unsupported', () => {
    // Widened to the interface type (not `satisfies`, which would keep the
    // narrow literal type and hide the very optionality this test proves).
    const noObject: PublicStationHandshake = OLD_PAYLOAD_NO_CAPABILITIES;
    const partialObject: PublicStationHandshake = {
      ...OLD_PAYLOAD_NO_CAPABILITIES,
      capabilities: { sshEnvironments: true },
    };

    expect(noObject.capabilities).toBeUndefined();
    expect(partialObject.capabilities?.sshEnvironments).toBe(true);
    expect(partialObject.capabilities?.webPushNotifications).toBeUndefined();
  });
});

describe('scoped pairing (station#1098)', () => {
  test('defines the exact vocabulary, including distinct home transfer and control authorities', () => {
    expect(PAIRING_SCOPES).toEqual([
      'orchestration:read',
      'orchestration:operate',
      'terminal:operate',
      'access:manage',
      'inference:invoke',
      'access:approve',
      'consent:decide',
      'home:transfer',
      'home:control',
    ]);
  });

  test('the read-only preset is exactly orchestration:read', () => {
    expect(PAIRING_SCOPE_PRESETS['read-only']).toEqual([
      PAIRING_SCOPE_ORCHESTRATION_READ,
    ]);
    expect(pairingScopePresetString('read-only')).toBe('orchestration:read');
  });

  test('the standard preset grants read, operate, and terminal but withholds access:manage', () => {
    expect(PAIRING_SCOPE_PRESETS.standard).toEqual([
      PAIRING_SCOPE_ORCHESTRATION_READ,
      PAIRING_SCOPE_ORCHESTRATION_OPERATE,
      PAIRING_SCOPE_TERMINAL_OPERATE,
    ]);
    expect(pairingScopePresetString('standard')).toBe(
      'orchestration:read orchestration:operate terminal:operate',
    );
    expect(PAIRING_SCOPE_PRESETS.standard).not.toContain(
      PAIRING_SCOPE_ACCESS_MANAGE,
    );
  });

  test('station#1123 slice 1: the delegation preset is exactly read+operate, distinct from standard', () => {
    expect(PAIRING_SCOPE_PRESETS.delegation).toEqual([
      PAIRING_SCOPE_ORCHESTRATION_READ,
      PAIRING_SCOPE_ORCHESTRATION_OPERATE,
    ]);
    expect(pairingScopePresetString('delegation')).toBe(
      'orchestration:read orchestration:operate',
    );
    // Not terminal:operate — the whole point of a dedicated preset (design
    // doc §2, correction 1: `standard` cannot express "minus terminal").
    expect(PAIRING_SCOPE_PRESETS.delegation).not.toContain(
      PAIRING_SCOPE_TERMINAL_OPERATE,
    );
    // Distinct scope SET from standard, not merely a different name for it.
    expect(PAIRING_SCOPE_PRESETS.delegation).not.toEqual(
      PAIRING_SCOPE_PRESETS.standard,
    );
    expect(
      isPairingScopeSubset(
        pairingScopePresetString('delegation'),
        pairingScopePresetString('standard'),
      ),
    ).toBe(true);
    expect(
      isPairingScopeSubset(
        pairingScopePresetString('standard'),
        pairingScopePresetString('delegation'),
      ),
    ).toBe(false);
  });

  /**
   * This block replaces station#1098's `FULL_PAIRING_SCOPE === PAIRING_SCOPES
   * .join(' ')` pin, which station#1398 slice 2 treated as its deliberate
   * forcing function: that assertion existed so growing the vocabulary could
   * not be absorbed silently, and it did its job — adding `inference:invoke`
   * turned it red and forced the decoupling to be reviewed rather than merged
   * past. It is edited, not deleted, and the properties it protected are now
   * pinned separately and more precisely (`docs/design/inference-fleet.md`
   * §11 slice 2, points 1, 2 and 4).
   */
  test('the default grant is the frozen historical four-token string, byte-for-byte', () => {
    // Pinned as a LITERAL, not derived. Three live populations emit exactly
    // this string — an offer that omits a scope, a credential migrated from
    // a pre-scoping registry, and the operator bootstrap credential — and
    // every peer that predates a vocabulary addition must keep parsing it.
    // If a future change makes this assertion fail, it is granting a new
    // scope to all three populations at once AND handing older peers a
    // string their `parsePairingScope` rejects outright.
    expect(DEFAULT_GRANT_PAIRING_SCOPE).toBe(
      'orchestration:read orchestration:operate terminal:operate access:manage',
    );
  });

  test('the default grant is NOT the whole vocabulary, and specifically withholds inference:invoke', () => {
    const granted = parsePairingScope(DEFAULT_GRANT_PAIRING_SCOPE);
    expect(granted).not.toBeNull();
    expect(granted).toHaveLength(4);
    expect(granted).not.toContain(PAIRING_SCOPE_INFERENCE_INVOKE);
    // The decoupling itself: derived-from-the-vocabulary is exactly what
    // this constant must never be again.
    expect(DEFAULT_GRANT_PAIRING_SCOPE).not.toBe(PAIRING_SCOPES.join(' '));
    // station#1887 grew this to six, station#3677 to seven, and home transfer
    // to eight and home control to nine. The default
    // grant is unchanged and still four tokens — which is the whole point of
    // the decoupling: a vocabulary addition must not reach a single live
    // credential.
    expect(PAIRING_SCOPES).toHaveLength(9);
    expect(granted).not.toContain(PAIRING_SCOPE_ACCESS_APPROVE);
    expect(granted).not.toContain(PAIRING_SCOPE_CONSENT_DECIDE);
    expect(granted).not.toContain(PAIRING_SCOPE_HOME_TRANSFER);
    expect(granted).not.toContain(PAIRING_SCOPE_HOME_CONTROL);
  });

  // station#1883: the trip-wire for the defect that produced `access:manage`'s
  // holder population — a token with a large inherited audience and no
  // deliberate grant path, invisible to every existing test. The declaration
  // in `PAIRING_SCOPE_GRANT_PATHS` states how each token is obtained; these
  // check it against reality so it cannot drift into a comfortable fiction.
  describe('scope grant paths (station#1883)', () => {
    const presetTokens = new Set<PairingScope>(
      Object.values(PAIRING_SCOPE_PRESETS).flat(),
    );
    const defaultGrantTokens = new Set<PairingScope>(
      parsePairingScope(DEFAULT_GRANT_PAIRING_SCOPE) ?? [],
    );

    test('every token declares at least one way a human can obtain it', () => {
      // `Record<PairingScope, ...>` already makes a MISSING key a compile
      // error. This catches the other half: a key present but empty, which
      // would type-check while meaning "nobody can ever be granted this".
      for (const scope of PAIRING_SCOPES) {
        expect(
          PAIRING_SCOPE_GRANT_PATHS[scope].length,
          `${scope} declares no grant path`,
        ).toBeGreaterThan(0);
      }
    });

    test("a token declares 'preset' if and only if a preset actually grants it", () => {
      for (const scope of PAIRING_SCOPES) {
        const declared = PAIRING_SCOPE_GRANT_PATHS[scope].includes('preset');
        expect(
          declared,
          declared
            ? `${scope} claims a preset path but appears in no preset`
            : `${scope} appears in a preset but does not declare 'preset'`,
        ).toBe(presetTokens.has(scope));
      }
    });

    test("a token declares 'default-grant' if and only if the default grant carries it", () => {
      for (const scope of PAIRING_SCOPES) {
        const declared =
          PAIRING_SCOPE_GRANT_PATHS[scope].includes('default-grant');
        expect(
          declared,
          declared
            ? `${scope} claims the default grant but is not in it`
            : `${scope} is in the default grant but does not declare it`,
        ).toBe(defaultGrantTokens.has(scope));
      }
    });

    // The specific historical shape, pinned so a future edit has to argue with
    // it rather than drift past it: `access:manage` is inherited-only. It is
    // the sole token whose only path is the default grant, and adding it to a
    // preset would grant it at pairing time — when the device is least known.
    test('access:manage remains inherited-only, and is the only such token', () => {
      expect(PAIRING_SCOPE_GRANT_PATHS[PAIRING_SCOPE_ACCESS_MANAGE]).toEqual([
        'default-grant',
      ]);
      const inheritedOnly = PAIRING_SCOPES.filter(
        (scope) =>
          PAIRING_SCOPE_GRANT_PATHS[scope].length === 1 &&
          PAIRING_SCOPE_GRANT_PATHS[scope][0] === 'default-grant',
      );
      expect(inheritedOnly).toEqual([PAIRING_SCOPE_ACCESS_MANAGE]);
    });
  });

  test('station#1398 slice 2: the inference preset is the only grant of inference:invoke', () => {
    expect(PAIRING_SCOPE_PRESETS.inference).toEqual([
      PAIRING_SCOPE_INFERENCE_INVOKE,
    ]);
    expect(pairingScopePresetString('inference')).toBe('inference:invoke');
    expect(
      pairingScopeIncludes(
        pairingScopePresetString('inference'),
        PAIRING_SCOPE_INFERENCE_INVOKE,
      ),
    ).toBe(true);
    // No other preset leaks it — invoking is opt-in on the granting side,
    // symmetric with contributing being opt-in on the serving side.
    for (const preset of ['read-only', 'standard', 'delegation'] as const) {
      expect(PAIRING_SCOPE_PRESETS[preset]).not.toContain(
        PAIRING_SCOPE_INFERENCE_INVOKE,
      );
    }
    // And it grants nothing else: a fleet peer holding it cannot read
    // orchestration state, drive a turn, open a terminal, or manage devices.
    for (const withheld of [
      PAIRING_SCOPE_ORCHESTRATION_READ,
      PAIRING_SCOPE_ORCHESTRATION_OPERATE,
      PAIRING_SCOPE_TERMINAL_OPERATE,
      PAIRING_SCOPE_ACCESS_MANAGE,
    ]) {
      expect(
        pairingScopeIncludes(pairingScopePresetString('inference'), withheld),
      ).toBe(false);
    }
  });

  test('the home-transfer preset grants only planned home-transfer participation', () => {
    expect(PAIRING_SCOPE_PRESETS['home-transfer']).toEqual([
      PAIRING_SCOPE_HOME_TRANSFER,
    ]);
    expect(pairingScopePresetString('home-transfer')).toBe('home:transfer');
    expect(PAIRING_SCOPE_GRANT_PATHS[PAIRING_SCOPE_HOME_TRANSFER]).toEqual([
      'preset',
    ]);

    for (const [name, scopes] of Object.entries(PAIRING_SCOPE_PRESETS)) {
      if (name === 'home-transfer') continue;
      expect(scopes).not.toContain(PAIRING_SCOPE_HOME_TRANSFER);
    }

    for (const withheld of PAIRING_SCOPES.filter(
      (scope) => scope !== PAIRING_SCOPE_HOME_TRANSFER,
    )) {
      expect(
        pairingScopeIncludes(
          pairingScopePresetString('home-transfer'),
          withheld,
        ),
      ).toBe(false);
    }
  });

  test('home control requires fresh operator promotion and belongs to no preset or default grant', () => {
    expect(PAIRING_SCOPE_GRANT_PATHS[PAIRING_SCOPE_HOME_CONTROL]).toEqual([
      'operator-promotion',
    ]);
    expect(parsePairingScope(DEFAULT_GRANT_PAIRING_SCOPE)).not.toContain(
      PAIRING_SCOPE_HOME_CONTROL,
    );
    for (const scopes of Object.values(PAIRING_SCOPE_PRESETS)) {
      expect(scopes).not.toContain(PAIRING_SCOPE_HOME_CONTROL);
    }
  });

  test('old-peer compatibility: a client built against the four-token vocabulary still parses the default grant', () => {
    // NOTE (station#1398 slice 2 review, L-4 — recorded as a follow-up):
    // this simulation is a HAND-ROLLED restatement of `parsePairingScope`'s
    // algorithm, not the shipped v1 parser. It therefore proves the string
    // is parseable under the old VOCABULARY; it cannot catch a divergence
    // in the old parser's other rules (its length ceiling, its duplicate
    // handling, its whitespace behavior) because it re-implements them from
    // the current source rather than from the released one. The stronger
    // form is a byte-copy of the v1 parser pinned as a fixture, which is
    // filed as a follow-up rather than done here — a copied parser needs a
    // provenance note saying which release it came from, or the next reader
    // cannot tell it apart from this restatement.
    //
    // Simulates the parser of a peer that predates `inference:invoke` by
    // running the same algorithm over the same string with the OLD known-
    // token set. This is the regression the decoupling exists to prevent:
    // `parsePairingScope` returns null for the WHOLE string on one unknown
    // token, so a widened default grant would have been refused outright by
    // every older peer rather than degrading.
    const legacyVocabulary = new Set([
      'orchestration:read',
      'orchestration:operate',
      'terminal:operate',
      'access:manage',
    ]);
    const legacyParse = (value: string): string[] | null => {
      const seen = new Set<string>();
      for (const token of value.split(' ')) {
        if (!token || !legacyVocabulary.has(token) || seen.has(token)) {
          return null;
        }
        seen.add(token);
      }
      return [...seen];
    };

    expect(legacyParse(DEFAULT_GRANT_PAIRING_SCOPE)).toEqual([
      'orchestration:read',
      'orchestration:operate',
      'terminal:operate',
      'access:manage',
    ]);
    // Every preset an older peer could already be holding still parses too.
    for (const preset of ['read-only', 'standard', 'delegation'] as const) {
      expect(legacyParse(pairingScopePresetString(preset))).not.toBeNull();
    }
    // And a grant carrying the new token is refused rather than mangled —
    // the mixed-version failure the `fleetInference` handshake flag exists
    // to prevent, pinned so "refused" never quietly becomes "partially
    // granted".
    expect(legacyParse(pairingScopePresetString('inference'))).toBeNull();
    expect(legacyParse(pairingScopePresetString('home-transfer'))).toBeNull();
    expect(legacyParse('orchestration:read inference:invoke')).toBeNull();
    // This build, by contrast, parses it.
    expect(parsePairingScope('orchestration:read inference:invoke')).toEqual([
      'orchestration:read',
      'inference:invoke',
    ]);
  });

  test('parsePairingScope rejects empty, oversized, unknown, and duplicate-token strings', () => {
    expect(parsePairingScope('')).toBeNull();
    expect(parsePairingScope('x'.repeat(257))).toBeNull();
    expect(parsePairingScope('orchestration:read nonsense:scope')).toBeNull();
    expect(
      parsePairingScope('orchestration:read orchestration:read'),
    ).toBeNull();
    // The legacy pre-scoping marker is not itself a valid parsed scope
    // string — only DevicePairingService's registry loader special-cases it
    // for migration, never a generic scope consumer.
    expect(parsePairingScope(DEVICE_PAIRING_SCOPE)).toBeNull();
  });

  test('parsePairingScope accepts a space-delimited subset in any order, deduplicated by Set semantics', () => {
    expect(parsePairingScope('terminal:operate orchestration:read')).toEqual([
      'terminal:operate',
      'orchestration:read',
    ]);
  });

  test('pairingScopeIncludes checks one required scope against a multi-scope grant', () => {
    expect(
      pairingScopeIncludes(
        pairingScopePresetString('standard'),
        'terminal:operate',
      ),
    ).toBe(true);
    expect(
      pairingScopeIncludes(
        pairingScopePresetString('read-only'),
        'orchestration:operate',
      ),
    ).toBe(false);
    expect(
      pairingScopeIncludes('not a scope string', 'orchestration:read'),
    ).toBe(false);
  });

  test('isPairingScopeSubset: a session can never carry more authority than its grant (R1)', () => {
    expect(
      isPairingScopeSubset(
        pairingScopePresetString('read-only'),
        pairingScopePresetString('standard'),
      ),
    ).toBe(true);
    expect(
      isPairingScopeSubset(
        DEFAULT_GRANT_PAIRING_SCOPE,
        DEFAULT_GRANT_PAIRING_SCOPE,
      ),
    ).toBe(true);
    // A "session" claiming access:manage from a "grant" that never included it.
    expect(
      isPairingScopeSubset(
        DEFAULT_GRANT_PAIRING_SCOPE,
        pairingScopePresetString('standard'),
      ),
    ).toBe(false);
    expect(isPairingScopeSubset('garbage', DEFAULT_GRANT_PAIRING_SCOPE)).toBe(
      false,
    );
    expect(isPairingScopeSubset(DEFAULT_GRANT_PAIRING_SCOPE, 'garbage')).toBe(
      false,
    );
  });
});
