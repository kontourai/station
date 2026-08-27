import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { describe, expect, test } from 'vitest';
import {
  createNativeOutputGrantAuthority,
  type NativeOutputGrantFacts,
  type NativeOutputTurnLease,
} from '../native-output-turn-grant.js';

const facts = () => ({
  threadId: 'session-a',
  turnId: 'turn-a',
  adapterId: 'station',
  principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
  configurationLease: Object.freeze({ revision: 3 }),
});
const lease = { isCurrent: () => true };

describe('native output grant independent review regressions', () => {
  test('returns the bound native call identity for exact terminal admission', () => {
    const authority = createNativeOutputGrantAuthority();
    const grant = authority.issue(facts(), lease)!;
    const call = authority.bindNativeCall(grant, 'framework-call-a')!;
    authority.closeIssuance(grant);

    expect(authority.admit(call)).toMatchObject({
      threadId: 'session-a',
      turnId: 'turn-a',
      callId: 'framework-call-a',
    });
  });

  test('refuses issuance without a captured principal', () => {
    const authority = createNativeOutputGrantAuthority();

    expect(
      authority.issue(
        {
          ...facts(),
          principal: undefined,
        } as unknown as NativeOutputGrantFacts,
        lease,
      ),
    ).toBeNull();
    expect(
      authority.issue(
        { ...facts(), principal: null } as unknown as NativeOutputGrantFacts,
        lease,
      ),
    ).toBeNull();
  });

  test('snapshots principal attribution before caller input can change', () => {
    const authority = createNativeOutputGrantAuthority();
    const input = facts();
    const expectedPrincipal = { ...input.principal };
    const grant = authority.issue(input, lease)!;
    const call = authority.bindNativeCall(grant, 'framework-call-a')!;

    input.principal.id = humanPrincipal('test', 'owner-b', 'Owner B').id;
    input.principal.display = 'Owner B';

    expect(authority.admit(call)?.principal).toEqual(expectedPrincipal);
  });

  test('admitted facts cannot rewrite the principal of a later admission', () => {
    const authority = createNativeOutputGrantAuthority();
    const input = facts();
    const expectedPrincipal = { ...input.principal };
    const grant = authority.issue(input, lease)!;
    const call = authority.bindNativeCall(grant, 'framework-call-a')!;
    const admitted = authority.admit(call)!;

    Reflect.set(
      admitted.principal as object,
      'id',
      humanPrincipal('test', 'owner-b', 'Owner B').id,
    );

    expect(authority.admit(call)?.principal).toEqual(expectedPrincipal);
  });

  test('preserves an opaque owner lease by identity rather than cloning it', () => {
    class OwnerLease {
      #current = true;
      isCurrent() {
        return this.#current;
      }
    }
    const authority = createNativeOutputGrantAuthority();
    const configurationLease = new OwnerLease();
    const grant = authority.issue({ ...facts(), configurationLease }, lease)!;
    const call = authority.bindNativeCall(grant, 'framework-call-a')!;

    expect(authority.admit(call)?.configurationLease).toBe(configurationLease);
    expect(configurationLease.isCurrent()).toBe(true);
  });

  test('requires a current synchronous owner lease and fails closed otherwise', () => {
    const authority = createNativeOutputGrantAuthority();
    const absentLease = undefined as unknown as NativeOutputTurnLease;

    expect(authority.issue(facts(), absentLease)).toBeNull();
    expect(authority.issue(facts(), { isCurrent: () => false })).toBeNull();
    expect(
      authority.issue(facts(), {
        isCurrent: () => {
          throw new Error('gone');
        },
      } as NativeOutputTurnLease),
    ).toBeNull();
    expect(
      authority.issue(facts(), {
        isCurrent: async () => true,
      } as unknown as NativeOutputTurnLease),
    ).toBeNull();
  });

  test('captures the lease method once for the grant lifetime with its owner receiver', () => {
    const authority = createNativeOutputGrantAuthority();
    let reads = 0;
    let receiver: unknown;
    const ownerLease = Object.defineProperty({}, 'isCurrent', {
      configurable: true,
      get() {
        reads += 1;
        if (reads > 1) throw new Error('property reread');
        return function (this: unknown) {
          receiver = this;
          Object.defineProperty(ownerLease, 'isCurrent', {
            value: () => false,
          });
          return true;
        };
      },
    });

    const grant = authority.issue(
      facts(),
      ownerLease as NativeOutputTurnLease,
    )!;
    const scope = authority.bindNativeCall(grant, 'framework-call-a')!;

    expect(authority.admit(scope)).not.toBeNull();
    expect(reads).toBe(1);
    expect(receiver).toBe(ownerLease);
  });

  test('does not replace the issued lease checker after the owner property changes', () => {
    const authority = createNativeOutputGrantAuthority();
    let active = true;
    const ownerLease = {
      isCurrent: () => active,
    };
    const grant = authority.issue(facts(), ownerLease)!;
    const scope = authority.bindNativeCall(grant, 'framework-call-a')!;

    active = false;
    ownerLease.isCurrent = () => true;

    expect(authority.admit(scope)).toBeNull();
  });

  test('invokes the captured checker without its mutable call property', () => {
    const authority = createNativeOutputGrantAuthority();
    let active = true;
    const checker = () => active;
    const grant = authority.issue(facts(), { isCurrent: checker })!;
    const scope = authority.bindNativeCall(grant, 'framework-call-a')!;

    active = false;
    Object.defineProperty(checker, 'call', { value: () => true });

    expect(authority.admit(scope)).toBeNull();
  });

  test('rejects principal accessors and never allows their errors to escape', () => {
    const authority = createNativeOutputGrantAuthority();
    let reads = 0;
    const changingPrincipal = {
      get id() {
        reads += 1;
        return reads <= 2 ? 'human:test:owner-a' : 'not-a-principal';
      },
      kind: 'human',
      display: 'Owner A',
    };
    const throwingPrincipal = {
      get id() {
        throw new Error('principal getter escaped');
      },
      kind: 'human',
      display: 'Owner A',
    };

    expect(
      authority.issue(
        {
          ...facts(),
          principal: changingPrincipal,
        } as unknown as NativeOutputGrantFacts,
        lease,
      ),
    ).toBeNull();
    expect(
      authority.issue(
        {
          ...facts(),
          principal: throwingPrincipal,
        } as unknown as NativeOutputGrantFacts,
        lease,
      ),
    ).toBeNull();
    expect(reads).toBe(0);
  });

  test('rejects proxy and accessor identity input before either can retire a turn', () => {
    const authority = createNativeOutputGrantAuthority();
    let proxyTraps = 0;
    let factReads = 0;
    const principal = new Proxy(facts().principal, {
      ownKeys(target) {
        proxyTraps += 1;
        authority.retireTerminal('session-a', 'turn-a');
        return Reflect.ownKeys(target);
      },
    });
    const accessorFacts = {
      ...facts(),
      get threadId() {
        factReads += 1;
        authority.retireTerminal('session-a', 'turn-a');
        return 'session-a';
      },
    };

    expect(
      authority.issue(
        { ...facts(), principal } as unknown as NativeOutputGrantFacts,
        lease,
      ),
    ).toBeNull();
    expect(
      authority.issue(accessorFacts as NativeOutputGrantFacts, lease),
    ).toBeNull();
    expect(proxyTraps).toBe(0);
    expect(factReads).toBe(0);
  });

  test('rejects revoked proxy identity input without exposing its traps', () => {
    const authority = createNativeOutputGrantAuthority();
    const revokedPrincipal = Proxy.revocable(facts().principal, {});
    const revokedFacts = Proxy.revocable(facts(), {});
    revokedPrincipal.revoke();
    revokedFacts.revoke();

    expect(
      authority.issue(
        {
          ...facts(),
          principal: revokedPrincipal.proxy,
        } as unknown as NativeOutputGrantFacts,
        lease,
      ),
    ).toBeNull();
    expect(
      authority.issue(revokedFacts.proxy as NativeOutputGrantFacts, lease),
    ).toBeNull();
  });

  test('snapshots every grant fact before owner code can mutate its input', () => {
    const authority = createNativeOutputGrantAuthority();
    const input = facts();
    const expectedPrincipal = { ...input.principal };
    const configurationLease = input.configurationLease;
    const ownerLease = {
      isCurrent: () => {
        input.threadId = 'session-mutated';
        input.turnId = 'turn-mutated';
        input.adapterId = 'mutated-adapter';
        input.principal = { ...humanPrincipal('test', 'owner-b', 'Owner B') };
        input.configurationLease = {
          revision: 4,
        } as unknown as typeof input.configurationLease;
        return true;
      },
    };
    const grant = authority.issue(input, ownerLease)!;
    const call = authority.bindNativeCall(grant, 'framework-call-a')!;

    expect(authority.admit(call)).toMatchObject({
      threadId: 'session-a',
      turnId: 'turn-a',
      adapterId: 'station',
      principal: expectedPrincipal,
      configurationLease,
    });
  });

  test('rejects a reentrant duplicate issue after the owner callback', () => {
    const authority = createNativeOutputGrantAuthority();
    const stableLease = { isCurrent: () => true };
    const reentrantLease = {
      isCurrent: () => {
        authority.issue(facts(), stableLease);
        return true;
      },
    };

    expect(authority.issue(facts(), reentrantLease)).not.toBeNull();
    expect(authority.issue(facts(), stableLease)).toBeNull();
    authority.retireTerminal('session-a', 'turn-a');
    expect(authority.issue(facts(), stableLease)).not.toBeNull();
  });

  test('terminal retirement during a lease property or callback fences issuance', () => {
    const authority = createNativeOutputGrantAuthority();
    const callbackLease = {
      isCurrent: () => {
        authority.retireTerminal('session-a', 'turn-a');
        return true;
      },
    };
    const getterLease = Object.defineProperty({}, 'isCurrent', {
      get() {
        authority.retireTerminal('session-b', 'turn-b');
        return () => true;
      },
    });

    expect(authority.issue(facts(), callbackLease)).toBeNull();
    expect(
      authority.issue(
        { ...facts(), threadId: 'session-b', turnId: 'turn-b' },
        getterLease as NativeOutputTurnLease,
      ),
    ).toBeNull();
  });

  test('rejects an active exact turn and releases it on revocation', () => {
    const authority = createNativeOutputGrantAuthority();
    const grant = authority.issue(facts(), lease)!;
    const scope = authority.bindNativeCall(grant, 'framework-call-a')!;

    expect(authority.issue(facts(), lease)).toBeNull();
    authority.revoke(grant);
    expect(authority.admit(scope)).toBeNull();
    expect(authority.issue(facts(), lease)).not.toBeNull();
  });

  test('fences reentrant revoke and terminal retirement before bind or admission return', () => {
    const authority = createNativeOutputGrantAuthority();
    let grant: ReturnType<typeof authority.issue>;
    let checks = 0;
    const ownerLease = {
      isCurrent: () => {
        checks += 1;
        if (checks === 2) authority.revoke(grant!);
        if (checks === 5) authority.retireTerminal('session-b', 'turn-b');
        return true;
      },
    };

    grant = authority.issue(facts(), ownerLease);
    expect(authority.bindNativeCall(grant!, 'blocked-by-revoke')).toBeNull();

    const second = authority.issue(
      { ...facts(), threadId: 'session-b', turnId: 'turn-b' },
      ownerLease,
    )!;
    const scope = authority.bindNativeCall(second, 'bound-before-retire')!;
    expect(authority.admit(scope)).toBeNull();
  });

  test('fences a reentrant dispose and invalidates old scopes immediately', () => {
    const authority = createNativeOutputGrantAuthority();
    const grant = authority.issue(facts(), lease)!;
    const scope = authority.bindNativeCall(grant, 'framework-call-a')!;

    authority.dispose();

    expect(authority.admit(scope)).toBeNull();
    expect(authority.bindNativeCall(grant, 'later-call')).toBeNull();
    expect(authority.issue({ ...facts(), turnId: 'turn-b' }, lease)).toBeNull();
  });

  test('keeps active-grant and per-grant-call capacity hard without eviction', () => {
    const authority = createNativeOutputGrantAuthority();
    const grants = Array.from(
      { length: 256 },
      (_, index) =>
        authority.issue(
          { ...facts(), threadId: `session-${index}`, turnId: `turn-${index}` },
          lease,
        )!,
    );
    const firstScope = authority.bindNativeCall(grants[0]!, 'call-0')!;

    expect(
      authority.issue(
        { ...facts(), threadId: 'overflow', turnId: 'overflow' },
        lease,
      ),
    ).toBeNull();
    expect(authority.admit(firstScope)).not.toBeNull();
    authority.revoke(grants[255]!);
    expect(
      authority.issue(
        { ...facts(), threadId: 'replacement', turnId: 'replacement' },
        lease,
      ),
    ).not.toBeNull();

    const callsAuthority = createNativeOutputGrantAuthority();
    const callsGrant = callsAuthority.issue(facts(), lease)!;
    const scopes = Array.from(
      { length: 256 },
      (_, index) => callsAuthority.bindNativeCall(callsGrant, `call-${index}`)!,
    );
    expect(
      callsAuthority.bindNativeCall(callsGrant, 'overflow-call'),
    ).toBeNull();
    expect(callsAuthority.admit(scopes[0]!)).not.toBeNull();
  });
});
