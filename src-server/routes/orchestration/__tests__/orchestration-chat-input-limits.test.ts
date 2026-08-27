import { describe, expect, test } from 'vitest';
import { z } from 'zod/v3';
import { CHAT_INPUT_MAX_CHARS } from '../../../../src-shared/chat-input-limits.js';
import {
  continueDelegatedTaskBodySchema,
  continueForegroundMessageSchema,
  delegateTaskSchema,
  foregroundMessageObjectSchema,
  orchestrationCommandSchema,
} from '../orchestration.js';

// station#2807 H2: the composer does NOT post to /api/agents/:slug/chat —
// it posts to /api/orchestration/chat. Before this pin, that route's text
// bounds were hardcoded literals: raising CHAT_INPUT_MAX_CHARS would have
// left the composer enabling Send at sizes this seam still refused with a
// generic zod message. Every turn-starting text bound here must DERIVE from
// the same exported constant the composer reads; these pins fail if any of
// them stops deriving.
describe('orchestration turn-text bounds derive from CHAT_INPUT_MAX_CHARS (station#2807)', () => {
  const target = { agent: 'station' };

  test('foreground message accepts exactly the shared limit and refuses one more', () => {
    expect(() =>
      foregroundMessageObjectSchema.parse({
        target,
        message: 'x'.repeat(CHAT_INPUT_MAX_CHARS),
      }),
    ).not.toThrow();
    expect(() =>
      foregroundMessageObjectSchema.parse({
        target,
        message: 'x'.repeat(CHAT_INPUT_MAX_CHARS + 1),
      }),
    ).toThrow();
  });

  test('delegate task prompt accepts exactly the shared limit and refuses one more', () => {
    expect(() =>
      delegateTaskSchema.parse({
        target,
        prompt: 'x'.repeat(CHAT_INPUT_MAX_CHARS),
      }),
    ).not.toThrow();
    expect(() =>
      delegateTaskSchema.parse({
        target,
        prompt: 'x'.repeat(CHAT_INPUT_MAX_CHARS + 1),
      }),
    ).toThrow();
  });

  test('delegated-task continuation message accepts exactly the shared limit and refuses one more', () => {
    expect(() =>
      continueDelegatedTaskBodySchema.parse({
        message: 'x'.repeat(CHAT_INPUT_MAX_CHARS),
      }),
    ).not.toThrow();
    expect(() =>
      continueDelegatedTaskBodySchema.parse({
        message: 'x'.repeat(CHAT_INPUT_MAX_CHARS + 1),
      }),
    ).toThrow();
  });

  // station#2831: steerTurn.input carries a composer draft verbatim (the
  // queued-message steer path sends the same string the composer's courtesy
  // check gates), so it derives from the same constant — the 100_000 literal
  // that lived here refused at half the composer's limit.
  test('steerTurn input accepts exactly the shared limit and refuses one more', () => {
    expect(() =>
      orchestrationCommandSchema.parse({
        type: 'steerTurn',
        threadId: 'thread-1',
        input: 'x'.repeat(CHAT_INPUT_MAX_CHARS),
      }),
    ).not.toThrow();
    expect(() =>
      orchestrationCommandSchema.parse({
        type: 'steerTurn',
        threadId: 'thread-1',
        input: 'x'.repeat(CHAT_INPUT_MAX_CHARS + 1),
      }),
    ).toThrow();
  });
});

