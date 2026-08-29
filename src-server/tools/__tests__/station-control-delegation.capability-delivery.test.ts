/**
 * Slice A unit coverage: the delegate seam's delivery-disclosure derivation
 * (`delegatedCapabilityDelivery`) folds the server-owned capability receipts
 * out of a session's raw event log. The requirements pinned here:
 *
 * - an authored setting the engine could not carry produces a DROPPED entry —
 *   the disclosure `station delegate` renders, never a silent drop;
 * - the report fold follows the adapters' own merge order (a later
 *   `session.configured` entry supersedes the resolution-stage
 *   `session.started` entry for the same capability);
 * - a session with no receipts derives nothing (an agent-less session or a
 *   target Station predating the field renders no lines);
 * - first-turn prompt delivery derives `pending` before any turn and
 *   `delivered` once a `turn.started` carries the
 *   `firstTurnInstructionsComposed` marker (independent review MEDIUM-1: a
 *   turn merely having STARTED is not proof composition happened — a
 *   receipt can be present while dispatch skipped composing it, and that
 *   must never read 'delivered').
 */
import {
  FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY,
  SESSION_CAPABILITY_DELIVERY_METADATA_KEY,
} from '@kontourai/station-contracts/provider';
import { describe, expect, test } from 'vitest';
import { delegatedCapabilityDelivery } from '../station-control-delegation.js';

type RawEvent = Record<string, unknown>;

function sessionStarted(report: unknown): RawEvent {
  return {
    method: 'session.started',
    metadata: { [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: report },
  };
}

function sessionConfigured(report: unknown): RawEvent {
  return {
    method: 'session.configured',
    metadata: { [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: report },
  };
}

describe('delegatedCapabilityDelivery', () => {
  test('derives nothing from a receipt-less event log', () => {
    expect(
      delegatedCapabilityDelivery([
        { method: 'session.started', metadata: {} },
        { method: 'turn.started' },
      ]),
    ).toBeUndefined();
  });

  test('a dropped systemPrompt (engine-unsupported) is disclosed, not silent', () => {
    const view = delegatedCapabilityDelivery([
      sessionStarted({
        agentSlug: 'opencode-agent',
        systemPrompt: {
          source: 'agent',
          requested: ['agent-prompt'],
          undelivered: [
            {
              capability: 'systemPrompt',
              id: 'agent-prompt',
              reason: 'engine-unsupported',
            },
          ],
        },
      }),
    ]);
    expect(view).toEqual({
      prompt: {
        channel: 'system-prompt',
        status: 'not-delivered',
        reason: 'engine-unsupported',
      },
      dropped: [
        {
          capability: 'systemPrompt',
          id: 'agent-prompt',
          reason: 'engine-unsupported',
        },
      ],
    });
  });

  test('a delivered systemPrompt on the ordinary channel is reported delivered', () => {
    const view = delegatedCapabilityDelivery([
      sessionStarted({
        systemPrompt: {
          source: 'agent',
          requested: ['agent-prompt'],
          undelivered: [],
        },
      }),
    ]);
    expect(view?.prompt).toEqual({
      channel: 'system-prompt',
      status: 'delivered',
    });
    expect(view?.dropped).toEqual([]);
  });

  test('dropped tool servers and skills are listed with their ids', () => {
    const view = delegatedCapabilityDelivery([
      sessionStarted({
        toolServers: {
          source: 'agent',
          requested: ['github', 'missing'],
          undelivered: [
            { capability: 'toolServers', id: 'missing', reason: 'not-found' },
          ],
        },
        skills: {
          source: 'agent',
          requested: ['writing'],
          undelivered: [
            {
              capability: 'skills',
              id: 'writing',
              reason: 'secret-boundary-env',
            },
          ],
        },
      }),
    ]);
    expect(view?.dropped).toEqual([
      { capability: 'toolServers', id: 'missing', reason: 'not-found' },
      {
        capability: 'skills',
        id: 'writing',
        reason: 'secret-boundary-env',
      },
    ]);
    expect(view?.prompt).toBeUndefined();
  });

  test('a later session.configured entry supersedes the resolution-stage entry', () => {
    const view = delegatedCapabilityDelivery([
      sessionStarted({
        toolServers: {
          source: 'agent',
          requested: ['github'],
          undelivered: [
            { capability: 'toolServers', id: 'github', reason: 'not-found' },
          ],
        },
      }),
      sessionConfigured({
        toolServers: {
          source: 'agent',
          requested: ['github'],
          delivered: ['github'],
          undelivered: [],
        },
      }),
    ]);
    expect(view).toBeUndefined();
  });

  test('first-turn prompt delivery is pending before any turn and delivered once a turn.started carries the composed marker', () => {
    const report = {
      systemPrompt: {
        source: 'agent',
        requested: ['agent-prompt'],
        undelivered: [],
        channel: 'first-turn' as const,
        firstTurnInstructions: 'Be terse.',
      },
    };
    expect(
      delegatedCapabilityDelivery([sessionStarted(report)])?.prompt,
    ).toEqual({ channel: 'first-turn', status: 'pending' });
    expect(
      delegatedCapabilityDelivery([
        sessionStarted(report),
        {
          method: 'turn.started',
          metadata: {
            [FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY]: true,
          },
        },
      ])?.prompt,
    ).toEqual({ channel: 'first-turn', status: 'delivered' });
  });

  test('independent review MEDIUM-1 divergence: a turn.started WITHOUT the composed marker must NOT read delivered, even though the receipt is present and a turn genuinely started', () => {
    const report = {
      systemPrompt: {
        source: 'agent',
        requested: ['agent-prompt'],
        undelivered: [],
        channel: 'first-turn' as const,
        firstTurnInstructions: 'Be terse.',
      },
    };
    // A turn.started with no metadata at all (composition skipped, or a
    // pre-marker target Station).
    expect(
      delegatedCapabilityDelivery([
        sessionStarted(report),
        { method: 'turn.started' },
      ])?.prompt,
    ).toEqual({ channel: 'first-turn', status: 'pending' });
    // A turn.started whose metadata is present but the marker is explicitly
    // false/absent — the "label, not a derivation" defect class this test
    // exists to catch: reading ANY metadata presence, or the marker key's
    // mere presence rather than its true value, as 'delivered' would pass
    // this the same way "any turn.started exists" used to.
    expect(
      delegatedCapabilityDelivery([
        sessionStarted(report),
        {
          method: 'turn.started',
          metadata: {
            [FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY]: false,
            unrelatedField: 'present',
          },
        },
      ])?.prompt,
    ).toEqual({ channel: 'first-turn', status: 'pending' });
  });
});
