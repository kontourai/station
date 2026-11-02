import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  admitTroubleshootSeed,
  boundedTriageLogTail,
  createTriageRunDirectory,
  MAX_TRIAGE_CONTEXT_BYTES,
  MAX_TRIAGE_DOCTOR_CHECKS,
  MAX_TRIAGE_LOG_TAIL_LENGTH,
  MAX_TRIAGE_TEXT_LENGTH,
  MAX_TROUBLESHOOT_SEED_ERROR_LENGTH,
  MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH,
  redactTroubleshootReportText,
  serializeTriageContext,
  summarizeTriageDoctor,
  TROUBLESHOOT_CONTEXT_SCHEMA,
  type TroubleshootContext,
  TroubleshootSeedError,
  validateTroubleshootContext,
} from '../triage-context.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-triage-context-'));
  roots.push(root);
  return root;
}

const GITHUB_TOKEN = `ghp_${'a'.repeat(36)}`;
// The shape of a Station pairing/device credential: 32 bytes, base64url.
const PAIRING_CREDENTIAL = 'Qm9vdHN0cmFwU2VjcmV0MTIzNDU2Nzg5MGFiY2RlZmdo';

describe('redactTroubleshootReportText', () => {
  test('redacts credentials, pairing secrets, private URLs and home paths', () => {
    const text = [
      `token ${GITHUB_TOKEN}`,
      `pair with ${PAIRING_CREDENTIAL}`,
      'open http://192.168.1.20:3141/#bootstrap=abc',
      'see https://github.com/kontourai/station/issues/4470',
      'log at /Users/alice/Library/Logs/station.log',
      'and /home/bob/.station/config/app.json',
      'and C:\\Users\\carol\\AppData\\station',
      'commit 0123456789abcdef0123456789abcdef01234567',
      'run 4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a',
      'file src-server/tools/station-control-troubleshoot-tools.ts',
    ].join('\n');
    const redacted = redactTroubleshootReportText(text);
    expect(redacted).not.toContain(GITHUB_TOKEN);
    expect(redacted).not.toContain(PAIRING_CREDENTIAL);
    expect(redacted).not.toContain('192.168.1.20');
    expect(redacted).not.toContain('alice');
    expect(redacted).not.toContain('bob');
    expect(redacted).not.toContain('carol');
    expect(redacted).toContain('[REDACTED_URL]');
    expect(redacted).toContain('~/Library/Logs/station.log');
    // Public links, commit SHAs, run ids and repo paths stay readable.
    expect(redacted).toContain(
      'https://github.com/kontourai/station/issues/4470',
    );
    expect(redacted).toContain('0123456789abcdef0123456789abcdef01234567');
    expect(redacted).toContain('4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a');
    expect(redacted).toContain(
      'src-server/tools/station-control-troubleshoot-tools.ts',
    );
  });
});

describe('troubleshoot seed admission', () => {
  test('accepts a route at its limit and refuses one character more', () => {
    const atLimit = `/${'r'.repeat(MAX_TROUBLESHOOT_SEED_ROUTE_LENGTH - 1)}`;
    expect(admitTroubleshootSeed({ route: atLimit }).route).toBe(
      atLimit.slice(1),
    );
    expect(() => admitTroubleshootSeed({ route: `${atLimit}r` })).toThrow(
      TroubleshootSeedError,
    );
  });

  test('accepts an error summary at its limit and refuses one character more', () => {
    const atLimit = 'e'.repeat(MAX_TROUBLESHOOT_SEED_ERROR_LENGTH);
    expect(
      admitTroubleshootSeed({ errorSummary: atLimit }).errorSummary,
    ).toHaveLength(MAX_TROUBLESHOOT_SEED_ERROR_LENGTH);
    expect(() =>
      admitTroubleshootSeed({ errorSummary: `${atLimit}e` }),
    ).toThrow(TroubleshootSeedError);
  });

  test('refuses a route that is not an in-app path and strips query and fragment', () => {
    expect(() =>
      admitTroubleshootSeed({ route: 'https://evil.example/x' }),
    ).toThrow(TroubleshootSeedError);
    expect(() => admitTroubleshootSeed({ route: '//evil.example' })).toThrow(
      TroubleshootSeedError,
    );
    expect(
      admitTroubleshootSeed({ route: '/settings?token=abc#frag' }).route,
    ).toBe('settings');
    expect(admitTroubleshootSeed({ route: '/' }).route).toBe('');
  });

  test('redacts secrets and paths from an error summary', () => {
    const seed = admitTroubleshootSeed({
      errorSummary: `failed with ${GITHUB_TOKEN} at /Users/alice/x.ts:1:2`,
    });
    expect(seed.errorSummary).not.toContain(GITHUB_TOKEN);
    expect(seed.errorSummary).not.toContain('alice');
  });
});

