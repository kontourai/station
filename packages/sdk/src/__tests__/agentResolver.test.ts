import { agentId } from '@kontourai/station-contracts/agent-identity';
import { describe, expect, test } from 'vitest';
import { getAgentDisplayName } from '../agentResolver';

describe('agentResolver clean identities', () => {
  test('resolves only an exact opaque AgentId', () => {
    const agents = [
      { slug: agentId('codex'), name: 'Codex' },
      { slug: agentId('team-codex'), name: 'Distinct lookalike' },
    ];

    expect(getAgentDisplayName(agentId('codex'), agents)).toBe('Codex');
    expect(getAgentDisplayName(agentId('team-codex'), agents)).toBe(
      'Distinct lookalike',
    );
    expect(getAgentDisplayName(agentId('missing-codex'), agents)).toBe(
      'missing-codex',
    );
  });
});
