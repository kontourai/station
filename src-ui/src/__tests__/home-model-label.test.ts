import { describe, expect, test } from 'vitest';
import {
  guaranteeConcreteModel,
  resolveEffectiveModel,
} from '../utils/execution';
import { modelDisplayLabel, prettifyModelId } from '../utils/modelCapabilities';
import { buildHomeWorkItems } from '../views/home/home-view-model';

/**
 * station#3391. Home showed one session two model names: the "Start direct
 * chat" card resolved the id against the connection catalog and read
 * "Selected Test Model", while "Continue most recent work" printed the stored
 * `model-selected` beside it. Two derivations of one user-visible fact, and
 * one of them handing a user an internal id.
 *
 * These pin the join, not either half on its own: the same id and the same
 * catalog go into both product paths, and the strings that come out are
 * compared to each other.
 */
const CATALOG = [
  {
    id: 'model-selected',
    name: 'Selected Test Model',
    originalId: 'model-selected',
  },
  {
    id: 'model-default',
    name: 'Default Test Model',
    originalId: 'model-default',
  },
];

const CONNECTION = {
  id: 'claude',
  kind: 'agent' as const,
  type: 'claude-runtime',
  name: 'Claude',
  enabled: true,
  capabilities: [],
  status: 'ready',
  prerequisites: [],
  config: { executionClass: 'external', defaultModel: 'model-selected' },
  setup: { state: 'ready' as const, detected: true, configured: true },
  runtimeCatalog: {
    source: 'live' as const,
    models: CATALOG,
    builtInModels: [],
  },
};

function session(model: string) {
  return {
    threadId: 'thread-1',
    provider: 'claude',
    status: 'ready',
    lifecycleState: 'idle',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
    model,
  };
}

/** What the "Start direct chat" card renders after the ` · ` separator. */
function startCardLabel(model: string) {
  return guaranteeConcreteModel(
    resolveEffectiveModel({
      agent: { slug: 'claude', name: 'Claude', model } as never,
      runtimeConnection: CONNECTION as never,
    }),
  ).label;
}

/** What the "Continue most recent work" card renders in the same position. */
function continueCardLabel(model: string, catalog = CATALOG) {
  const [item] = buildHomeWorkItems({
    chats: {},
    sessions: [session(model)] as never,
    agents: [{ slug: 'claude', name: 'Claude' }] as never,
    resolveModelLabel: (id) => modelDisplayLabel(id, catalog),
  });
  return item.modelLabel;
}

describe('Home names a model the same way its sibling card does (station#3391)', () => {
  test('both cards render the catalog name for the same session', () => {
    expect(continueCardLabel('model-selected')).toBe('Selected Test Model');
    expect(continueCardLabel('model-selected')).toBe(
      startCardLabel('model-selected'),
    );
  });

  test('an id the catalog does not know is readable, not the bare id', () => {
    const label = continueCardLabel('claude-opus-5[1m]', []);
    // Honest in both directions: it never claims a name the catalog did not
    // give, and it never hands the user the internal id it was derived from.
    expect(label).toBe('Opus 5 (1M)');
    expect(label).not.toBe('claude-opus-5[1m]');
    // And the sibling card agrees about that case too — the point of the
    // shared derivation is that neither path has its own fallback.
    expect(label).toBe(startCardLabel('claude-opus-5[1m]'));
  });

  test('a session with no model at all says so rather than inventing one', () => {
    expect(continueCardLabel('')).toBe('Model not reported');
  });

  /**
   * station#3391 review B-2/B-3. The prettifier is a display transformation,
   * and a transformation that produces a blank string or a fabricated product
   * name is worse than the id it started from.
   */
  test('an id the prettifier cannot improve is returned, not mangled or blanked', () => {
    // Provider-qualified: splitting on '-' would read
    // "Us.anthropic.claude Sonnet 4 5 20250929 V1:0".
    const bedrock = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    expect(continueCardLabel(bedrock, [])).toBe(bedrock);
    expect(continueCardLabel('openai/gpt-5', [])).toBe('openai/gpt-5');
    // 'claude-' prettifies to the empty string: prefix stripped, nothing left.
    // Asserted on the PRETTIFIER ITSELF as well as through the card, because
    // `modelDisplayLabel` carries its own `|| id` guard — going through the
    // card alone passes with the prettifier's guard removed, so it proves the
    // pair rather than either one (found by fault injection).
    expect(prettifyModelId('claude-')).toBe('claude-');
    expect(continueCardLabel('claude-', [])).toBe('claude-');
    // And a catalog entry still wins over both.
    expect(
      continueCardLabel(bedrock, [
        { id: bedrock, name: 'Sonnet 4.5', originalId: bedrock },
      ]),
    ).toBe('Sonnet 4.5');
  });

  test('the continue card carries the id as well as its label', () => {
    const [item] = buildHomeWorkItems({
      chats: {
        local: {
          conversationId: 'thread-9',
          agentSlug: 'claude',
          model: 'model-selected',
          messages: [{ timestamp: 10 }],
        },
      } as never,
      sessions: [] as never,
      agents: [{ slug: 'claude', name: 'Claude' }] as never,
      resolveModelLabel: (id) => modelDisplayLabel(id, CATALOG),
    });
    // The label is a derivation OF this, so a consumer that needs the model
    // never has to parse a display string back into an id.
    expect(item.model).toBe('model-selected');
    expect(item.modelLabel).toBe('Selected Test Model');
  });
});