// station#2831: the behavioral pins above can only see fields someone
// remembered to name — the original pin enumerated three schemas while a
// fourth (steerTurn.input) hardcoded half the constant. This structural
// walker inverts the posture: it walks EVERY string field reachable in the
// seam's exported schemas and fails unless each one is either bounded by a
// `.max()` no larger than CHAT_INPUT_MAX_CHARS or listed in the RECORDED
// exception map below with a reason. A NEW string field on any of these
// schemas fails this test the moment it is added — before any behavioral
// pin for it exists.
//
// Honest residual, do not paper over it: the walker sees only these five
// schemas. A brand-new schema, route, or file on this seam is invisible to
// it until the schema is exported and added to SEAM_SCHEMAS — this remains
// an enumeration at the schema level; it is default-deny at the FIELD level
// for every node type the walker resolves, and it fails closed (throws) on
// any node type it does not know rather than reporting an absence.
describe('every string field on the orchestration seam is bounded or carries a recorded reason (station#2831)', () => {
  const SEAM_SCHEMAS: Array<{ name: string; schema: z.ZodTypeAny }> = [
    { name: 'orchestrationCommandSchema', schema: orchestrationCommandSchema },
    { name: 'delegateTaskSchema', schema: delegateTaskSchema },
    {
      name: 'foregroundMessageObjectSchema',
      schema: foregroundMessageObjectSchema,
    },
    {
      name: 'continueForegroundMessageSchema',
      schema: continueForegroundMessageSchema,
    },
    {
      name: 'continueDelegatedTaskBodySchema',
      schema: continueDelegatedTaskBodySchema,
    },
  ];

  // Recorded, reasoned exceptions: string fields that are deliberately NOT
  // bounded by the prompt/text constants. Every entry must name WHY. If one
  // of these no longer exists, the stale-entry check below fails so this
  // list can never rot into hiding a real field.
  const EXCEPTIONS = new Map<string, string>([
    [
      'orchestrationCommandSchema.interruptTurn.threadId',
      'session id, not user text; bounded by the transport body cap. NOTE the operative number is 1 MiB, not 22: /api/orchestration/commands is absent from STREAMING_MUTATION_PREFIXES (runtime-request-security.ts:289), so it classifies as a standard mutation and binds at maxMutationBodyBytes ?? 1_048_576 — stricter than the route-level maxBodyBytes it passes, so no hole, but that route-level constant is not what actually binds',
    ],
    [
      'orchestrationCommandSchema.interruptTurn.turnId',
      'turn id, not user text; bounded by the transport body cap. NOTE the operative number is 1 MiB, not 22: /api/orchestration/commands is absent from STREAMING_MUTATION_PREFIXES (runtime-request-security.ts:289), so it classifies as a standard mutation and binds at maxMutationBodyBytes ?? 1_048_576 — stricter than the route-level maxBodyBytes it passes, so no hole, but that route-level constant is not what actually binds',
    ],
    [
      'orchestrationCommandSchema.steerTurn.threadId',
      'session id, not user text; bounded by the transport body cap. NOTE the operative number is 1 MiB, not 22: /api/orchestration/commands is absent from STREAMING_MUTATION_PREFIXES (runtime-request-security.ts:289), so it classifies as a standard mutation and binds at maxMutationBodyBytes ?? 1_048_576 — stricter than the route-level maxBodyBytes it passes, so no hole, but that route-level constant is not what actually binds',
    ],
    [
      'orchestrationCommandSchema.steerTurn.turnId',
      'turn id, not user text; bounded by the transport body cap. NOTE the operative number is 1 MiB, not 22: /api/orchestration/commands is absent from STREAMING_MUTATION_PREFIXES (runtime-request-security.ts:289), so it classifies as a standard mutation and binds at maxMutationBodyBytes ?? 1_048_576 — stricter than the route-level maxBodyBytes it passes, so no hole, but that route-level constant is not what actually binds',
    ],
    [
      'orchestrationCommandSchema.respondToRequest.threadId',
      'session id, not user text; bounded by the transport body cap. NOTE the operative number is 1 MiB, not 22: /api/orchestration/commands is absent from STREAMING_MUTATION_PREFIXES (runtime-request-security.ts:289), so it classifies as a standard mutation and binds at maxMutationBodyBytes ?? 1_048_576 — stricter than the route-level maxBodyBytes it passes, so no hole, but that route-level constant is not what actually binds',
    ],
    [
      'orchestrationCommandSchema.respondToRequest.requestId',
      'request id, not user text; bounded by the transport body cap. NOTE the operative number is 1 MiB, not 22: /api/orchestration/commands is absent from STREAMING_MUTATION_PREFIXES (runtime-request-security.ts:289), so it classifies as a standard mutation and binds at maxMutationBodyBytes ?? 1_048_576 — stricter than the route-level maxBodyBytes it passes, so no hole, but that route-level constant is not what actually binds',
    ],
    [
      'orchestrationCommandSchema.stopSession.threadId',
      'session id, not user text; bounded by the transport body cap. NOTE the operative number is 1 MiB, not 22: /api/orchestration/commands is absent from STREAMING_MUTATION_PREFIXES (runtime-request-security.ts:289), so it classifies as a standard mutation and binds at maxMutationBodyBytes ?? 1_048_576 — stricter than the route-level maxBodyBytes it passes, so no hole, but that route-level constant is not what actually binds',
    ],
    [
      'foregroundMessageObjectSchema.attachments[].dataUrl',
      'inline attachment bytes — the #2828 declared budget (CHAT_ATTACHMENT_MAX_*), not the prompt budget',
    ],
    [
      'continueForegroundMessageSchema.attachments[].dataUrl',
      'inline attachment bytes — the #2828 declared budget (CHAT_ATTACHMENT_MAX_*), not the prompt budget',
    ],
    [
      'foregroundMessageObjectSchema.target.model.options<key>',
      'provider option names, not model-facing prompt text; bounded by the request body cap',
    ],
    [
      'foregroundMessageObjectSchema.target.model.options<value>',
      'z.record(z.unknown()) value — NOT bounded here, and not bounded by size anywhere. The operative defence is a KEY allowlist in another module: unsupportedModelOptionKeys (packages/contracts/src/provider.ts), enforced at execution-target-resolver.ts and orchestration-service.ts, which rejects every key outside a short per-provider list (systemPrompt is refused for every mapped provider). Two limits of that defence, stated rather than implied: it filters by key name, never by value size, and it FAILS OPEN for a provider absent from PROVIDER_MODEL_OPTION_SUPPORT (`if (!supported) return []`, deliberate per its docblock). So a large value under an allowed key, or any key at all on an unmapped provider, is bounded only by the request body cap — see station#2838.',
    ],
    [
      'delegateTaskSchema.target.model.options<value>',
      'z.record(z.unknown()) value — NOT bounded here, and not bounded by size anywhere. The operative defence is a KEY allowlist in another module: unsupportedModelOptionKeys (packages/contracts/src/provider.ts), enforced at execution-target-resolver.ts and orchestration-service.ts, which rejects every key outside a short per-provider list (systemPrompt is refused for every mapped provider). Two limits of that defence, stated rather than implied: it filters by key name, never by value size, and it FAILS OPEN for a provider absent from PROVIDER_MODEL_OPTION_SUPPORT (`if (!supported) return []`, deliberate per its docblock). So a large value under an allowed key, or any key at all on an unmapped provider, is bounded only by the request body cap — see station#2838.',
    ],
    [
      'continueForegroundMessageSchema.model.options<value>',
      'z.record(z.unknown()) value — NOT bounded here, and not bounded by size anywhere. The operative defence is a KEY allowlist in another module: unsupportedModelOptionKeys (packages/contracts/src/provider.ts), enforced at execution-target-resolver.ts and orchestration-service.ts, which rejects every key outside a short per-provider list (systemPrompt is refused for every mapped provider). Two limits of that defence, stated rather than implied: it filters by key name, never by value size, and it FAILS OPEN for a provider absent from PROVIDER_MODEL_OPTION_SUPPORT (`if (!supported) return []`, deliberate per its docblock). So a large value under an allowed key, or any key at all on an unmapped provider, is bounded only by the request body cap — see station#2838.',
    ],
    [
      'continueDelegatedTaskBodySchema.modelOptions<value>',
      'z.record(z.unknown()) value — NOT bounded here, and not bounded by size anywhere. The operative defence is a KEY allowlist in another module: unsupportedModelOptionKeys (packages/contracts/src/provider.ts), enforced at execution-target-resolver.ts and orchestration-service.ts, which rejects every key outside a short per-provider list (systemPrompt is refused for every mapped provider). Two limits of that defence, stated rather than implied: it filters by key name, never by value size, and it FAILS OPEN for a provider absent from PROVIDER_MODEL_OPTION_SUPPORT (`if (!supported) return []`, deliberate per its docblock). So a large value under an allowed key, or any key at all on an unmapped provider, is bounded only by the request body cap — see station#2838.',
    ],
    [
      'delegateTaskSchema.target.model.options<key>',
      'provider option names, not model-facing prompt text; bounded by the request body cap',
    ],
    [
      'continueForegroundMessageSchema.model.options<key>',
      'provider option names, not model-facing prompt text; bounded by the request body cap',
    ],
    [
      'continueDelegatedTaskBodySchema.modelOptions<key>',
      'provider option names, not model-facing prompt text; bounded by the request body cap',
    ],
  ]);

  interface StringCheck {
    kind: string;
    value?: unknown;
  }

  interface SchemaDef {
    typeName?: string;
    checks?: StringCheck[];
    schema?: z.ZodTypeAny;
    innerType?: z.ZodTypeAny;
    type?: z.ZodTypeAny;
    keyType?: z.ZodTypeAny;
    valueType?: z.ZodTypeAny;
    value?: unknown;
  }

  function defOf(schema: z.ZodTypeAny): SchemaDef {
    return (schema as unknown as { _def: SchemaDef })._def;
  }

  function effectiveMax(schema: z.ZodString): number | undefined {
    let max: number | undefined;
    for (const check of defOf(schema).checks ?? []) {
      if (check.kind === 'max' && typeof check.value === 'number') {
        max = max === undefined ? check.value : Math.min(max, check.value);
      }
    }
    return max;
  }

  function optionLabel(option: z.ZodTypeAny): string | null {
    if (defOf(option).typeName !== 'ZodObject') return null;
    const typeField = (
      option as unknown as { shape: Record<string, z.ZodTypeAny> }
    ).shape.type;
    if (!typeField || defOf(typeField).typeName !== 'ZodLiteral') return null;
    const value = defOf(typeField).value;
    return typeof value === 'string' ? value : null;
  }

  function collectStringFields(
    schema: z.ZodTypeAny,
    path: string,
    out: Array<{ path: string; max: number | undefined }>,
  ): void {
    const def = defOf(schema);
    switch (def.typeName) {
      case 'ZodString':
        out.push({ path, max: effectiveMax(schema as z.ZodString) });
        return;
      case 'ZodOptional':
      case 'ZodNullable':
        // `unwrap()` is declared on the concrete ZodOptional/ZodNullable
        // classes, not on ZodTypeAny, so reach through the def instead —
        // the walker is typed against the base.
        if (def.innerType) collectStringFields(def.innerType, path, out);
        return;
      case 'ZodDefault':
        if (def.innerType) collectStringFields(def.innerType, path, out);
        return;
      case 'ZodEffects':
        if (def.schema) collectStringFields(def.schema, path, out);
        return;
      case 'ZodObject': {
        const shape = (
          schema as unknown as { shape: Record<string, z.ZodTypeAny> }
        ).shape;
        for (const [key, value] of Object.entries(shape)) {
          collectStringFields(value, `${path}.${key}`, out);
        }
        return;
      }
      case 'ZodUnion':
      case 'ZodDiscriminatedUnion': {
        const options = (schema as unknown as { options: z.ZodTypeAny[] })
          .options;
        for (const option of options) {
          const label = optionLabel(option);
          collectStringFields(option, label ? `${path}.${label}` : path, out);
        }
        return;
      }
      case 'ZodArray':
        if (def.type) collectStringFields(def.type, `${path}[]`, out);
        return;
      case 'ZodRecord':
        if (def.keyType) collectStringFields(def.keyType, `${path}<key>`, out);
        if (def.valueType)
          collectStringFields(def.valueType, `${path}<value>`, out);
        return;
      case 'ZodLiteral':
      case 'ZodEnum':
      case 'ZodNativeEnum':
      case 'ZodNumber':
      case 'ZodBigInt':
      case 'ZodBoolean':
      case 'ZodDate':
      case 'ZodSymbol':
      case 'ZodUndefined':
      case 'ZodNull':
      case 'ZodVoid':
      case 'ZodNever':
      case 'ZodNaN':
        // Non-string primitives: nothing to bound, and nothing hidden.
        return;
      case 'ZodUnknown':
      case 'ZodAny':
        // Record, do not skip. An `any`/`unknown` node can carry a string of
        // any size, so silently returning here would make the walker report
        // "no string field" for exactly the shapes that bound nothing — a
        // completeness claim that reads as coverage. Recorded as unbounded,
        // it must be answered with an exception naming the real defence.
        out.push({ path, max: undefined });
        return;
      default:
        throw new Error(
          `structural walker does not know zod node type ${String(def.typeName)} at ${path} — teach the walker or bound the field`,
        );
    }
  }

  test('no unbounded or over-ceiling string field exists on the seam, and no exception entry is stale', () => {
    const fields: Array<{ path: string; max: number | undefined }> = [];
    for (const { name, schema } of SEAM_SCHEMAS) {
      collectStringFields(schema, name, fields);
    }
    const violations: string[] = [];
    for (const field of fields) {
      if (EXCEPTIONS.has(field.path)) continue;
      if (field.max === undefined) {
        violations.push(`${field.path}: no .max() bound`);
      } else if (field.max > CHAT_INPUT_MAX_CHARS) {
        violations.push(
          `${field.path}: max ${field.max} exceeds CHAT_INPUT_MAX_CHARS (${CHAT_INPUT_MAX_CHARS})`,
        );
      }
    }
    expect(
      violations.sort(),
      `unbounded string fields on the orchestration seam (bound them or record a reasoned exception):\n${violations.join('\n')}`,
    ).toEqual([]);
    const walked = new Set(fields.map((field) => field.path));
    const stale = [...EXCEPTIONS.keys()].filter((path) => !walked.has(path));
    expect(
      stale.sort(),
      'exception entries naming fields that no longer exist (prune them)',
    ).toEqual([]);
  });
});
