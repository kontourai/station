import { readFileSync } from 'node:fs';
import * as subpathContract from '@kontourai/station-contracts/operational-event';
import { describe, expect, it } from 'vitest';
import { validateOperationalEventEnvelope as rootContract } from '../index.js';
import {
  BUILTIN_OPERATIONAL_EVENT_TYPES,
  createOperationalEventTypeRegistry,
  MAX_OPERATIONAL_EVENT_JSON_ITEMS,
  MAX_OPERATIONAL_EVENT_PAYLOAD_BYTES,
  OPERATIONAL_EVENT_SCHEMA_VERSION,
  type OperationalEventEnvelope,
  type OperationalEventTypeDefinition,
  operationalEventEvidenceInput,
  validateOperationalEventEnvelope,
  validateOperationalEventScopes,
} from '../operational-event.js';

const registry = createOperationalEventTypeRegistry([
  ...BUILTIN_OPERATIONAL_EVENT_TYPES,
  {
    namespace: 'plugin.acme',
    name: 'review.lifecycle',
    version: 1,
    owner: 'plugin',
    payloadSchema: 'plugin.acme.review.lifecycle/v1',
    compatibility: 'additive',
    status: 'active',
  },
  {
    namespace: 'kit.synthetic',
    name: 'check.completed',
    version: 1,
    owner: 'kit',
    payloadSchema: 'kit.synthetic.check.completed/v1',
    compatibility: 'exact',
    status: 'active',
  },
]);

function event(
  overrides: Partial<OperationalEventEnvelope> = {},
): OperationalEventEnvelope {
  return {
    schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
    id: 'evt-123',
    type: 'station.runtime.lifecycle/v1',
    producer: { id: 'station-core', version: '0.1.0' },
    occurredAt: '2026-08-09T12:00:00.000Z',
    sequence: 7,
    correlationId: 'corr-123',
    causationId: 'cause-123',
    scopes: [
      { kind: 'project', projectId: 'project-1' },
      { kind: 'task', taskId: 'task-1', projectId: 'project-1' },
      { kind: 'thread', threadId: 'thread-1', taskId: 'task-1' },
      { kind: 'run', runId: 'run-1', threadId: 'thread-1' },
      { kind: 'workspace', workspaceId: 'workspace-1', projectId: 'project-1' },
    ],
    payload: {
      schema: 'station.runtime.lifecycle/v1',
      data: { state: 'started', metadata: { attempt: 1 } },
    },
    privacy: 'private',
    delivery: 'durable',
    ...overrides,
  };
}

