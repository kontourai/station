import { describe, expect, it } from 'vitest';
import { createPolicySet, type PolicyRequest } from '../cedar-evaluator.js';

const schema =
  'entity User; entity File { level: Long }; action "read" appliesTo { principal: User, resource: File, context: { ticket: String } };';
const request = (): PolicyRequest => ({
  principal: { type: 'User', id: 'alice' },
  action: { type: 'Action', id: 'read' },
  resource: { type: 'File', id: 'report' },
  context: { ticket: 'private-ticket' },
  entities: [
    { uid: { type: 'User', id: 'alice' }, attrs: {}, parents: [] },
    { uid: { type: 'File', id: 'report' }, attrs: { level: 1 }, parents: [] },
  ],
});
const permit = 'permit(principal, action == Action::"read", resource);';
async function prepare(policies: Record<string, string>) {
  const result = await createPolicySet({ schema, policies });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.policySet;
}

describe('Cedar policy foundation (real WASM)', () => {
  it.each([
    ['permit', { permit }, 'allow', []],
    [
      'no matching permit',
      { permit: 'permit(principal == User::"bob", action, resource);' },
      'deny',
      [],
    ],
    [
      'forbid wins',
      { permit, forbid: 'forbid(principal, action, resource);' },
      'deny',
      [],
    ],
    [
      'errored policy alongside permit',
      {
        permit,
        overflow:
          'permit(principal, action, resource) when { resource.level + 9223372036854775807 > 0 };',
      },
      'deny',
      [{ category: 'evaluation', policyId: 'overflow' }],
    ],
  ] as const)('%s', async (_name, policies, decision, errors) => {
    const set = await prepare(policies);
    const result = set.evaluate(request());
    expect(result.decision).toBe(decision);
    expect(result.errors).toEqual(errors);
    expect(result.determiningPolicyIds).toEqual(
      decision === 'allow' || errors.length
        ? ['permit']
        : _name === 'forbid wins'
          ? ['forbid']
          : [],
    );
    expect(JSON.stringify(result)).not.toContain('private-ticket');
  });

  it.each([
    { schema: 'not a schema', policies: { permit } },
    { schema, policies: { permit: 'not a policy' } },
    {
      schema,
      policies: {
        permit:
          'permit(principal, action, resource) when { resource.missing };',
      },
    },
  ])('refuses invalid schema or policy before use', async (input) => {
    expect(await createPolicySet(input)).toEqual({
      ok: false,
      decision: 'deny',
      errors: [{ category: 'policy' }],
    });
  });

  it('rejects missing, malformed, oversized and executable facts', async () => {
    const set = await prepare({ permit });
    const missing = request();
    missing.entities = [];
    const absentAttribute = request();
    absentAttribute.entities[1].attrs = {};
    const malformed = request();
    malformed.entities[1].attrs.level = 'one';
    const context = request();
    context.context = {};
    const oversized = request();
    oversized.context.ticket = 'x'.repeat(262145);
    const getter = request();
    let getterInvocations = 0;
    Object.defineProperty(getter.context, 'ticket', {
      enumerable: true,
      get() {
        getterInvocations++;
        return 'private-ticket';
      },
    });
    const cyclic = request();
    cyclic.context.self = cyclic.context;
    for (const facts of [
      missing,
      absentAttribute,
      malformed,
      context,
      getter,
      cyclic,
    ]) {
      expect(set.evaluate(facts)).toMatchObject({
        decision: 'deny',
        errors: [{ category: 'input' }],
      });
    }
    expect(getterInvocations).toBe(0);
    expect(set.evaluate(oversized)).toMatchObject({
      decision: 'deny',
      errors: [{ category: 'limit' }],
    });
  });

  it('binds immutable policy/schema revisions and determining IDs to accepted content', async () => {
    const input = { schema, policies: { permit } };
    const first = await createPolicySet(input);
    if (!first.ok) throw new Error('fixture rejected');
    input.policies.permit = 'forbid(principal, action, resource);';
    const second = await prepare(input.policies);
    const facts = {
      ...request(),
      policyRevision: 'forged',
      determiningPolicyIds: ['forged'],
    };
    expect(first.policySet.evaluate(facts)).toMatchObject({
      decision: 'allow',
      policyRevision: first.policySet.policyRevision,
      determiningPolicyIds: ['permit'],
    });
    expect(second.evaluate(facts).decision).toBe('deny');
    expect(second.policyRevision).not.toBe(first.policySet.policyRevision);
    expect(second.schemaRevision).toBe(first.policySet.schemaRevision);
    expect((await prepare({ permit })).policyRevision).toBe(
      first.policySet.policyRevision,
    );
  });
});

it('bounds policy input, entity count and nesting before evaluation', async () => {
  const set = await prepare({ permit });
  const many = request();
  many.entities = Array.from({ length: 1025 }, () => many.entities[0]);
  expect(set.evaluate(many)).toMatchObject({
    decision: 'deny',
    errors: [{ category: 'limit' }],
  });
  const deep = request();
  let nested: Record<string, unknown> = {};
  for (let i = 0; i < 34; i++) nested = { nested };
  Object.assign(deep.context, nested);
  expect(set.evaluate(deep)).toMatchObject({
    decision: 'deny',
    errors: [{ category: 'limit' }],
  });
  expect(
    await createPolicySet({
      schema,
      policies: Object.fromEntries(
        Array.from({ length: 129 }, (_, i) => [`p${i}`, permit]),
      ),
    }),
  ).toMatchObject({
    ok: false,
    decision: 'deny',
    errors: [{ category: 'limit' }],
  });
});
