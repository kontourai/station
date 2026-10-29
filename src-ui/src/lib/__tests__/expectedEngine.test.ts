import type { AgentCatalogProjection } from '@kontourai/station-sdk/agent';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { type ObservedAgentCatalog, observedEngine } from '../expectedEngine';

describe('observedEngine', () => {
  const catalog = (
    agents: NonNullable<ObservedAgentCatalog['agents']>,
    catalogState?: string,
  ): ObservedAgentCatalog => ({
    agents,
    ...(catalogState ? { catalogState } : {}),
  });

  // The hand-declared shape must stay satisfiable by what the query really
  // holds under ['agents'], or the feature goes silently inert (every path
  // that cannot read the catalog states nothing).
  it('accepts the shape the agent catalog query holds', () => {
    expectTypeOf<AgentCatalogProjection>().toMatchTypeOf<ObservedAgentCatalog>();
  });

  it('an unbound Agent is Station, a bound one is its connection', () => {
    const c = catalog([
      { slug: 'station' },
      { slug: 'reviewer', execution: { agentConnectionId: 'codex' } },
    ]);
    expect(observedEngine(c, 'station')).toEqual({ kind: 'station' });
    expect(observedEngine(c, 'reviewer')).toEqual({
      kind: 'connection',
      connectionId: 'codex',
    });
  });

  it.each([
    ['no catalog', undefined],
    ['no agents', {}],
    ['a reconciling catalog', catalog([{ slug: 'station' }], 'reconciling')],
    ['an Agent that is not there', catalog([{ slug: 'other' }])],
  ])('states nothing for %s', (_label, c) => {
    expect(
      observedEngine(c as ObservedAgentCatalog, 'station'),
    ).toBeUndefined();
  });

  // A member's view carries no `execution`; reading it as unbound would say
  // Station's own engine for an engine-bound Agent and refuse the send.
  it('states nothing for a member view of an Agent', () => {
    expect(
      observedEngine(
        catalog([{ slug: 'station', kind: 'member-agent' }]),
        'station',
      ),
    ).toBeUndefined();
  });

  // An expectation must never be what fails a send: an id the identity
  // grammar rejects is omitted, not thrown.
  it('omits, rather than throws on, a connection id the grammar rejects', () => {
    const c = catalog([
      { slug: 'station', execution: { agentConnectionId: 'Not A Clean Id!' } },
    ]);
    expect(() => observedEngine(c, 'station')).not.toThrow();
    expect(observedEngine(c, 'station')).toBeUndefined();
  });
});