describe('bounded summaries', () => {
  test('caps doctor checks and per-field text', () => {
    const summary = summarizeTriageDoctor({
      checks: Array.from({ length: MAX_TRIAGE_DOCTOR_CHECKS + 1 }, () => ({
        label: 'x',
        status: 'warn',
        detail: 'd'.repeat(MAX_TRIAGE_TEXT_LENGTH + 1),
      })),
    });
    expect(summary.checks).toHaveLength(MAX_TRIAGE_DOCTOR_CHECKS);
    expect(summary.checks[0]!.detail.length).toBeLessThanOrEqual(
      MAX_TRIAGE_TEXT_LENGTH,
    );
  });

  test('keeps the newest end of an over-limit log tail', () => {
    const tail = boundedTriageLogTail(
      `${'o'.repeat(MAX_TRIAGE_LOG_TAIL_LENGTH + 1)}NEWEST`,
    );
    expect(tail.length).toBeLessThanOrEqual(MAX_TRIAGE_LOG_TAIL_LENGTH);
    expect(tail.startsWith('…[TRUNCATED]')).toBe(true);
    expect(tail.endsWith('NEWEST')).toBe(true);
  });

  test('refuses to serialize a context over the byte limit', () => {
    expect(() =>
      // redactDeep caps each string, so the overflow comes from many fields.
      serializeTriageContext({
        blobs: Array.from({ length: 40 }, () => 'x'.repeat(3_000)),
      }),
    ).toThrow('byte limit');
    expect(serializeTriageContext({ ok: true })).toContain('"ok": true');
  });
});

function context(): TroubleshootContext {
  return {
    schema: TROUBLESHOOT_CONTEXT_SCHEMA,
    schemaVersion: 1,
    generatedAt: '2026-11-02T00:00:00.000Z',
    runId: '4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a',
    station: {
      name: 'test',
      environmentId: null,
      version: '0.1.0',
      channel: 'development',
      sourceRevision: null,
      builtAt: null,
      platform: 'darwin',
      nodeVersion: 'v24.0.0',
    },
    caller: { role: 'owner', surface: 'web' },
    doctor: { status: 'unavailable', reason: 'not collected' },
    logs: {
      serverLogStore: 'unavailable',
      agentRead: 'requires-operator-grant',
    },
    seed: { route: null, errorSummary: null },
    limits: {
      contextBytes: MAX_TRIAGE_CONTEXT_BYTES,
      doctorChecks: MAX_TRIAGE_DOCTOR_CHECKS,
      textLength: MAX_TRIAGE_TEXT_LENGTH,
    },
  };
}

describe('validateTroubleshootContext', () => {
  test('accepts schema v1 and refuses extra keys, bad roles and long fields', () => {
    expect(() => validateTroubleshootContext(context())).not.toThrow();
    expect(() =>
      validateTroubleshootContext({ ...context(), extra: 1 } as never),
    ).toThrow('schema v1');
    expect(() =>
      validateTroubleshootContext({
        ...context(),
        caller: { role: 'admin', surface: 'web' },
      } as never),
    ).toThrow('invalid bounded values');
    expect(() =>
      validateTroubleshootContext({
        ...context(),
        station: {
          ...context().station,
          name: 'n'.repeat(MAX_TRIAGE_TEXT_LENGTH + 1),
        },
      }),
    ).toThrow('invalid bounded values');
  });
});

describe('createTriageRunDirectory', () => {
  test('creates an owner-only run under an explicit Station root and refuses a cache symlink', () => {
    const root = tempRoot();
    const runDir = createTriageRunDirectory(
      '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b',
      root,
    );
    expect(existsSync(runDir)).toBe(true);
    expect(() =>
      createTriageRunDirectory('5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b', root),
    ).toThrow('reuse');

    const other = tempRoot();
    const outside = tempRoot();
    symlinkSync(outside, join(other, 'cache'));
    expect(() =>
      createTriageRunDirectory('6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c', other),
    ).toThrow('real directory');
    expect(readdirSync(outside)).toEqual([]);
  });
});
