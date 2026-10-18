/**
 * #2494: the delegation receipt's `confinement` is read back from the
 * session's events (`readSession`, oldest first). A session restarted under
 * the same thread has one `session.started` per process; the receipt must
 * describe the process now running, the latest. The route suite
 * (`approval-confinement.routes.test.ts`) owns the wiring into the receipt.
 */
import { describe, expect, test } from 'vitest';
import { startedSessionConfinement } from '../station-control-delegation.js';

const record = (posture: string) => ({
  level: posture === 'confined' ? 'os-profile' : 'host',
  required: false,
  posture,
  ...(posture === 'confined' ? { mechanism: 'codex-sandbox' } : {}),
  workspaceAccess: 'mounted',
  policyBasis: 'workspace-floor',
});

describe('startedSessionConfinement', () => {
  test('reads the latest session.started, not the first', () => {
    const events = [
      {
        method: 'session.started',
        metadata: { stationConfinementRecord: record('confined') },
      },
      { method: 'turn.started', metadata: {} },
      {
        method: 'session.started',
        metadata: { stationConfinementRecord: record('no-mechanism') },
      },
      { method: 'session.configured', metadata: {} },
    ];
    expect(startedSessionConfinement(events)).toEqual(record('no-mechanism'));
  });

  test('a latest start that recorded nothing claims nothing, even when an earlier one did', () => {
    expect(
      startedSessionConfinement([
        {
          method: 'session.started',
          metadata: { stationConfinementRecord: record('confined') },
        },
        { method: 'session.started', metadata: {} },
      ]),
    ).toBeUndefined();
  });
});
