import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { describe, expect, test } from 'vitest';
import {
  issueAuthorizedTurnCorrelationHandoff,
  readNativeOutputRelayCompanion,
} from '../conversation/authorized-turn-correlation.js';
import {
  closeNativeOutputTurnContext,
  createNativeOutputGrantAuthority,
  createNativeOutputRelayCompanion,
  currentNativeOutputCallScope,
  runWithCurrentNativeOutputCall,
  runWithNativeOutputTurnContext,
} from '../native-output-turn-grant.js';

const facts = () => ({
  threadId: 'session-a',
  turnId: 'turn-a',
  adapterId: 'station',
  principal: { ...humanPrincipal('test', 'owner-a', 'Owner A') },
  configurationLease: { revision: 3 },
});
const lease = { isCurrent: () => true };

describe('native output turn grants', () => {
  test('accepts one real native call and keeps it commit-eligible after stream issuance closes', () => {
    const authority = createNativeOutputGrantAuthority();
    const grant = authority.issue(facts(), lease)!;
    const call = authority.bindNativeCall(grant, 'real-call')!;
    authority.closeIssuance(grant);
    expect(authority.bindNativeCall(grant, 'later-call')).toBeNull();
    expect(authority.admit(call)).toMatchObject({
      threadId: 'session-a',
      turnId: 'turn-a',
    });
    authority.retireTerminal('session-a', 'turn-a');
    expect(authority.admit(call)).toBeNull();
  });

  test('refuses absent, reused, and cross-grant call identities', () => {
    const authority = createNativeOutputGrantAuthority();
    const first = authority.issue(facts(), lease)!;
    const second = authority.issue({ ...facts(), turnId: 'turn-b' }, lease)!;
    expect(authority.bindNativeCall(first, '')).toBeNull();
    expect(authority.bindNativeCall(first, 'call')).not.toBeNull();
    expect(authority.bindNativeCall(first, 'call')).toBeNull();
    expect(authority.bindNativeCall(second, 'call')).not.toBeNull();
    authority.revoke(first);
    expect(authority.bindNativeCall(first, 'other')).toBeNull();
  });

  test('isolates session companions and revokes an awaiting call when authorization or configuration changes', async () => {
    const authority = createNativeOutputGrantAuthority();
    let firstAuthorized = true;
    let configurationCurrent = true;
    const first = createNativeOutputRelayCompanion({
      authority,
      facts: {
        ...facts(),
        threadId: 'session-one',
        turnId: 'turn-one',
      },
      sourceLease: { isCurrent: () => firstAuthorized },
    })!;
    const second = createNativeOutputRelayCompanion({
      authority,
      facts: {
        ...facts(),
        threadId: 'session-two',
        turnId: 'turn-two',
      },
      sourceLease: { isCurrent: () => true },
    })!;
    const firstContext = first.issueForRuntimeConfiguration(
      { revision: 1 },
      () => configurationCurrent,
    )!;
    const secondContext = second.issueForRuntimeConfiguration(
      { revision: 1 },
      () => true,
    )!;
    const firstScope = runWithNativeOutputTurnContext(firstContext, () =>
      runWithCurrentNativeOutputCall('first-real-id', () =>
        currentNativeOutputCallScope(),
      ),
    );
    const secondScope = authority.bindNativeCall(
      secondContext.grant,
      'second-real-id',
    )!;

    await Promise.resolve();
    firstAuthorized = false;
    expect(authority.admit(firstScope!)).toBeNull();
    expect(authority.admit(secondScope)).toMatchObject({
      threadId: 'session-two',
    });
    firstAuthorized = true;
    configurationCurrent = false;
    expect(authority.admit(firstScope!)).toBeNull();
  });

  test('replayed opaque companion cannot issue twice, while a bound scope drains until terminal retirement', () => {
    const authority = createNativeOutputGrantAuthority();
    const companion = createNativeOutputRelayCompanion({
      authority,
      facts: facts(),
      sourceLease: { isCurrent: () => true },
    })!;
    const handoff = issueAuthorizedTurnCorrelationHandoff(
      {
        accountId: 'owner-a',
        sessionId: 'session-a',
        turnId: 'turn-a',
        correlationId: 'correlation-a',
      },
      companion,
    );
    const replayedCompanion = readNativeOutputRelayCompanion(handoff)!;
    expect(readNativeOutputRelayCompanion(handoff)).toBe(replayedCompanion);
    const context = replayedCompanion.issueForRuntimeConfiguration(
      { revision: 1 },
      () => true,
    )!;
    expect(
      readNativeOutputRelayCompanion(handoff)!.issueForRuntimeConfiguration(
        { revision: 1 },
        () => true,
      ),
    ).toBeNull();
    const scope = authority.bindNativeCall(context.grant, 'replayed-real-id')!;
    closeNativeOutputTurnContext(context);
    expect(authority.bindNativeCall(context.grant, 'late-real-id')).toBeNull();
    expect(authority.admit(scope)).toMatchObject({
      callId: 'replayed-real-id',
    });
    authority.retireTerminal('session-a', 'turn-a');
    expect(authority.admit(scope)).toBeNull();
  });
});
