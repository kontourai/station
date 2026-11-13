import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  ENGINE_EXTENSION_BINDINGS,
  ENGINE_EXTENSION_CONSUMERS,
  type EngineExtensionConsumerId,
  EXTENSION_NOTIFICATION_BINDINGS,
  engineExtensionBinding,
  extensionNotificationBinding,
  GROK_LIVE_CAPTURE,
  KIRO_V3_LIVE_CAPTURE,
  takeUnboundExtensionNotice,
} from '../extension-notification-bindings.js';

describe('extension notification bindings', () => {
  test('pins the exact evidenced functional consumer set', () => {
    expect(Object.isFrozen(EXTENSION_NOTIFICATION_BINDINGS)).toBe(true);
    expect(
      EXTENSION_NOTIFICATION_BINDINGS.every(
        (binding) =>
          Object.isFrozen(binding) && Object.isFrozen(binding.observedAgainst),
      ),
    ).toBe(true);
    // The exact (namespace, type, consumer) allowlist (ADR 0013), plus its
    // provenance. archive#4084 review fix round: project `evidence` and
    // `observedAgainst` too, so a binding attributed to the wrong runtime
    // observation (e.g. error/rate_limit credited to #1815 instead of #4084)
    // fails here instead of hiding behind the projection.
    expect(
      EXTENSION_NOTIFICATION_BINDINGS.map(
        ({ namespace, type, consumer, observedAgainst, evidence }) => ({
          namespace,
          type,
          consumer,
          observedAgainst,
          evidence,
        }),
      ),
    ).toEqual([
      {
        namespace: '_kiro.dev',
        type: 'commands/available',
        consumer: 'acp.commands.available',
        observedAgainst: ['kiro-v2'],
        evidence: 'station#1815-runtime-observation',
      },
      {
        namespace: '_kiro.dev',
        type: 'mcp/oauth_request',
        consumer: 'ui.kiro.oauth-request',
        observedAgainst: ['kiro-v2'],
        evidence: 'station#1815-runtime-observation',
      },
      {
        namespace: '_kiro.dev',
        type: 'compaction/status',
        consumer: 'ui.kiro.compaction-status',
        observedAgainst: ['kiro-v2'],
        evidence: 'station#1815-runtime-observation',
      },
      {
        namespace: '_kiro.dev',
        type: 'clear/status',
        consumer: 'ui.kiro.clear-status',
        observedAgainst: ['kiro-v2'],
        evidence: 'station#1815-runtime-observation',
      },
      {
        namespace: '_kiro.dev',
        type: 'error/rate_limit',
        consumer: 'acp.turn-error-cause',
        observedAgainst: ['kiro-v2'],
        evidence: 'station#4084-runtime-observation',
      },
      {
        namespace: 'claude-code',
        type: 'api/retry',
        consumer: 'ui.claude.api-retry',
        observedAgainst: ['claude-adapter'],
        evidence: 'claude-sdk-api-retry-contract',
      },
      {
        namespace: 'claude-code',
        type: 'thinking/tokens',
        consumer: 'ui.claude.thinking-tokens',
        observedAgainst: ['claude-adapter'],
        evidence: 'station#1815-runtime-observation',
      },
      {
        namespace: 'claude-code',
        type: 'session/status',
        consumer: 'ui.claude.session-status',
        observedAgainst: ['claude-adapter'],
        evidence: 'station#1815-runtime-observation',
      },
      {
        namespace: 'claude-code',
        type: 'task/registry',
        consumer: 'ui.claude.task-registry',
        observedAgainst: ['claude-adapter'],
        evidence: 'station#1815-runtime-observation',
      },
      {
        namespace: 'claude-code',
        type: 'task/settled',
        consumer: 'ui.claude.task-settled',
        observedAgainst: ['claude-adapter'],
        evidence: 'station#1815-runtime-observation',
      },
      {
        namespace: '_kiro.dev',
        type: 'subagent/list_update',
        consumer: 'acp.host-chrome',
        observedAgainst: ['kiro-v2'],
        evidence: 'station#1935-runtime-observation',
      },
      {
        namespace: '_x.ai',
        type: 'models/update',
        consumer: 'acp.host-chrome',
        observedAgainst: ['xai-acp'],
        evidence: 'station#1935-runtime-observation',
      },
      {
        namespace: '_x.ai',
        type: 'settings/update',
        consumer: 'acp.host-chrome',
        observedAgainst: ['xai-acp'],
        evidence: 'station#1935-runtime-observation',
      },
      {
        namespace: '_x.ai',
        type: 'sessions/changed',
        consumer: 'acp.host-chrome',
        observedAgainst: ['xai-acp'],
        evidence: 'station#1935-runtime-observation',
      },
      {
        namespace: '_x.ai',
        type: 'announcements/update',
        consumer: 'acp.host-chrome',
        observedAgainst: ['xai-acp'],
        evidence: 'station#1935-runtime-observation',
      },
      {
        namespace: '_x.ai',
        type: 'queue/changed',
        consumer: 'acp.host-chrome',
        observedAgainst: ['xai-acp'],
        evidence: 'station#1935-runtime-observation',
      },
      {
        namespace: '_x.ai',
        type: 'session_notification',
        consumer: 'acp.host-chrome',
        observedAgainst: ['xai-acp'],
        evidence: 'station#1935-runtime-observation',
      },
      {
        namespace: '_x.ai',
        type: 'session/prompt_complete',
        consumer: 'acp.host-chrome',
        observedAgainst: ['xai-acp'],
        evidence: 'station#1935-runtime-observation',
      },
      {
        namespace: '_x.ai',
        type: 'mcp/init_progress',
        consumer: 'ui.engine.mcp-status',
        observedAgainst: ['xai-acp'],
        evidence: 'station#1935-runtime-observation',
      },
      {
        namespace: '_x.ai',
        type: 'mcp_initialized',
        consumer: 'ui.engine.mcp-status',
        observedAgainst: ['xai-acp'],
        evidence: 'station#1935-runtime-observation',
      },
      {
        namespace: '_x.ai',
        type: 'mcp/servers_updated',
        consumer: 'ui.engine.mcp-status',
        observedAgainst: ['xai-acp'],
        evidence: 'station#1935-runtime-observation',
      },
      {
        namespace: 'cursor',
        type: 'update_todos',
        consumer: 'acp.cursor.todos',
        observedAgainst: ['cursor-acp'],
        evidence: 'cursor-acp-docs-contract',
      },
      // station#3415: derived from the transcript projection's marker table.
      {
        namespace: 'codex-rollout',
        type: 'context-compacted',
        consumer: 'transcript.marker',
        observedAgainst: ['codex-rollout-session-source'],
        evidence: 'station-session-source-emitter',
      },
      {
        namespace: 'grok-session',
        type: 'context-compacted',
        consumer: 'transcript.marker',
        observedAgainst: ['grok-session-source'],
        evidence: 'station-session-source-emitter',
      },
      {
        namespace: 'grok-session',
        type: 'conversation-rewound',
        consumer: 'transcript.marker',
        observedAgainst: ['grok-session-source'],
        evidence: 'station-session-source-emitter',
      },
      {
        namespace: 'station-workload',
        type: 'command-oom-killed',
        consumer: 'transcript.marker',
        observedAgainst: ['codex-adapter-transport'],
        evidence: 'station-session-source-emitter',
      },
      // Engine-extension rows whose consumer is implemented today: the
      // canonical-event consumers the ACP mapper publishes, and the
      // notifications Station accepts as host chrome.
      {
        namespace: '_kiro.dev',
        type: 'mcp/server_initialized',
        consumer: 'engine-mcp.status',
        observedAgainst: ['kiro-v2'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_kiro.dev',
        type: 'mcp/server_init_failure',
        consumer: 'engine-mcp.status',
        observedAgainst: ['kiro-v2'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_kiro.dev',
        type: 'metadata',
        consumer: 'usage.context-percent',
        observedAgainst: ['kiro-v2'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_kiro',
        type: 'memory/syncStatus',
        consumer: 'acp.host-chrome',
        observedAgainst: ['kiro-v3'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_kiro',
        type: 'governance/state',
        consumer: 'acp.host-chrome',
        observedAgainst: ['kiro-v3'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_kiro',
        type: 'powers/items_changed',
        consumer: 'acp.host-chrome',
        observedAgainst: ['kiro-v3'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_kiro',
        type: 'sessions/changed',
        consumer: 'acp.host-chrome',
        observedAgainst: ['kiro-v3'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_kiro',
        type: 'mcp/status',
        consumer: 'engine-mcp.status',
        observedAgainst: ['kiro-v3'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_kiro',
        type: 'tools/didChange',
        consumer: 'acp.host-chrome',
        observedAgainst: ['kiro-v3'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_kiro',
        type: 'progressive_context/items_changed',
        consumer: 'acp.host-chrome',
        observedAgainst: ['kiro-v3'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_kiro',
        type: 'steering/documents_changed',
        consumer: 'acp.host-chrome',
        observedAgainst: ['kiro-v3'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_x.ai',
        type: 'session/setup',
        consumer: 'acp.host-chrome',
        observedAgainst: ['xai-acp'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_x.ai',
        type: 'mcp/server_status',
        consumer: 'engine-mcp.status',
        observedAgainst: ['xai-acp'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_x.ai',
        type: 'session/interjection',
        consumer: 'acp.host-chrome',
        observedAgainst: ['xai-acp'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_x.ai',
        type: 'task_backgrounded',
        consumer: 'child-work',
        observedAgainst: ['xai-acp'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_x.ai',
        type: 'task_completed',
        consumer: 'child-work',
        observedAgainst: ['xai-acp'],
        evidence: 'engine-extension-binding',
      },
      {
        namespace: '_x.ai',
        type: 'monitor_event',
        consumer: 'child-work',
        observedAgainst: ['xai-acp'],
        evidence: 'engine-extension-binding',
      },
    ]);
  });

  test('keeps the unevidenced v3 spelling as an exact no-op', () => {
    expect(
      extensionNotificationBinding('_kiro', 'mcp/oauth_request'),
    ).toBeUndefined();
    expect(
      extensionNotificationBinding('_kiro.dev', 'unknown'),
    ).toBeUndefined();
  });

  test('takeUnboundExtensionNotice fires once per provider-tuple', () => {
    // A tuple no other test in this module instance takes, so the
    // process-lifetime first-seen set starts without it.
    const type = 'bindings-test/fires-once';
    expect(takeUnboundExtensionNotice('acp', '_x.ai', type)).toBe(true);
    expect(takeUnboundExtensionNotice('acp', '_x.ai', type)).toBe(false);
    expect(takeUnboundExtensionNotice('claude', '_x.ai', type)).toBe(true);
  });
});

describe('engine extension bindings (Kiro parity)', () => {
  const placeholders = Object.keys(
    ENGINE_EXTENSION_CONSUMERS,
  ) as EngineExtensionConsumerId[];

  test('rows are frozen data with unique ids and unique wire shapes', () => {
    expect(Object.isFrozen(ENGINE_EXTENSION_BINDINGS)).toBe(true);
    const ids = ENGINE_EXTENSION_BINDINGS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    const wires = ENGINE_EXTENSION_BINDINGS.map(({ wire }) =>
      JSON.stringify(wire),
    );
    expect(new Set(wires).size).toBe(wires.length);
    for (const row of ENGINE_EXTENSION_BINDINGS) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(engineExtensionBinding(row.wire)).toBe(row);
    }
  });

  test('a placeholder consumer binds no notification until it is implemented', () => {
    const unimplemented = placeholders.filter(
      (consumer) => !ENGINE_EXTENSION_CONSUMERS[consumer].implemented,
    );
    expect(unimplemented.length).toBeGreaterThan(0);
    expect(
      EXTENSION_NOTIFICATION_BINDINGS.filter(({ consumer }) =>
        (unimplemented as string[]).includes(consumer),
      ),
    ).toEqual([]);
    // `child-work` is implemented, but Kiro's rows for it are pending: its
    // v2 tuple keeps the host-chrome row and its rows bind nothing.
    expect(ENGINE_EXTENSION_CONSUMERS['child-work'].implemented).toBe(true);
    expect(
      extensionNotificationBinding('_kiro.dev', 'subagent/list_update')
        ?.consumer,
    ).toBe('acp.host-chrome');
    const pending = ENGINE_EXTENSION_BINDINGS.filter((row) => row.pending);
    expect(pending.map(({ id }) => id)).toEqual([
      'kiro-v2.subagent-list-update',
      'kiro-v3.tool.agent-subtask',
    ]);
    for (const row of pending) {
      expect(
        ENGINE_EXTENSION_CONSUMERS[row.consumer as EngineExtensionConsumerId]
          ?.implemented,
      ).toBe(true);
      if (row.wire.kind !== 'notification') continue;
      const [namespace, type] = [
        row.wire.method.slice(0, row.wire.method.indexOf('/')),
        row.wire.method.slice(row.wire.method.indexOf('/') + 1),
      ];
      expect(extensionNotificationBinding(namespace, type)?.consumer).not.toBe(
        row.consumer,
      );
    }
  });

  test('the events-and-UI consumers are implemented, so their rows bind', () => {
    for (const consumer of [
      'engine-mcp.status',
      'model.rerouted',
      'usage.reported-cost',
      'usage.context-percent',
      'session.message-id',
    ] as const)
      expect(ENGINE_EXTENSION_CONSUMERS[consumer].implemented).toBe(true);
    expect(extensionNotificationBinding('_kiro', 'mcp/status')?.consumer).toBe(
      'engine-mcp.status',
    );
  });

  test('a re-routed v2 tuple keeps its current binding until that row is removed', () => {
    expect(
      engineExtensionBinding({
        kind: 'notification',
        method: '_kiro.dev/mcp/oauth_request',
      })?.consumer,
    ).toBe('input-request.url');
    expect(
      extensionNotificationBinding('_kiro.dev', 'mcp/oauth_request')?.consumer,
    ).toBe('ui.kiro.oauth-request');
    const tuples = EXTENSION_NOTIFICATION_BINDINGS.map(
      ({ namespace, type }) => `${namespace}/${type}`,
    );
    expect(new Set(tuples).size).toBe(tuples.length);
  });

  test('every row observed live is in the scrubbed 2.35 capture, as that wire shape', () => {
    const frames = readFileSync(
      new URL(`../../${KIRO_V3_LIVE_CAPTURE}`, import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).msg);
    const seen = (row: (typeof ENGINE_EXTENSION_BINDINGS)[number]) =>
      frames.some((msg) => {
        const { wire } = row;
        if (wire.kind === 'notification')
          return msg.method === wire.method && msg.id === undefined;
        if (wire.kind === 'request')
          return msg.method === wire.method && msg.id !== undefined;
        if (wire.kind === 'session-info-kind')
          return (
            msg.method === 'session/update' &&
            msg.params?.update?.sessionUpdate === 'session_info_update' &&
            msg.params.update._meta?.[wire.namespace]?.kind === wire.metaKind
          );
        return false;
      });
    const live = ENGINE_EXTENSION_BINDINGS.filter(
      ({ observed }) => observed.variant === 'kiro-v3-2.35',
    );
    // 8 notifications, 9 session-info kinds and `_kiro/terminal/shell_type`.
    expect(live).toHaveLength(18);
    expect(live.filter((row) => !seen(row)).map(({ id }) => id)).toEqual([]);
  });

  test('the capture holds no home directory or real session id', () => {
    const capture = readFileSync(
      new URL(`../../${KIRO_V3_LIVE_CAPTURE}`, import.meta.url),
      'utf8',
    );
    expect(capture).not.toMatch(/\/Users\//);
    expect(capture).not.toMatch(/sess_[0-9a-f]{8}-/);
  });
});

describe('engine extension bindings (Grok)', () => {
  const frames = () =>
    readFileSync(new URL(`../../${GROK_LIVE_CAPTURE}`, import.meta.url), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { dir: string; msg: any });

  test('every row observed live is in the scrubbed 1.0.77 capture, as that wire shape', () => {
    const engineFrames = frames()
      .filter(({ dir }) => dir === 'E->C')
      .map(({ msg }) => msg);
    const seen = (row: (typeof ENGINE_EXTENSION_BINDINGS)[number]) =>
      engineFrames.some((msg) => {
        const { wire } = row;
        if (wire.kind === 'notification')
          return msg.method === wire.method && msg.id === undefined;
        if (wire.kind === 'session-update-kind')
          return (
            msg.method === wire.method &&
            msg.params?.update?.sessionUpdate === wire.sessionUpdate
          );
        return false;
      });
    const live = ENGINE_EXTENSION_BINDINGS.filter(
      ({ observed }) => observed.variant === 'grok-1.0.77',
    );
    expect(live.map(({ id }) => id)).toEqual([
      'grok.session-setup',
      'grok.mcp-server-status',
      'grok.session-interjection',
      'grok.task-backgrounded',
      'grok.task-completed',
      'grok.monitor-event',
      'grok.background-tasks',
      'grok.subagent-spawned',
      'grok.subagent-progress',
      'grok.subagent-finished',
      'grok.queue-changed',
      'grok.turn-completed',
    ]);
    expect(live.filter((row) => !seen(row)).map(({ id }) => id)).toEqual([]);
  });

  test('every Grok row is keyed by the grok-build handshake, never declared', () => {
    const grok = ENGINE_EXTENSION_BINDINGS.filter(({ id }) =>
      id.startsWith('grok.'),
    );
    expect(grok.length).toBeGreaterThan(0);
    for (const row of grok) {
      expect(row.basis).toBe('undeclared-engine');
      expect(row.pending).toBeUndefined();
      expect(row.observed.variant).toBe('grok-1.0.77');
    }
  });

  test('the capture holds no home directory, real id or private name', () => {
    const capture = readFileSync(
      new URL(`../../${GROK_LIVE_CAPTURE}`, import.meta.url),
      'utf8',
    );
    expect(capture).not.toMatch(/\/Users\//);
    // Every UUID is a fixture placeholder (`00000000-0000-4000-8000-…`).
    const uuids = capture.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    );
    expect(uuids?.length).toBeGreaterThan(0);
    expect(
      uuids?.filter((id) => !id.startsWith('00000000-0000-4000-8000-')),
    ).toEqual([]);
    expect(capture).not.toMatch(/"signature": "(?!<redacted>)/);
  });
});
