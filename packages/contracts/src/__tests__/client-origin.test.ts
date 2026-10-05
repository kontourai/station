import { describe, expect, it } from 'vitest';
import {
  CLIENT_ORIGIN_VERSION,
  clientOriginSender,
  isClientOrigin,
  parseClientReportedOrigin,
  serializeClientReportedOrigin,
  UNKNOWN_CLIENT_REPORTED_ORIGIN,
} from '../client-origin.js';

describe('client origin contract', () => {
  it('round-trips the bounded reported detail', () => {
    const encoded = serializeClientReportedOrigin({
      version: CLIENT_ORIGIN_VERSION,
      surface: 'mobile',
      build: '0.1.2+abc123',
    });
    expect(parseClientReportedOrigin(encoded)).toEqual({
      version: CLIENT_ORIGIN_VERSION,
      surface: 'mobile',
      build: '0.1.2+abc123',
    });
  });

  it('degrades missing, spoof-shaped, and future values to unknown', () => {
    expect(parseClientReportedOrigin(undefined)).toEqual(
      UNKNOWN_CLIENT_REPORTED_ORIGIN,
    );
    expect(parseClientReportedOrigin('1;web;Mozilla/5.0')).toEqual(
      UNKNOWN_CLIENT_REPORTED_ORIGIN,
    );
    expect(parseClientReportedOrigin('2;desktop;1.0.0')).toEqual(
      UNKNOWN_CLIENT_REPORTED_ORIGIN,
    );
  });

  describe('sender (#3419)', () => {
    const origin = {
      version: CLIENT_ORIGIN_VERSION,
      actor: { kind: 'internal' as const },
      reported: UNKNOWN_CLIENT_REPORTED_ORIGIN,
    };

    it('reads the sender a server stamped, bounded and on one line', () => {
      expect(
        clientOriginSender({
          sender: {
            kind: 'agent-session',
            sessionId: 'session-1',
            title: `  Fix\n\u202elogin ${'x'.repeat(200)}`,
            agent: 'Reviewer',
            engine: 'claude',
            requestKey: 'request-key-1',
          },
        }),
      ).toEqual({
        kind: 'agent-session',
        sessionId: 'session-1',
        title: expect.stringMatching(/^Fix login x+…$/u),
        agent: 'Reviewer',
        engine: 'claude',
        requestKey: 'request-key-1',
      });
      const title = clientOriginSender({
        sender: {
          kind: 'agent-session',
          sessionId: 's',
          title: 'a'.repeat(500),
        },
      })?.title;
      expect(Array.from(title ?? '')).toHaveLength(120);
    });

    it('drops a sender it does not know, leaving the actor to say it was not a person', () => {
      for (const sender of [
        undefined,
        'agent',
        {},
        { kind: 'delegation-result', sessionId: 's' },
        { kind: 'agent-session' },
        { kind: 'agent-session', sessionId: '' },
        { kind: 'agent-session', sessionId: 'x'.repeat(513) },
      ])
        expect(clientOriginSender({ sender })).toBeUndefined();
      expect(clientOriginSender(undefined)).toBeUndefined();
    });

    it('does not change what makes an origin valid: a record with or without a sender stays readable', () => {
      expect(isClientOrigin(origin)).toBe(true);
      expect(
        isClientOrigin({
          ...origin,
          sender: { kind: 'agent-session', sessionId: 's' },
        }),
      ).toBe(true);
      // A newer writer's sender kind must not make the receipt unreadable.
      expect(
        isClientOrigin({
          ...origin,
          sender: { kind: 'coordinator', sessionId: 's' },
        }),
      ).toBe(true);
    });
  });
});
