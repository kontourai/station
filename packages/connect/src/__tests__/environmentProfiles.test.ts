import { describe, expect, it } from 'vitest';
import {
  classifyEndpoint,
  connectionFailureCopy,
  createAccessEndpoint,
  FAILURE_COPY_REASONS,
  inferEndpointKind,
  selectCompatibleEndpoint,
} from '../core/environmentProfiles';
import type { ConnectionFailureReason } from '../core/types';

describe('environment endpoint profiles', () => {
  it('classifies same-origin, tailnet, LAN, and manual endpoints', () => {
    expect(
      inferEndpointKind(
        'https://station.example.test',
        'https://station.example.test',
      ),
    ).toBe('same-origin');
    expect(inferEndpointKind('https://station.example-tailnet.ts.net')).toBe(
      'tailnet-https',
    );
    expect(inferEndpointKind('https://192.168.1.20:3141')).toBe('lan-https');
    expect(inferEndpointKind('http://192.168.1.20:3141')).toBe('lan-http');
    expect(inferEndpointKind('https://station.example.test')).toBe('manual');
  });

  it('rejects HTTP mixed content from an HTTPS client with an actionable reason', () => {
    const endpoint = createAccessEndpoint('http://192.168.1.20:3141');
    expect(
      classifyEndpoint(endpoint, { clientProtocol: 'https:', online: true }),
    ).toEqual({ compatible: false, reason: 'mixed-content' });
  });

  it('chooses compatible tailnet HTTPS over blocked LAN HTTP without downgrading', () => {
    const lan = createAccessEndpoint('http://192.168.1.20:3141', {
      priority: 1,
    });
    const tailnet = createAccessEndpoint(
      'https://station.example-tailnet.ts.net',
      { priority: 2 },
    );
    const selected = selectCompatibleEndpoint([lan, tailnet], {
      clientProtocol: 'https:',
      online: true,
    });
    expect(selected.endpoint).toEqual(tailnet);
    expect(selected.failures.get(lan.id)).toBe('mixed-content');
  });

  it('returns offline for every candidate without attempting a downgrade', () => {
    const endpoint = createAccessEndpoint('https://station.example.test');
    const selected = selectCompatibleEndpoint([endpoint], {
      clientProtocol: 'https:',
      online: false,
    });
    expect(selected.endpoint).toBeNull();
    expect(selected.failures.get(endpoint.id)).toBe('offline');
  });

  it('never blocks an HTTP endpoint as mixed-content from a native shell page (station#1286)', () => {
    const endpoint = createAccessEndpoint('http://192.168.1.20:3141');
    expect(
      classifyEndpoint(endpoint, { clientProtocol: 'native:', online: true }),
    ).toEqual({ compatible: true });
  });

  it('still rejects HTTP mixed content from a genuine HTTPS LAN client (unchanged)', () => {
    const endpoint = createAccessEndpoint('http://192.168.1.20:3141');
    expect(
      classifyEndpoint(endpoint, { clientProtocol: 'https:', online: true }),
    ).toEqual({ compatible: false, reason: 'mixed-content' });
  });

  it('treats http://localhost and loopback IPs as trustworthy origins even from an HTTPS page', () => {
    for (const url of [
      'http://localhost:3141',
      'http://127.0.0.1:3141',
      'http://[::1]:3141',
    ]) {
      const endpoint = createAccessEndpoint(url);
      expect(
        classifyEndpoint(endpoint, { clientProtocol: 'https:', online: true }),
      ).toEqual({ compatible: true });
    }
  });

  it('rankCompatibleEndpoints keeps filtering a genuinely mixed-content LAN endpoint under native context, ranking it normally once compatible', () => {
    const lanHttp = createAccessEndpoint('http://192.168.1.20:3141', {
      priority: 1,
    });
    const tailnetHttps = createAccessEndpoint(
      'https://station.example-tailnet.ts.net',
      { priority: 2 },
    );
    const selected = selectCompatibleEndpoint([lanHttp, tailnetHttps], {
      clientProtocol: 'native:',
      online: true,
    });
    // Both are now compatible (native shell never mixed-content-blocks); the
    // lower-priority, higher-authority endpoint still wins the rank.
    expect(selected.endpoint).toEqual(lanHttp);
    expect(selected.failures.size).toBe(0);
  });

  /**
   * Derived from the shipped copy table, not hand-listed (station#3297). The
   * hand-maintained version of this array covered ten reasons; a new one
   * added to the union would have been exempt from every assertion below
   * until somebody remembered to append it here.
   */
  const DETERMINISTIC_FAILURE_REASONS = FAILURE_COPY_REASONS;

  it('covers every failure reason that is not awaiting-approval', () => {
    // The union's own membership, as the type system sees it. If a reason is
    // added without copy, `FAILURE_COPY`'s Record type fails to compile; if
    // one is added WITH copy, this list grows and every assertion below
    // starts applying to it automatically.
    const expected: ReadonlyArray<
      Exclude<ConnectionFailureReason, 'awaiting-approval'>
    > = [
      'offline',
      'mixed-content',
      'invalid-endpoint',
      'identity-mismatch',
      'access-method-mismatch',
      'authentication-failed',
      'host-unavailable',
      'unsupported-capability-version',
      'timeout',
      'unreachable',
      'server-restarted',
      'origin-not-allowed',
      'unexpected-response',
      'undetermined',
    ];
    expect([...DETERMINISTIC_FAILURE_REASONS].sort()).toEqual(
      [...expected].sort(),
    );
  });

  it('provides actionable copy for every deterministic failure reason', () => {
    for (const reason of DETERMINISTIC_FAILURE_REASONS) {
      expect(
        connectionFailureCopy(reason, 'kontour.example.ts.net').summary,
      ).toBeTruthy();
      expect(
        connectionFailureCopy(reason, 'kontour.example.ts.net').action,
      ).toBeTruthy();
    }
  });

  /**
   * station#1776 — the copy is written from the user's point of view and
   * must never leak the caller's placeholder back out: every reason names
   * the real host it was given, and none renders a literal "{host}" token
   * (constraint #1 of the connection-truth plan).
   */
  it('names the host the caller supplied and never renders a literal placeholder', () => {
    for (const reason of DETERMINISTIC_FAILURE_REASONS) {
      const copy = connectionFailureCopy(reason, 'Living Room Mac');
      expect(`${copy.summary} ${copy.action}`).not.toContain('{host}');
    }
    // Reasons whose shipped copy names the host directly (station#1776 table)
    // must actually contain it, not just avoid the placeholder token.
    for (const reason of [
      'identity-mismatch',
      'access-method-mismatch',
      'authentication-failed',
      'unsupported-capability-version',
      'timeout',
      'unreachable',
      'server-restarted',
      'mixed-content',
    ] as const) {
      const copy = connectionFailureCopy(reason, 'Living Room Mac');
      expect(`${copy.summary} ${copy.action}`).toContain('Living Room Mac');
    }
  });

  it('shows both the host and the address for unreachable, without repeating a single value twice', () => {
    const distinct = connectionFailureCopy(
      'unreachable',
      'Living Room Mac',
      'https://100.64.1.2:3141',
    );
    expect(distinct.summary).toBe(
      "Can't reach Living Room Mac (https://100.64.1.2:3141).",
    );

    // A caller with only one value (no separate saved name) must not render
    // the same string twice back to back.
    const single = connectionFailureCopy(
      'unreachable',
      'https://station.example.test',
    );
    expect(single.summary).toBe("Can't reach https://station.example.test.");
  });

  /**
   * station#1776 review (MEDIUM) — the signal `identity-mismatch` fires on
   * (the handshake's environment identity differing from what this device
   * last knew) is equally true of a reset/reinstalled host AND of a
   * *different* device now answering at the same address. The copy must
   * report only what was observed and offer the likely cause as a
   * possibility, never assert it as fact.
   */
  it('states the identity-mismatch cause as a possibility, never an asserted fact', () => {
    const copy = connectionFailureCopy('identity-mismatch', 'Living Room Mac');
    expect(copy.summary).toContain('Living Room Mac');
    // The summary reports only what was observed — never a specific,
    // unverified cause stated as fact.
    expect(copy.summary).not.toMatch(/reset or reinstalled/i);
    // The likely cause is offered as a possibility ("may have..."), not a
    // certainty, and still tells the reader what to do next.
    expect(copy.action).toMatch(/may have.*reset or reinstalled/i);
    expect(copy.action).toMatch(/pair again/i);
  });

  /**
   * station#3297 AC7 — no copy may speculate about the host's availability
   * unless the reason was derived from actually failing to reach it.
   *
   * The instance this pins: a stale credential rendered the `unreachable`
   * copy — "It may be off, asleep, or on another network" — from a host that
   * was answering 401 the whole time. Only 'unreachable' (a thrown fetch) and
   * 'offline' (the device's own link state) observe anything of the kind.
   * `mixed-content` is exempt for the opposite reason: the client DID
   * determine that this page cannot fetch that address, before sending
   * anything.
   */
  it('never speculates about the host being off, asleep, or elsewhere', () => {
    const unearnedAvailabilityClaim =
      /\boff\b|asleep|another network|your network|powered|switched on/i;
    for (const reason of DETERMINISTIC_FAILURE_REASONS) {
      if (
        reason === 'unreachable' ||
        reason === 'offline' ||
        reason === 'mixed-content'
      ) {
        continue;
      }
      const copy = connectionFailureCopy(reason, 'Living Room Mac');
      expect(`${copy.summary} ${copy.action}`).not.toMatch(
        unearnedAvailabilityClaim,
      );
    }
  });

  it('names the access this device does not have, beside the affordance it has', () => {
    const copy = connectionFailureCopy(
      'authentication-failed',
      'Living Room Mac',
    );
    expect(copy.summary).toBe("Living Room Mac isn't accepting this device.");
    // station#3903: it says what the status proves — this device is not
    // authorised there — and points at REQUEST ACCESS, which is the control
    // every surface rendering this sentence actually puts next to it.
    expect(copy.action).toMatch(/isn't authorised there/i);
    expect(copy.action).toMatch(/request access to Living Room Mac/i);
    // It must not claim the host is reachable either: this same reason is
    // produced by a native-transport refusal that never touched the network.
    expect(`${copy.summary} ${copy.action}`).not.toMatch(/reachable/i);
    // Nor may it say "revoked": a 401 cannot tell a withdrawn access from one
    // that was never valid, and this reason is also reached for a device that
    // was never configured at all.
    expect(`${copy.summary} ${copy.action}`).not.toMatch(/revoked|no longer/i);
  });

  /**
   * station#3849's shape, over this map: `docs/glossary.md` forbids
   * introducing "host" as a user-facing synonym for Station, and the property
   * is only worth anything if it holds for EVERY entry — so this iterates the
   * table rather than sampling it. The label deliberately contains no "host"
   * of its own, or the assertion would be about the caller's argument.
   */
  it('never says "host" — the vocabulary contract, over every entry', () => {
    for (const reason of DETERMINISTIC_FAILURE_REASONS) {
      const copy = connectionFailureCopy(
        reason,
        'Living Room Mac',
        'https://100.64.1.2:3141',
      );
      // `short` (station#4512 review L-new-2) is optional and gets the SAME
      // vocabulary contract as `summary`/`action` when an entry has one —
      // this table is the single source for reason wording, so nothing it
      // returns is exempt.
      for (const text of [copy.summary, copy.action, copy.short].filter(
        (value): value is string => value !== undefined,
      )) {
        expect(text, `${reason} says "host": ${text}`).not.toMatch(
          /\bhosts?\b/i,
        );
      }
    }
  });

  it('offers a host-side remedy for origin policy, never pairing', () => {
    const copy = connectionFailureCopy('origin-not-allowed', 'Living Room Mac');
    expect(copy.summary).toMatch(/won't accept requests from this app/i);
    // Pairing cannot change an allow-list decision — offering it would be a
    // fix that cannot work, the exact hazard station#1776 recorded for 403.
    expect(`${copy.summary} ${copy.action}`).not.toMatch(/pair/i);
  });

  it('asserts no cause at all for a failure nothing determined', () => {
    const copy = connectionFailureCopy('undetermined', 'Living Room Mac');
    expect(copy.summary).toBe(
      "Couldn't confirm the connection to Living Room Mac.",
    );
    expect(copy.action).toBe('Trying again shortly.');
  });

  /**
   * station#1776 AC2 — the vocabulary rule from the connection-truth plan:
   * none of these strings may describe the *code's* concept of the failure
   * in words the reader was never given.
   */
  it('never uses implementation vocabulary in FAILURE_COPY user-facing strings', () => {
    const bannedWords = [
      'endpoint',
      'credential',
      'environment',
      'loopback',
      'instance',
      'context',
    ];
    for (const reason of DETERMINISTIC_FAILURE_REASONS) {
      const copy = connectionFailureCopy(
        reason,
        'Living Room Mac',
        'https://100.64.1.2:3141',
      );
      const text =
        `${copy.summary} ${copy.action} ${copy.short ?? ''}`.toLowerCase();
      for (const banned of bannedWords) {
        expect(text).not.toContain(banned);
      }
    }
  });

  // station#4512 review (L-new-2): the row that used to hardcode this
  // string now consumes it from here — pinning it at the source keeps the
  // two from drifting apart.
  it('gives authentication-failed a short one-line form for a dominant-state line', () => {
    const copy = connectionFailureCopy(
      'authentication-failed',
      'Living Room Mac',
    );
    expect(copy.short).toBe("This device isn't authorised on this Station");
  });
});
