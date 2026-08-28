/**
 * archive#3078 — ingested tool INPUTS were declared by the schema and
 * discarded by the mapping, so an externally-ingested agent's tool arguments
 * were absent rather than redacted-but-present, and a reader could not tell
 * "this tool takes no arguments" from "we threw them away".
 *
 * This receiver had no test coverage at all before this file.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { K } from '../../../src-shared/monitoring-keys.js';
import { RuntimeEventLog } from '../../runtime/conversation/runtime-event-log.js';
import { MonitoringEmitter } from '../emitter.js';
import { createOtlpReceiverRoutes } from '../otlp-receiver.js';

const ingestEvent = (tool: Record<string, unknown>) => ({
  schema_version: '1.0',
  event_id: 'e1',
  session_id: 's1',
  timestamp: '2026-08-17T00:00:00.000Z',
  event_type: 'tool.invoke',
  agent: { name: 'ingested-agent', runtime: 'external', version: '1.0.0' },
  tool,
});

const STATION_USER = 'station-owner';

describe('OTLP agent-event ingest', () => {
  test('keeps the tool input the schema declares (#3078)', async () => {
    const emitted: Record<string, unknown>[] = [];
    const app = createOtlpReceiverRoutes(
      (event) => {
        emitted.push(event as unknown as Record<string, unknown>);
      },
      () => STATION_USER,
    );

    const response = await app.request('/v1/agent-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        ingestEvent({ name: 'shell', input: { command: 'ls -la' } }),
      ),
    });

    expect(response.status).toBe(200);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.[K.TOOL_NAME]).toBe('shell');
    expect(emitted[0]?.[K.TOOL_CALL_ARGS]).toEqual({ command: 'ls -la' });
  });

  test('omits the input key when the sender supplied none', async () => {
    // Absent stays absent — the distinction the fix exists to preserve.
    const emitted: Record<string, unknown>[] = [];
    const app = createOtlpReceiverRoutes(
      (event) => {
        emitted.push(event as unknown as Record<string, unknown>);
      },
      () => STATION_USER,
    );

    await app.request('/v1/agent-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ingestEvent({ name: 'shell' })),
    });

    expect(K.TOOL_CALL_ARGS in emitted[0]!).toBe(false);
  });
});

/**
 * archive#3130. These assert the field is on the row a READER gets back, not
 * merely on the object handed to the emitter: `queryEvents` is the predicate
 * that made 12,366 of the owner's 12,367 `execute_tool` rows invisible, and a
 * test that stops at the emitter cannot see it.
 */
describe('ingested events carry the user the monitoring read scopes by', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  const readBackIngestedToolEvent = async (
    resolveUserId: () => string | undefined,
  ) => {
    const root = await mkdtemp(join(tmpdir(), 'station-otlp-ingest-'));
    roots.push(root);
    const eventLog = new RuntimeEventLog(join(root, 'monitoring'), {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    const persisted: Record<string, unknown>[] = [];
    const emitter = new MonitoringEmitter(new EventEmitter(), (event) => {
      persisted.push(event as unknown as Record<string, unknown>);
      return eventLog.persist(event);
    });
    const app = createOtlpReceiverRoutes(
      (event) => emitter.emitRaw(event),
      resolveUserId,
    );

    // `persist` names the file by TODAY, and `queryEvents` filters on the
    // event's own timestamp, so the ingested timestamp must fall in the window.
    const timestamp = new Date().toISOString();
    const response = await app.request('/v1/agent-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...ingestEvent({ name: 'shell', input: { command: 'ls' } }),
        timestamp,
      }),
    });
    expect(response.status).toBe(200);
    await emitter.flush();

    return {
      persisted,
      rows: await eventLog.queryEvents(0, Date.now() + 60_000, STATION_USER),
    };
  };

  test('an ingested tool event is returned by the per-user event query', async () => {
    const { rows } = await readBackIngestedToolEvent(() => STATION_USER);

    expect(rows).toHaveLength(1);
    expect(rows[0][K.OP_NAME]).toBe('execute_tool');
    expect(rows[0][K.TOOL_NAME]).toBe('shell');
    expect(rows[0][K.USER_ID]).toBe(STATION_USER);
  });

  test('no id is written down when the instance cannot resolve one', async () => {
    // `''` is not an id (archive#3086): an unattributed row stays honestly
    // unattributed rather than gaining an empty string that reads as a value
    // and matches nobody's query anyway.
    const { persisted, rows } = await readBackIngestedToolEvent(
      () => undefined,
    );

    expect(persisted).toHaveLength(1);
    expect(K.USER_ID in persisted[0]!).toBe(false);
    expect(rows).toHaveLength(0);
  });

  test('an OTLP span keeps the user its producer reported', async () => {
    // The producer observed it; this instance's own account must not overwrite
    // it just because both paths now stamp one.
    const emitted: Record<string, unknown>[] = [];
    const app = createOtlpReceiverRoutes(
      (event) => {
        emitted.push(event as unknown as Record<string, unknown>);
      },
      () => STATION_USER,
    );

    await app.request('/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 't1',
                    spanId: 's1',
                    name: 'execute_tool',
                    kind: 1,
                    startTimeUnixNano: '1',
                    attributes: [
                      {
                        key: K.OP_NAME,
                        value: { stringValue: 'execute_tool' },
                      },
                      {
                        key: K.USER_ID,
                        value: { stringValue: 'reported-by-producer' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });

    expect(emitted[0]?.[K.USER_ID]).toBe('reported-by-producer');
  });
});