function codes(value: unknown): string[] {
  const result = validateOperationalEventEnvelope(value, registry);
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

describe('the operational event envelope', () => {
  it('publishes the same contract from its explicit package subpath', () => {
    expect(subpathContract.validateOperationalEventEnvelope).toBe(
      validateOperationalEventEnvelope,
    );
    expect(rootContract).toBe(validateOperationalEventEnvelope);
  });

  it('validates built-in, plugin, pane, and synthetic Kit facts through one registry', () => {
    const fixtures: OperationalEventEnvelope[] = [
      event(),
      event({
        id: 'evt-plugin',
        type: 'plugin.acme.review.lifecycle/v1',
        producer: { id: 'acme-plugin', version: '1.2.3' },
        scopes: [{ kind: 'plugin', pluginId: 'acme' }],
        payload: {
          schema: 'plugin.acme.review.lifecycle/v1',
          data: { phase: 'opened' },
        },
        delivery: 'ephemeral',
      }),
      event({
        id: 'evt-pane',
        type: 'station.workspace-pane.lifecycle/v1',
        scopes: [
          { kind: 'project', projectId: 'project-1' },
          {
            kind: 'pane',
            descriptorId: 'preview',
            instanceId: 'preview-1',
            rendererClass: 'sandboxed-mcp-app',
          },
        ],
        payload: {
          schema: 'station.workspace-pane.lifecycle/v1',
          data: { state: 'unavailable', reason: 'renderer-missing' },
        },
        delivery: 'projection',
      }),
      event({
        id: 'evt-plugin-command',
        type: 'station.plugin-command.execution/v1',
        scopes: [{ kind: 'plugin', pluginId: 'demo-plugin' }],
        payload: {
          schema: 'station.plugin-command.execution/v1',
          data: {
            pluginId: 'demo-plugin',
            commandId: 'demo-plugin.review',
            decision: 'authorized',
            outcome: 'admitted',
          },
        },
      }),
      event({
        id: 'evt-kit',
        type: 'kit.synthetic.check.completed/v1',
        producer: { id: 'synthetic-kit', version: '1.0.0' },
        scopes: [{ kind: 'kit', kitId: 'synthetic' }],
        payload: {
          schema: 'kit.synthetic.check.completed/v1',
          data: { result: 'pass' },
        },
        delivery: 'evidence-eligible',
      }),
    ];

    for (const fixture of fixtures) {
      expect(validateOperationalEventEnvelope(fixture, registry)).toMatchObject(
        {
          ok: true,
        },
      );
    }
    const validated = validateOperationalEventEnvelope(event(), registry);
    expect(validated).toMatchObject({ ok: true });
    if (validated.ok) {
      expect(validated.event.scopes).toEqual(event().scopes);
      expect(validated.event.scopes).toHaveLength(event().scopes.length);
    }
  });

  it('fails closed for hostile ids, namespaces, scopes, payloads, and versions', () => {
    const cases: Array<[string, unknown, string]> = [
      ['path-shaped id', event({ id: '../evt' }), 'invalid-id'],
      [
        'invalid namespace',
        event({ type: 'partner.acme.review.lifecycle/v1' }),
        'invalid-type',
      ],
      [
        'unknown event type',
        event({ type: 'station.unknown.event/v1' }),
        'unknown-event-type',
      ],
      [
        'unknown type version',
        event({ type: 'station.runtime.lifecycle/v2' }),
        'unknown-type-version',
      ],
      [
        'unknown envelope version',
        { ...event(), schemaVersion: 'station.operational-event/v2' },
        'unknown-schema-version',
      ],
      [
        'invalid timestamp',
        event({ occurredAt: 'today' }),
        'invalid-timestamp',
      ],
      [
        'rollover timestamp',
        event({ occurredAt: '2026-02-30T12:00:00.000Z' }),
        'invalid-timestamp',
      ],
      [
        'noncanonical timestamp',
        event({ occurredAt: '2026-08-09T12:00:00.12Z' }),
        'invalid-timestamp',
      ],
      [
        'duplicate scope',
        event({
          scopes: [
            { kind: 'project', projectId: 'one' },
            { kind: 'project', projectId: 'two' },
          ],
        }),
        'duplicate-scope',
      ],
      [
        'conflicting scope',
        event({
          scopes: [
            { kind: 'project', projectId: 'one' },
            { kind: 'task', taskId: 'task-1', projectId: 'two' },
          ],
        }),
        'scope-conflict',
      ],
      [
        'plugin namespace escalation',
        event({
          type: 'plugin.acme.review.lifecycle/v1',
          scopes: [{ kind: 'plugin', pluginId: 'other' }],
          payload: { schema: 'plugin.acme.review.lifecycle/v1', data: {} },
        }),
        'namespace-not-authorized',
      ],
      [
        'unknown scope',
        event({ scopes: [{ kind: 'native', handle: 'unsafe' }] as never }),
        'invalid-scope',
      ],
      [
        'scope extra field',
        event({
          scopes: [
            { kind: 'project', projectId: 'project-1', forged: true },
          ] as never,
        }),
        'unknown-field',
      ],
      [
        'oversized payload',
        event({
          payload: {
            schema: 'station.runtime.lifecycle/v1',
            data: 'x'.repeat(MAX_OPERATIONAL_EVENT_PAYLOAD_BYTES + 1),
          },
        }),
        'payload-too-large',
      ],
      [
        'oversized payload graph',
        event({
          payload: {
            schema: 'station.runtime.lifecycle/v1',
            data: Array.from(
              { length: MAX_OPERATIONAL_EVENT_JSON_ITEMS + 1 },
              () => 0,
            ),
          },
        }),
        'payload-too-large',
      ],
      [
        'non-json payload',
        event({
          payload: {
            schema: 'station.runtime.lifecycle/v1',
            data: new Date() as never,
          },
        }),
        'invalid-payload',
      ],
      [
        'invalid privacy',
        event({ privacy: 'secret' as never }),
        'invalid-privacy',
      ],
      [
        'invalid delivery',
        event({ delivery: 'broadcast' as never }),
        'invalid-delivery',
      ],
    ];
    for (const [name, candidate, expected] of cases) {
      expect(codes(candidate), name).toContain(expected);
    }
  });

  it.each([
    ['task.projectId', { kind: 'task', taskId: 'task-1', projectId: '../x' }],
    ['thread.taskId', { kind: 'thread', threadId: 'thread-1', taskId: '../x' }],
    ['run.threadId', { kind: 'run', runId: 'run-1', threadId: '../x' }],
    [
      'workspace.projectId',
      { kind: 'workspace', workspaceId: 'workspace-1', projectId: '../x' },
    ],
  ])('fails closed when optional linked scope id %s is hostile', (_, scope) => {
    const result = validateOperationalEventEnvelope(
      event({ scopes: [scope] as never }),
      registry,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'invalid-scope',
    );
  });

  it('shares one strict scope parser with manifest declarations', () => {
    expect(
      validateOperationalEventScopes([
        { kind: 'project', projectId: 'project-1' },
        { kind: 'task', taskId: 'task-1', projectId: 'project-1' },
      ]),
    ).toMatchObject({
      ok: true,
      scopes: [
        { kind: 'project', projectId: 'project-1' },
        { kind: 'task', taskId: 'task-1', projectId: 'project-1' },
      ],
    });
    expect(
      validateOperationalEventScopes([
        { kind: 'project', projectId: 'project-1' },
        { kind: 'task', taskId: 'task-1', projectId: 'other-project' },
      ]),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'scope-conflict' }],
    });
  });

  it('keeps type registry ownership, versioning, and deprecation explicit', () => {
    expect(() =>
      createOperationalEventTypeRegistry([
        {
          namespace: 'station',
          name: 'forged',
          version: 1,
          owner: 'plugin',
          payloadSchema: 'station.forged/v1',
          compatibility: 'exact',
          status: 'active',
        },
      ]),
    ).toThrow(/Only Station owns/);
    const deprecated = createOperationalEventTypeRegistry([
      {
        namespace: 'station',
        name: 'runtime.lifecycle',
        version: 1,
        owner: 'station',
        payloadSchema: 'station.runtime.lifecycle/v1',
        compatibility: 'exact',
        status: 'deprecated',
      },
    ]);
    expect(validateOperationalEventEnvelope(event(), deprecated)).toMatchObject(
      {
        ok: true,
        diagnostics: [{ code: 'type-deprecated' }],
      },
    );
    expect(operationalEventEvidenceInput(event(), deprecated)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'type-deprecated' }],
    });
  });

  it('owns an immutable registry snapshot rather than caller-owned definitions', () => {
    const definition: OperationalEventTypeDefinition = {
      namespace: 'plugin.acme',
      name: 'review.lifecycle',
      version: 1,
      owner: 'plugin',
      payloadSchema: 'plugin.acme.review.lifecycle/v1',
      compatibility: 'additive',
      status: 'active',
    };
    const immutable = createOperationalEventTypeRegistry([definition]);
    definition.name = 'forged';
    definition.payloadSchema = 'plugin.acme.forged/v1';
    expect(Object.isFrozen(immutable)).toBe(true);
    expect(Object.isFrozen(immutable.definitions)).toBe(true);
    expect(Object.isFrozen(immutable.definitions[0])).toBe(true);
    expect(
      validateOperationalEventEnvelope(
        event({
          type: 'plugin.acme.review.lifecycle/v1',
          scopes: [{ kind: 'plugin', pluginId: 'acme' }],
          payload: { schema: 'plugin.acme.review.lifecycle/v1', data: {} },
        }),
        immutable,
      ),
    ).toMatchObject({ ok: true });
    expect(() => {
      (immutable.definitions as OperationalEventTypeDefinition[])[0].name =
        'forged';
    }).toThrow(TypeError);
  });

  it('exposes stable evidence inputs without creating a trust object', () => {
    const first = event({
      delivery: 'evidence-eligible',
      payload: {
        schema: 'station.runtime.lifecycle/v1',
        data: { z: 1, nested: { b: 2, a: 3 } },
      },
    });
    const second = event({
      delivery: 'evidence-eligible',
      payload: {
        schema: 'station.runtime.lifecycle/v1',
        data: { nested: { a: 3, b: 2 }, z: 1 },
      },
    });
    const a = operationalEventEvidenceInput(first, registry);
    const b = operationalEventEvidenceInput(second, registry);
    expect(a).toMatchObject({ ok: true, eventId: 'evt-123' });
    expect(b).toMatchObject({ ok: true, eventId: 'evt-123' });
    if (a.ok && b.ok) {
      expect(a.digestInput).toBe(b.digestInput);
      expect(a.digestInput).not.toContain('trustBundle');
    }
    expect(operationalEventEvidenceInput(event(), registry)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'evidence-ineligible' }],
    });
  });

  it('has no primitive or native-host import boundary', () => {
    const source = readFileSync(
      new URL('../operational-event.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(
      /from\s+['"][^'"]*(?:@kontourai\/(?:surface|console(?:-|\/)|flow(?:-agents)?|conduit)|src-(?:server|desktop)|node:)/,
    );
    expect(source).not.toMatch(/\b(?:dispatch|persist|callback)\s*\(/);
  });
});
