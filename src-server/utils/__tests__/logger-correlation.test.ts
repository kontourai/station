// @vitest-environment node

/**
 * archive#1897 logging slice 3 — proves two things a mocked assertion
 * cannot: (1) `LOG_BINDING_KEYS` is not a re-declared copy of
 * `monitoring-keys.ts`'s `K` (a hardcoded literal that happens to match
 * today would silently drift tomorrow), and (2) a `logger.child()` bound
 * with these keys is actually retrievable through the REAL
 * `ServerLogReader` read path by the value it was bound with, with the
 * binding field intact and redaction untouched.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { K } from '../../../src-shared/monitoring-keys.js';
import { createServerLogReader } from '../../services/infra/server-log-reader.js';
import {
  installServerLogSink,
  resetServerLogSinkForTests,
} from '../../services/infra/server-log-store.js';
import { createLogger } from '../logger.js';
import {
  LOG_BINDING_KEYS,
  SCHEDULER_LOG_BINDING_KEYS,
  schedulerJobCorrelationBindings,
  sessionCorrelationBindings,
} from '../logger-correlation.js';

const dirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-log-correlation-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  resetServerLogSinkForTests();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('LOG_BINDING_KEYS — alignment with monitoring-keys.ts (AC1)', () => {
  it('reuses the EXACT monitoring-keys K values, never a re-declared/drifted copy', () => {
    expect(LOG_BINDING_KEYS.CONVERSATION_ID).toBe(K.CONVERSATION_ID);
    expect(LOG_BINDING_KEYS.AGENT_SLUG).toBe(K.AGENT_SLUG);
    expect(LOG_BINDING_KEYS.USER_ID).toBe(K.USER_ID);
    // Concretely, the OTel GenAI semantic-convention strings themselves —
    // pinned so a change to EITHER module is visible here, not just a
    // reference-equality check between two copies of the same mistake.
    expect(LOG_BINDING_KEYS.CONVERSATION_ID).toBe('gen_ai.conversation.id');
    expect(LOG_BINDING_KEYS.AGENT_SLUG).toBe('station.agent.slug');
    expect(LOG_BINDING_KEYS.USER_ID).toBe('station.user.id');
  });
});

describe('sessionCorrelationBindings', () => {
  it('always includes conversationId; omits agentSlug/userId when unknown rather than binding "undefined"', () => {
    const minimal = sessionCorrelationBindings({ conversationId: 'conv-1' });
    expect(minimal).toEqual({ [K.CONVERSATION_ID]: 'conv-1' });
    expect(Object.keys(minimal)).toEqual([K.CONVERSATION_ID]);

    const full = sessionCorrelationBindings({
      conversationId: 'conv-2',
      agentSlug: 'station',
      userId: 'user-1',
    });
    expect(full).toEqual({
      [K.CONVERSATION_ID]: 'conv-2',
      [K.AGENT_SLUG]: 'station',
      [K.USER_ID]: 'user-1',
    });
  });
});

describe('logger.child correlation — real read-path proof (AC3)', () => {
  it('a conversation-bound child logger write is retrievable via ServerLogReader q=<conversationId>, with the binding field intact and secrets redacted', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'correlation-test', level: 'info' });

    const conversationId = 'conv-e2e-c9f1a2b3';
    const child = logger.child(
      sessionCorrelationBindings({
        conversationId,
        agentSlug: 'station',
        userId: 'brian',
      }),
    );
    child.info('Turn dispatched', { apiKey: 'sk-should-be-redacted' });

    // pino's multistream tee is async-ish; give the event loop a turn so
    // the store tee's write has actually landed (same pattern as
    // logger.test.ts).
    await new Promise((resolve) => setImmediate(resolve));

    const reader = createServerLogReader({ directory });
    const result = await reader.query({ q: conversationId });

    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry.msg).toBe('Turn dispatched');
    expect(entry[LOG_BINDING_KEYS.CONVERSATION_ID]).toBe(conversationId);
    expect(entry[LOG_BINDING_KEYS.AGENT_SLUG]).toBe('station');
    expect(entry[LOG_BINDING_KEYS.USER_ID]).toBe('brian');
    // Default (remote) read path still redacts: the secret is on disk so a
    // local operator can see it, but `query()` without `redact: false`
    // never returns it.
    expect(entry.apiKey).toBe('[REDACTED]');
  });

  it('a query for a DIFFERENT conversationId does not surface this entry — the bound value actually scopes the match', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'correlation-test', level: 'info' });

    const child = logger.child(
      sessionCorrelationBindings({ conversationId: 'conv-aaaa' }),
    );
    child.info('Turn dispatched for conv-aaaa');
    await new Promise((resolve) => setImmediate(resolve));

    const reader = createServerLogReader({ directory });
    const result = await reader.query({ q: 'conv-bbbb' });
    expect(result.entries).toHaveLength(0);
  });
});

describe('schedulerJobCorrelationBindings', () => {
  it('binds the station-local job-run identity keys (not a monitoring-keys concept — no scheduler-run key exists there)', () => {
    const bindings = schedulerJobCorrelationBindings({
      jobName: 'nightly-digest',
      jobRunId: 'nightly-digest-1735689600000',
    });
    expect(bindings).toEqual({
      [SCHEDULER_LOG_BINDING_KEYS.JOB_NAME]: 'nightly-digest',
      [SCHEDULER_LOG_BINDING_KEYS.JOB_RUN_ID]: 'nightly-digest-1735689600000',
    });
  });

  it('a job-run-bound child logger write is retrievable via ServerLogReader q=<jobRunId>', async () => {
    const directory = createTempDir();
    installServerLogSink({ directory });
    const logger = createLogger({ name: 'scheduler-test', level: 'info' });

    const jobRunId = 'nightly-digest-1735689600000';
    const child = logger.child(
      schedulerJobCorrelationBindings({ jobName: 'nightly-digest', jobRunId }),
    );
    child.info('Scheduler job started', { manual: false });
    await new Promise((resolve) => setImmediate(resolve));

    const reader = createServerLogReader({ directory });
    const result = await reader.query({ q: jobRunId });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0][SCHEDULER_LOG_BINDING_KEYS.JOB_NAME]).toBe(
      'nightly-digest',
    );
    expect(result.entries[0][SCHEDULER_LOG_BINDING_KEYS.JOB_RUN_ID]).toBe(
      jobRunId,
    );
  });
});

describe('disclosed redaction asymmetry (review round, station#1897)', () => {
  // The log side pattern-redacts every string VALUE (the monitoring side does
  // not), so a secret-shaped binding value over-redacts and degrades the
  // cross-surface join for that line. This is a deliberate trade-off — we do
  // not weaken redaction for hypothetical future id shapes — and this test
  // pins it so a change in either direction is a conscious decision.
  it('a secret-shaped binding value reads back [REDACTED] on the default (remote) read path', async () => {
    const { createLogger } = await import('../logger.js');
    const { installServerLogSink, resetServerLogSinkForTests } = await import(
      '../../services/infra/server-log-store.js'
    );
    const { createServerLogReader } = await import(
      '../../services/infra/server-log-reader.js'
    );
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { LOG_BINDING_KEYS } = await import('../logger-correlation.js');

    const dir = mkdtempSync(join(tmpdir(), 'log-corr-redact-'));
    installServerLogSink({ directory: dir });
    try {
      const logger = createLogger({
        name: 'redaction-asymmetry',
        level: 'info',
      });
      const secretShapedId = 'sk-abcdefghijklmnopqrstuvwxyz012345';
      const child = logger.child({
        [LOG_BINDING_KEYS.CONVERSATION_ID]: secretShapedId,
      });
      child.info('line with a secret-shaped binding value');

      const reader = createServerLogReader({ directory: dir });
      const bySecret = await reader.query({ q: secretShapedId });
      expect(bySecret.entries).toHaveLength(0);
      const all = await reader.query({});
      const entry = all.entries.find(
        (candidate) =>
          candidate.msg === 'line with a secret-shaped binding value',
      );
      expect(entry).toBeDefined();
      expect(entry?.[LOG_BINDING_KEYS.CONVERSATION_ID]).toBe('[REDACTED]');
    } finally {
      resetServerLogSinkForTests();
    }
  });
});
