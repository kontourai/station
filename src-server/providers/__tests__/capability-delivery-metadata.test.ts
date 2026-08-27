import { SESSION_CAPABILITY_DELIVERY_METADATA_KEY } from '@kontourai/station-contracts/provider';
import { describe, expect, test } from 'vitest';
import { mergeCapabilityDeliveryMetadata } from '../adapters/capability-delivery-metadata.js';

describe('mergeCapabilityDeliveryMetadata', () => {
  test('with no existing metadata, attaches a fresh report under the reserved key', () => {
    const result = mergeCapabilityDeliveryMetadata(undefined, 'toolServers', {
      source: 'connection-default',
      requested: ['filesystem'],
      delivered: ['filesystem'],
      undelivered: [],
    });

    expect(result).toEqual({
      [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: {
        toolServers: {
          source: 'connection-default',
          requested: ['filesystem'],
          delivered: ['filesystem'],
          undelivered: [],
        },
      },
    });
  });

  test('preserves unrelated existing metadata keys alongside the merged report', () => {
    const result = mergeCapabilityDeliveryMetadata(
      { connectionId: 'kiro', effectiveModel: 'claude-sonnet' },
      'toolServers',
      {
        source: 'connection-default',
        requested: [],
        delivered: [],
        undelivered: [],
      },
    );

    expect(result.connectionId).toBe('kiro');
    expect(result.effectiveModel).toBe('claude-sonnet');
    expect(result[SESSION_CAPABILITY_DELIVERY_METADATA_KEY]).toBeDefined();
  });

  test('a channel-stage merge for the SAME capability preserves the resolution-stage undelivered entries (append, not clobber)', () => {
    // Simulates input.metadata after session-agent-resolution.ts already
    // wrote a resolution-stage report (agent-authored ids, some already
    // undelivered at resolution time — e.g. not-found/secret-boundary-env).
    const inputMetadata = {
      [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: {
        agentSlug: 'my-agent',
        toolServers: {
          source: 'agent',
          requested: ['alpha', 'beta', 'gamma'],
          undelivered: [
            { capability: 'toolServers', id: 'beta', reason: 'not-found' },
          ],
        },
      },
    };

    const result = mergeCapabilityDeliveryMetadata(
      inputMetadata,
      'toolServers',
      {
        source: 'connection-default',
        requested: ['alpha', 'gamma'],
        delivered: ['alpha'],
        undelivered: [
          {
            capability: 'toolServers',
            id: 'gamma',
            reason: 'binary-not-found',
          },
        ],
      },
    );

    const merged = result[SESSION_CAPABILITY_DELIVERY_METADATA_KEY] as any;
    expect(merged.toolServers).toEqual({
      // The existing resolution-stage source/requested win over the
      // channel-stage caller's own (possibly narrower) values.
      source: 'agent',
      requested: ['alpha', 'beta', 'gamma'],
      delivered: ['alpha'],
      undelivered: [
        // Resolution-stage entry first, channel-stage entry appended —
        // never clobbered.
        { capability: 'toolServers', id: 'beta', reason: 'not-found' },
        {
          capability: 'toolServers',
          id: 'gamma',
          reason: 'binary-not-found',
        },
      ],
    });
    // The sibling agentSlug field on the delivery bag survives the merge.
    expect(merged.agentSlug).toBe('my-agent');
  });

  test('a channel-stage merge for a DIFFERENT capability does not disturb the existing one', () => {
    const inputMetadata = {
      [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: {
        agentSlug: 'my-agent',
        toolServers: {
          source: 'agent',
          requested: ['alpha'],
          delivered: ['alpha'],
          undelivered: [],
        },
      },
    };

    const result = mergeCapabilityDeliveryMetadata(inputMetadata, 'skills', {
      source: 'agent',
      requested: ['writing'],
      delivered: [],
      undelivered: [
        { capability: 'skills', id: 'writing', reason: 'not-found' },
      ],
    });

    const merged = result[SESSION_CAPABILITY_DELIVERY_METADATA_KEY] as any;
    // The untouched toolServers report is byte-identical to what was there
    // before the skills merge ran.
    expect(merged.toolServers).toEqual({
      source: 'agent',
      requested: ['alpha'],
      delivered: ['alpha'],
      undelivered: [],
    });
    expect(merged.skills).toEqual({
      source: 'agent',
      requested: ['writing'],
      delivered: [],
      undelivered: [
        { capability: 'skills', id: 'writing', reason: 'not-found' },
      ],
    });
  });

  test('an absent channelReport.delivered defaults to an empty array', () => {
    const result = mergeCapabilityDeliveryMetadata(undefined, 'skills', {
      source: 'agent',
      requested: ['writing'],
      undelivered: [],
    });

    const merged = result[SESSION_CAPABILITY_DELIVERY_METADATA_KEY] as any;
    expect(merged.skills.delivered).toEqual([]);
  });
});
