import { describe, expect, it } from 'vitest';
import {
  type DelegationGrant,
  delegationGrantSettingsSchema,
  selectDelegationGrant,
} from '../delegation-grants.js';

const target = {
  agent: 'codex',
  model: 'coding-model',
  project: 'project',
  parentConversationId: 'conversation',
  parentSessionActive: true,
};

function grant(input: Record<string, unknown>): DelegationGrant {
  return {
    ...delegationGrantSettingsSchema.parse({
      access: 'full-access',
      agents: [target.agent],
      models: [target.model],
      projects: [target.project],
      ...input,
    }),
    id: 'grant',
    createdBy: 'operator',
    createdAt: 0,
  };
}

describe('delegation grant selection', () => {
  it('uses the narrowest applicable scope regardless of access level', () => {
    const station = grant({ scope: { kind: 'station' } });
    const project = grant({ access: 'confined' });
    const conversation = grant({
      scope: {
        kind: 'conversation',
        conversationId: target.parentConversationId,
      },
    });
    expect(selectDelegationGrant([station, project], target, 0)).toBe(project);
    expect(
      selectDelegationGrant([station, conversation, project], target, 0),
    ).toBe(conversation);
  });

  it.each([
    { agents: ['different-agent'] },
    { models: ['different-model'] },
    { projects: ['different-project'] },
    { agents: undefined },
    { scope: { kind: 'conversation', conversationId: 'different-parent' } },
    { expiry: { kind: 'duration', seconds: 1 } },
  ])('rejects a grant outside its target or expiry: %j', (input) => {
    expect(
      selectDelegationGrant([grant(input)], target, 1_000),
    ).toBeUndefined();
  });

  it('expires a parent-session grant when the parent ends', () => {
    expect(
      selectDelegationGrant(
        [grant({})],
        { ...target, parentSessionActive: false },
        0,
      ),
    ).toBeUndefined();
  });
});
