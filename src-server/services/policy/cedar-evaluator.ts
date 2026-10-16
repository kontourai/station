import { createHash } from 'node:crypto';
import type {
  Context,
  Entities,
  EntityUid,
  Schema,
} from '@cedar-policy/cedar-wasm/nodejs';

type Cedar = typeof import('@cedar-policy/cedar-wasm/nodejs');
type Category = 'initialization' | 'input' | 'limit' | 'policy' | 'evaluation';
export interface PolicyRequest {
  principal: EntityUid;
  action: EntityUid;
  resource: EntityUid;
  context: Context;
  entities: Entities;
}
interface PolicyDecision {
  decision: 'allow' | 'deny';
  policyRevision: string;
  schemaRevision: string;
  determiningPolicyIds: string[];
  errors: { category: Category; policyId?: string }[];
}
interface ValidatedPolicySet {
  readonly policyRevision: string;
  readonly schemaRevision: string;
  evaluate(request: PolicyRequest): PolicyDecision;
}

const LIMITS = {
  bytes: 256 * 1024,
  nodes: 16384,
  depth: 32,
  policies: 128,
  entities: 1024,
  sets: 64,
};
let runtime: Promise<Cedar> | undefined;
const prepared = new Set<string>();
class InputError extends Error {
  constructor(readonly category: 'input' | 'limit') {
    super(category);
  }
}

// Inspect descriptors before serialization: getters, cycles, exotic objects and
// lossy JSON coercions cannot turn malformed caller facts into authority.
function snapshot<T>(input: T): T {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth)
      throw new InputError('limit');
    if (typeof value === 'string') bytes += Buffer.byteLength(value);
    else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new InputError('input');
      bytes += 16;
    } else if (value === null || typeof value === 'boolean') bytes += 5;
    else if (typeof value === 'object') {
      if (ancestors.has(value)) throw new InputError('input');
      const proto = Object.getPrototypeOf(value);
      if (
        proto !== Object.prototype &&
        proto !== null &&
        proto !== Array.prototype
      )
        throw new InputError('input');
      if (
        Array.isArray(value) &&
        (value.length > LIMITS.nodes ||
          Object.keys(value).length !== value.length)
      )
        throw new InputError('input');
      ancestors.add(value);
      for (const key of Reflect.ownKeys(value)) {
        if (Array.isArray(value) && key === 'length') continue;
        if (typeof key !== 'string') throw new InputError('input');
        bytes += Buffer.byteLength(key) + 4;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
          throw new InputError('input');
        visit(descriptor.value, depth + 1);
      }
      ancestors.delete(value);
    } else throw new InputError('input');
    if (bytes > LIMITS.bytes) throw new InputError('limit');
  }
  visit(input, 0);
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json) > LIMITS.bytes) throw new InputError('limit');
  return JSON.parse(json) as T;
}
function revision(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, canonical(x)]),
      );
    return v;
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
function uid(value: EntityUid): string {
  const plain = '__entity' in value ? value.__entity : value;
  return JSON.stringify([plain.type, plain.id]);
}

/** Server-local foundation only; a permit does not supply Station authority or consent. */
export async function createPolicySet(input: {
  schema: Schema;
  policies: Record<string, string>;
}): Promise<
  | { ok: true; policySet: ValidatedPolicySet }
  | { ok: false; decision: 'deny'; errors: PolicyDecision['errors'] }
> {
  let cedar: Cedar;
  try {
    runtime ??= import('@cedar-policy/cedar-wasm/nodejs');
    cedar = await runtime;
  } catch {
    return {
      ok: false,
      decision: 'deny',
      errors: [{ category: 'initialization' }],
    };
  }
  try {
    const { schema, policies } = snapshot(input);
    const ids = Object.keys(policies);
    if (!ids.length || ids.length > LIMITS.policies)
      throw new InputError('limit');
    if (
      ids.some(
        (id) =>
          !/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof policies[id] !== 'string',
      )
    )
      throw new InputError('input');
    const policySet = { staticPolicies: policies };
    const validation = cedar.validate({
      schema,
      policies: policySet,
      validationSettings: { mode: 'strict' },
    });
    if (validation.type !== 'success' || validation.validationErrors.length)
      return { ok: false, decision: 'deny', errors: [{ category: 'policy' }] };
    const schemaRevision = revision(schema);
    const policyRevision = revision({ schema, policies });
    if (!prepared.has(policyRevision)) {
      if (prepared.size >= LIMITS.sets) throw new InputError('limit');
      if (
        cedar.preparseSchema(policyRevision, schema).type !== 'success' ||
        cedar.preparsePolicySet(policyRevision, policySet).type !== 'success'
      )
        return {
          ok: false,
          decision: 'deny',
          errors: [{ category: 'policy' }],
        };
      prepared.add(policyRevision);
    }
    const deny = (category: Category): PolicyDecision => ({
      decision: 'deny',
      policyRevision,
      schemaRevision,
      determiningPolicyIds: [],
      errors: [{ category }],
    });
    return {
      ok: true,
      policySet: Object.freeze({
        policyRevision,
        schemaRevision,
        evaluate(request: PolicyRequest): PolicyDecision {
          try {
            const facts = snapshot(request);
            if (!Array.isArray(facts.entities)) return deny('input');
            if (facts.entities.length > LIMITS.entities) return deny('limit');
            if (
              cedar.checkParseEntities({ entities: facts.entities, schema })
                .type !== 'success' ||
              cedar.checkParseContext({
                context: facts.context,
                schema,
                action: facts.action,
              }).type !== 'success'
            )
              return deny('input');
            // Cedar permits references to absent entities; this adapter requires the
            // caller to supply principal and resource facts, even for broad permits.
            const supplied = new Set(
              facts.entities.map((entity) => uid(entity.uid)),
            );
            if (
              !supplied.has(uid(facts.principal)) ||
              !supplied.has(uid(facts.resource))
            )
              return deny('input');
            const answer = cedar.statefulIsAuthorized({
              principal: facts.principal,
              action: facts.action,
              resource: facts.resource,
              context: facts.context,
              entities: facts.entities,
              preparsedSchemaName: policyRevision,
              preparsedPolicySetId: policyRevision,
              validateRequest: true,
            });
            if (answer.type !== 'success') return deny('evaluation');
            const diagnostics = answer.response.diagnostics;
            const safeId = (id: string) => ids.includes(id);
            const errors = diagnostics.errors
              .map<PolicyDecision['errors'][number]>((error) => ({
                category: 'evaluation',
                ...(safeId(error.policyId) ? { policyId: error.policyId } : {}),
              }))
              .sort((a, b) => {
                const left = a.policyId ?? '';
                const right = b.policyId ?? '';
                return left < right ? -1 : left > right ? 1 : 0;
              });
            return {
              decision: errors.length ? 'deny' : answer.response.decision,
              policyRevision,
              schemaRevision,
              determiningPolicyIds: diagnostics.reason.filter(safeId).sort(),
              errors,
            };
          } catch (error) {
            return deny(error instanceof InputError ? error.category : 'input');
          }
        },
      }),
    };
  } catch (error) {
    return {
      ok: false,
      decision: 'deny',
      errors: [
        { category: error instanceof InputError ? error.category : 'policy' },
      ],
    };
  }
}
