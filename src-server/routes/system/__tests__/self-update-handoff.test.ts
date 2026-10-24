// @vitest-environment node
/**
 * The generation a supervised in-app update leaves serving resolves the
 * durable restart record from the handoff outcome its supervisor reports,
 * driven here through a real SupervisorLink over a fake IPC channel.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  installListenerLink,
  SupervisorLink,
} from '../../../runtime/bootstrap/supervisor-link.js';

vi.mock('../install-provenance.js', () => ({
  resolveInstallProvenance: vi.fn(),
}));

const { resolveInstallProvenance } = await import('../install-provenance.js');
const { installSupervisedRestartResolver } = await import(
  '../self-update-handoff.js'
);
const {
  readSelfUpdateRestartRecord,
  restartStateFilePath,
  writeSelfUpdateRestartRecord,
} = await import('../self-update-restart-state.js');

const NEW_SHA = 'c'.repeat(40);

class SupervisorChannel extends EventEmitter {
  readonly env: NodeJS.ProcessEnv = { STATION_SUPERVISOR_IPC: '1' };
  connected = true;
  exit = vi.fn();
  send = (
    _message: unknown,
    _handle?: unknown,
    _options?: undefined,
    callback?: (error: Error | null) => void,
  ) => {
    callback?.(null);
    return true;
  };
  deliver(message: unknown): void {
    this.emit('message', message, undefined);
  }
}

let gitRoot: string;
let channel: SupervisorChannel;
let stopListening: () => void = () => {};

beforeEach(async () => {
  gitRoot = mkdtempSync(join(tmpdir(), 'self-update-handoff-'));
  vi.mocked(resolveInstallProvenance).mockReturnValue({
    installKind: 'source-checkout',
    gitRoot,
    branch: 'main',
    sha: NEW_SHA,
  });
  writeSelfUpdateRestartRecord(restartStateFilePath(gitRoot), {
    instanceId: 'work',
    hash: NEW_SHA.slice(0, 7),
    pid: 0,
    port: 3191,
    startedAt: '2026-10-24T12:00:00.000Z',
    status: 'pending',
  });
  channel = new SupervisorChannel();
  const link = new SupervisorLink({ process: channel, log: () => {} });
  const parked = link.park();
  channel.deliver({ type: 'promote', listeners: [] });
  await parked;
  installListenerLink(link);
});

afterEach(() => {
  stopListening();
  installListenerLink(null);
  rmSync(gitRoot, { recursive: true, force: true });
});

function listen(sha: string): void {
  stopListening = installSupervisedRestartResolver(
    '/checkout/dist-server-work',
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    { STATION_INSTANCE_ID: 'work', STATION_BUILD_SHA: sha },
  );
}

function record() {
  return readSelfUpdateRestartRecord(restartStateFilePath(gitRoot));
}

describe('installSupervisedRestartResolver', () => {
  test('verifies a committed handoff into the build the update produced', () => {
    listen(NEW_SHA);
    channel.deliver({
      type: 'handoff.outcome',
      requestId: 'update-1',
      outcome: 'committed',
      generation: 2,
    });
    expect(record()).toMatchObject({
      status: 'verified',
      hash: NEW_SHA.slice(0, 7),
      pid: process.pid,
    });
  });

  test('fails a committed handoff that serves another build', () => {
    listen('d'.repeat(40));
    channel.deliver({
      type: 'handoff.outcome',
      requestId: 'update-1',
      outcome: 'committed',
      generation: 2,
    });
    expect(record()).toMatchObject({
      status: 'failed',
      failureCode: 'identity-mismatch',
    });
  });

  test('fails a rolled-back handoff', () => {
    listen(NEW_SHA);
    channel.deliver({
      type: 'handoff.outcome',
      requestId: 'update-1',
      outcome: 'rolled-back',
      reason: 'trial-readiness-timeout',
      generation: 3,
    });
    expect(record()).toMatchObject({
      status: 'failed',
      failureCode: 'handoff-rolled-back',
    });
  });

  test('leaves the record alone for a handoff nobody in the core asked for', () => {
    listen(NEW_SHA);
    channel.deliver({
      type: 'handoff.outcome',
      requestId: null,
      outcome: 'committed',
      generation: 2,
    });
    expect(record()).toMatchObject({ status: 'pending', pid: 0 });
  });
});
