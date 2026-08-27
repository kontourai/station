import { describe, expect, test } from 'vitest';
import {
  isContentBearingMonitoringEvent,
  monitoringSessionIdentity,
} from '../monitoring-session-identity.js';

describe('monitoringSessionIdentity', () => {
  test.each([
    ['gen_ai.conversation.id', 'canonical-conversation'],
    ['station.agent_telemetry.session_id', 'canonical-agent-session'],
    ['sessionId', 'legacy-session'],
    ['conversationId', 'legacy-conversation'],
    ['threadId', 'legacy-thread'],
    ['station.session.id', 'legacy-station-session'],
    ['gen_ai.session.id', 'legacy-gen-ai-session'],
    ['station.agent_telemetry.sessionId', 'legacy-agent-session'],
    ['session_id', 'legacy-snake-session'],
  ])('recognizes %s', (key, id) => {
    expect(monitoringSessionIdentity({ [key]: id })).toBe(id);
  });

  test('uses the schema canonical identity before legacy spellings', () => {
    expect(
      monitoringSessionIdentity({
        sessionId: 'legacy',
        'gen_ai.conversation.id': 'canonical',
      }),
    ).toBe('canonical');
  });

  test('does not manufacture identity from empty or non-string values', () => {
    expect(monitoringSessionIdentity({ sessionId: '' })).toBeUndefined();
    expect(monitoringSessionIdentity({ sessionId: 1 })).toBeUndefined();
    expect(monitoringSessionIdentity(null)).toBeUndefined();
  });
});

describe('isContentBearingMonitoringEvent', () => {
  test('keeps generic host health distinguishable from unbound content', () => {
    expect(
      isContentBearingMonitoringEvent({
        'station.health.healthy': true,
        'station.system.type': 'heartbeat',
      }),
    ).toBe(false);
    expect(
      isContentBearingMonitoringEvent({
        'station.reasoning.text': 'private trace',
      }),
    ).toBe(true);
  });
});
