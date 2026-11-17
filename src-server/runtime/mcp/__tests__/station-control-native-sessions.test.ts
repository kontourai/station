/**
 * #2377 slice D (delta review): a native station-control session's credential
 * ends with it. Replacing a session's registration revokes the credential the
 * old one held, not only its client; a voice session whose provider fails to
 * start closes the request run it opened.
 */
import { EventEmitter } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { VoiceSessionService } from '../../../voice/voice-session.js';
import {
  __resetStationControlMcpTokensForTests,
  mintStationControlMcpToken,
  verifyStationControlMcpToken,
} from '../station-control-mcp-token.js';
import {
  __resetNativeStationControlForTests,
  startNativeStationControlSession,
} from '../station-control-native-tools.js';
import { __countStationControlRequestRunsForTests } from '../station-control-request-runs.js';

afterEach(async () => {
  await __resetNativeStationControlForTests();
  __resetStationControlMcpTokensForTests();
});

test('replacing a session revokes the credential the replaced one held', () => {
  startNativeStationControlSession('session-a');
  const { token } = mintStationControlMcpToken('session-a', 'sdk-in-process');
  // The control: a fresh registration of another session revokes nothing.
  startNativeStationControlSession('session-b');
  expect(verifyStationControlMcpToken(token)).toMatchObject({
    sessionId: 'session-a',
  });
  startNativeStationControlSession('session-a');
  expect(verifyStationControlMcpToken(token)).toBeUndefined();
});

test('a voice session whose provider fails to start closes its request run', () => {
  const service = new VoiceSessionService({
    providerFactory: () => {
      throw new Error('provider unavailable');
    },
    agentTools: new Map(),
    agentSpecs: new Map(),
    agentHooks: new Map(),
  });
  const ws = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    send: () => {},
    close: () => {},
  });
  expect(__countStationControlRequestRunsForTests()).toBe(0);
  expect(() =>
    service.createSession(ws as never, { principalId: 'human:local:operator' }),
  ).toThrow('provider unavailable');
  expect(__countStationControlRequestRunsForTests()).toBe(0);
});
