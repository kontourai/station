/**
 * @vitest-environment jsdom
 *
 * station#3658 delta review MEDIUM-2 — the identity the SSE stream and the
 * historical read reconcile on.
 */
import { describe, expect, test } from 'vitest';
import { monitoringEventIdentity } from '../contexts/MonitoringContext';

const toolEvent = (overrides: Record<string, unknown>) =>
  ({
    timestamp: '2026-08-21T10:00:00.000Z',
    'timestamp.ms': 1_787_000_000_000,
    'trace.id': 'trace-1',
    'gen_ai.operation.name': 'execute_tool',
    'span.kind': 'end',
    ...overrides,
  }) as never;

describe('monitoringEventIdentity', () => {
  test('the emitter-supplied event id wins when there is one', () => {
    expect(
      monitoringEventIdentity(
        toolEvent({ 'station.agent_telemetry.event_id': 'evt-42' }),
      ),
    ).toBe('evt-42');
  });

  /*
   * `MonitoringEmitter.base()` stamps `Date.now()` and attaches no event id,
   * so two tool calls on one trace inside the same millisecond used to share
   * an identity — and a snapshot containing only the first then confirmed
   * (and erased) both.
   */
  test('two tool events in the same millisecond on the same trace are distinct', () => {
    const first = toolEvent({
      'gen_ai.tool.name': 'read_file',
      'gen_ai.tool.call.id': 'call-1',
    });
    const second = toolEvent({
      'gen_ai.tool.name': 'write_file',
      'gen_ai.tool.call.id': 'call-2',
    });

    expect(monitoringEventIdentity(first)).not.toBe(
      monitoringEventIdentity(second),
    );
  });

  /*
   * Delta2 review, MEDIUM-2 reopened. The identity was a 32-bit FNV-1a digest
   * of the canonical form, and a 32-bit digest used as an EQUALITY key claims
   * two payloads are the same event when all that matched is four bytes. The
   * review's probe found this exact pair; under the digest they shared an
   * identity, so a snapshot containing one confirmed and erased the other.
   */
  test("the reviewer's FNV-1a collision pair are still two events", () => {
    const first = toolEvent({
      'gen_ai.tool.call.result': 'payload-v3xik8-s20',
    });
    const second = toolEvent({
      'gen_ai.tool.call.result': 'payload-kjjohx-160e',
    });

    expect(monitoringEventIdentity(first)).not.toBe(
      monitoringEventIdentity(second),
    );
  });

  test('two events differing only in a nested payload are distinct', () => {
    const first = toolEvent({ 'gen_ai.tool.call.result': { ok: true } });
    const second = toolEvent({ 'gen_ai.tool.call.result': { ok: false } });

    expect(monitoringEventIdentity(first)).not.toBe(
      monitoringEventIdentity(second),
    );
  });

  /*
   * The SSE copy and the persisted copy are the SAME redacted object
   * (`MonitoringEmitter.emit`), but the persisted one comes back through a
   * JSON round-trip. Key order must not change the answer, or the merge would
   * stop recognising an event as already present and show it twice.
   */
  test('key order does not change the identity', () => {
    const live = toolEvent({
      'gen_ai.tool.name': 'read_file',
      'station.artifacts': [{ type: 'file', name: 'a.txt' }],
    });
    const roundTripped = JSON.parse(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(live as Record<string, unknown>).reverse(),
        ),
      ),
    );

    expect(monitoringEventIdentity(roundTripped)).toBe(
      monitoringEventIdentity(live),
    );
  });

  test('the same event is stable across repeated calls', () => {
    const event = toolEvent({ 'gen_ai.tool.name': 'read_file' });
    expect(monitoringEventIdentity(event)).toBe(monitoringEventIdentity(event));
  });
});
