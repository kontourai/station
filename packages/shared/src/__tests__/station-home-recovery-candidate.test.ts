import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stageStationHomeRecoveryCandidate } from '../station-home-archive.js';
import {
  ensureStationHomeSchemaSync,
  STATION_HOME_SCHEMA_FILE,
} from '../station-home-schema.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-offline-recovery-'));
  roots.push(root);
  return { root, outputDir: join(root, 'candidate') };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function stage(records: Array<{ store: string; json: string }>) {
  const f = fixture();
  const plan = stageStationHomeRecoveryCandidate({
    declaredSourceSchemaVersion: 1,
    records,
    outputDir: f.outputDir,
  });
  return { ...f, plan };
}

describe('StationHomeArchive detached recovery candidate', () => {
  it('preserves the entire ambiguous Agent privately and cannot boot as an active home', () => {
    const original =
      '{ "id":"private-agent", "prompt":"private instructions", "execution": {"agentConnectionId":"ambiguous-runtime", "credentialProfileRef":"private-account", "runtimeOptions":{"secret":"private-value"}} }\n';
    const { outputDir, plan } = stage([{ store: 'agent', json: original }]);
    expect(plan).toMatchObject({
      publishable: false,
      declaredSourceSchemaVersion: 1,
      snapshotAuthority: 'not-established',
      activeRecordsEmitted: 0,
    });
    expect(plan.records[0]).toMatchObject({
      disposition: 'inert-agent',
      evidenceRetained: true,
      observations: {
        engineBinding: 'explicit-engine',
        credentialBinding: 'explicit-profile',
      },
    });
    expect(plan.records[0].codes).toContain('owner-engine-mapping-required');
    expect(readdirSync(outputDir).sort()).toEqual([
      'inert-evidence',
      'recovery-candidate.json',
    ]);
    const payloadPath = join(
      outputDir,
      'inert-evidence',
      `${plan.records[0].reference}.payload`,
    );
    expect(readFileSync(payloadPath, 'utf8')).toBe(original);
    expect(plan.records[0].sha256).toBe(
      createHash('sha256').update(original).digest('hex'),
    );
    for (const value of [
      'private-agent',
      'private instructions',
      'ambiguous-runtime',
      'private-account',
      'private-value',
    ])
      expect(JSON.stringify(plan)).not.toContain(value);
    expect(
      JSON.parse(
        readFileSync(join(outputDir, 'recovery-candidate.json'), 'utf8'),
      ),
    ).toEqual(plan);
    if (process.platform !== 'win32') {
      expect(lstatSync(outputDir).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(outputDir, 'inert-evidence')).mode & 0o777).toBe(
        0o700,
      );
      expect(lstatSync(payloadPath).mode & 0o777).toBe(0o600);
    }
    expect(() => ensureStationHomeSchemaSync(outputDir)).toThrow(
      /STATION_HOME_RESET_REQUIRED/,
    );
    expect(existsSync(join(outputDir, STATION_HOME_SCHEMA_FILE))).toBe(false);
    expect(readFileSync(payloadPath, 'utf8')).toBe(original);
  });

  it.each([
    [{}, 'absent-station-default', 'absent'],
    [
      { agentConnectionId: 'engine', credentialProfileRef: null },
      'explicit-engine',
      'explicit-default',
    ],
    [
      { agentConnectionId: null, credentialProfileRef: 12 },
      'invalid',
      'invalid',
    ],
  ])(
    'distinguishes exact Agent binding states without manufacturing execution',
    (execution, engineBinding, credentialBinding) => {
      const original = JSON.stringify({ execution });
      const { outputDir, plan } = stage([{ store: 'agent', json: original }]);
      expect(plan.records[0].observations).toEqual({
        engineBinding,
        credentialBinding,
      });
      expect(plan.activeRecordsEmitted).toBe(0);
      expect(
        readFileSync(
          join(outputDir, 'inert-evidence', 'record-0001.payload'),
          'utf8',
        ),
      ).toBe(original);
    },
  );

  it('observes absent optional execution without inventing a malformed Agent', () => {
    const { plan } = stage([
      { store: 'agent', json: '{"id":"original-agent"}' },
    ]);
    expect(plan.records[0].observations).toEqual({
      engineBinding: 'absent-station-default',
      credentialBinding: 'absent',
    });
    expect(plan.records[0].codes).not.toContain('invalid-shape');
    expect(plan.activeRecordsEmitted).toBe(0);
  });

  it.each([
    [{}, 'absent-unselected'],
    [{ builtinAgentEngineConnectionId: null }, 'explicit-station'],
    [{ builtinAgentEngineConnectionId: 'external-id' }, 'explicit-engine'],
    [{ builtinAgentEngineConnectionId: false }, 'invalid'],
  ])(
    'retains absent/null/explicit built-in choice as an observation',
    (app, builtinSelection) => {
      const { plan } = stage([{ store: 'app', json: JSON.stringify(app) }]);
      expect(plan.records[0].observations.builtinSelection).toBe(
        builtinSelection,
      );
      expect(plan.publishable).toBe(false);
    },
  );

  it('separates historical bytes, project/default authority, grants and excluded credentials', () => {
    const history = JSON.stringify([
      {
        id: 'old-id',
        projectId: 'old-project',
        agentSlug: 'old-agent',
        title: 'private-title',
        providerId: 'old-provider',
      },
    ]);
    const { outputDir, plan } = stage([
      { store: 'conversation-history', json: history },
      {
        store: 'project',
        json: '{"defaultEnvironment":"private-env","defaultProviderId":"old-provider"}',
      },
      {
        store: 'authority',
        json: '{"resume_cursor":"private-cursor","grant":"old-authority"}',
      },
      { store: 'credential-payload', json: 'secret-do-not-copy' },
    ]);
    expect(plan.records.map((r) => r.disposition)).toEqual([
      'historical-evidence-only',
      'inert-project-bindings',
      'inert-authority',
      'excluded-credential-payload',
    ]);
    expect(
      readFileSync(
        join(outputDir, 'inert-evidence', 'record-0001.payload'),
        'utf8',
      ),
    ).toBe(history);
    expect(readdirSync(join(outputDir, 'inert-evidence')).sort()).toEqual([
      'record-0001.payload',
      'record-0002.payload',
      'record-0003.payload',
    ]);
    expect(JSON.stringify(plan)).not.toMatch(
      /private-|old-provider|secret-do-not-copy/,
    );
    expect(plan.requiredDecisions).toContain(
      'offline-capture-and-owner-exclusion',
    );
  });

  it('retains unknown/malformed records inertly and never prints their errors or store names', () => {
    const { outputDir, plan } = stage([
      { store: '../secret-store', json: '{"private-value":true}' },
      { store: 'agent', json: 'invalid-private-json' },
      { store: 'engine-registry', json: '{"version":2}' },
    ]);
    expect(plan.records[0]).toMatchObject({
      store: 'unknown',
      disposition: 'unclassified-evidence',
      codes: ['unknown-store'],
    });
    expect(plan.records[1].codes).toEqual(['invalid-json']);
    expect(plan.records[2].codes).toContain('invalid-shape');
    expect(plan.publishable).toBe(false);
    expect(JSON.stringify(plan)).not.toMatch(
      /secret-store|private-value|invalid-private/,
    );
    expect(readdirSync(join(outputDir, 'inert-evidence'))).toHaveLength(3);
  });

  it('does not rewrite conflicting registry identifiers or infer runtime suffix aliases', () => {
    const original =
      '{"version":1,"engineConnections":[{"id":"same","runtimeConnectionId":"same-runtime"},{"id":"same-runtime","runtimeConnectionId":"same"}]}';
    const { outputDir, plan } = stage([
      { store: 'engine-registry', json: original },
    ]);
    expect(plan.records[0].codes).toContain('owner-engine-mapping-required');
    expect(
      readFileSync(
        join(outputDir, 'inert-evidence', 'record-0001.payload'),
        'utf8',
      ),
    ).toBe(original);
    expect(existsSync(join(outputDir, 'config'))).toBe(false);
  });

  it('snapshots all input bytes before staging callbacks can mutate caller records', () => {
    const f = fixture();
    const records = [
      {
        store: 'agent',
        json: '{"execution":{"agentConnectionId":"original"}}',
      },
    ];
    const original = records[0].json;
    stageStationHomeRecoveryCandidate({
      ...f,
      declaredSourceSchemaVersion: 1,
      records,
      beforeStageCommit: () => {
        records[0].json = '{"execution":{}}';
      },
    });
    expect(
      readFileSync(
        join(f.outputDir, 'inert-evidence', 'record-0001.payload'),
        'utf8',
      ),
    ).toBe(original);
  });

  it.each(['fault', 'active-marker', 'tamper'] as const)(
    'never commits an incomplete or executable staging tree: %s',
    (fault) => {
      const f = fixture();
      expect(() =>
        stageStationHomeRecoveryCandidate({
          ...f,
          declaredSourceSchemaVersion: 1,
          records: [{ store: 'agent', json: '{"execution":{}}' }],
          beforeStageCommit: () => {
            if (fault === 'fault') throw new Error('secret-parser-detail');
            const stageName = readdirSync(f.root).find((name) =>
              name.startsWith('.station-recovery-candidate-'),
            )!;
            const stageDir = join(f.root, stageName);
            if (fault === 'active-marker')
              writeFileSync(
                join(stageDir, STATION_HOME_SCHEMA_FILE),
                '{"version":2}',
              );
            else
              writeFileSync(
                join(stageDir, 'inert-evidence', 'record-0001.payload'),
                '{"execution":{"agentConnectionId":"changed"}}',
              );
          },
        }),
      ).toThrow('detached recovery staging is unavailable');
      expect(readdirSync(f.root)).toEqual([]);
    },
  );

  it('preserves a destination created during staging and cleans only its own stage', () => {
    const f = fixture();
    expect(() =>
      stageStationHomeRecoveryCandidate({
        ...f,
        declaredSourceSchemaVersion: 1,
        records: [{ store: 'app', json: '{}' }],
        beforeStageCommit: () => {
          mkdirSync(f.outputDir);
          writeFileSync(join(f.outputDir, 'owner-file'), 'retain');
        },
      }),
    ).toThrow();
    expect(readFileSync(join(f.outputDir, 'owner-file'), 'utf8')).toBe(
      'retain',
    );
    expect(readdirSync(f.root)).toEqual(['candidate']);
  });

  it('relinquishes the old staging name after rename even if post-commit work fails', () => {
    const f = fixture();
    let oldStage = '';
    expect(() =>
      stageStationHomeRecoveryCandidate({
        ...f,
        declaredSourceSchemaVersion: 1,
        records: [{ store: 'app', json: '{}' }],
        beforeStageCommit: () => {
          oldStage = join(
            f.root,
            readdirSync(f.root).find((name) =>
              name.startsWith('.station-recovery-candidate-'),
            )!,
          );
        },
        afterStageCommit: () => {
          mkdirSync(oldStage);
          writeFileSync(join(oldStage, 'new-owner'), 'must-retain');
          throw new Error('post-rename fixture fault');
        },
      }),
    ).toThrow('inert output may remain');
    expect(readFileSync(join(oldStage, 'new-owner'), 'utf8')).toBe(
      'must-retain',
    );
    expect(
      JSON.parse(
        readFileSync(join(f.outputDir, 'recovery-candidate.json'), 'utf8'),
      ).publishable,
    ).toBe(false);
  });

  it('rejects extra keys before requesting descriptors and refuses symbols or accessors', () => {
    const f = fixture();
    let descriptorReads = 0;
    const extra = new Proxy(
      {
        store: 'app',
        json: '{}',
        ...Object.fromEntries(
          Array.from({ length: 1000 }, (_, index) => [`extra-${index}`, true]),
        ),
      },
      {
        getOwnPropertyDescriptor(target, key) {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    expect(() =>
      stageStationHomeRecoveryCandidate({
        ...f,
        declaredSourceSchemaVersion: 1,
        records: [extra],
      }),
    ).toThrow('Detached recovery records');
    expect(descriptorReads).toBe(0);
    let getterReads = 0;
    const accessor = {
      store: 'app',
      get json() {
        getterReads += 1;
        return '{}';
      },
    };
    for (const entry of [
      accessor,
      { store: 'app', json: '{}', [Symbol('private')]: 'never-read' },
    ]) {
      expect(() =>
        stageStationHomeRecoveryCandidate({
          ...f,
          declaredSourceSchemaVersion: 1,
          records: [entry],
        }),
      ).toThrow('Detached recovery records');
    }
    expect(getterReads).toBe(0);
    expect(readdirSync(f.root)).toEqual([]);
  });

  it.each([0xd800, 0xdbff, 0xdc00, 0xdfff])(
    'rejects unpaired UTF-16 source text before lossy UTF-8 encoding: %i',
    (unit) => {
      const f = fixture();
      const json = `{"value":"${String.fromCharCode(unit)}"}`;
      expect(() =>
        stageStationHomeRecoveryCandidate({
          ...f,
          declaredSourceSchemaVersion: 1,
          records: [{ store: 'app', json }],
        }),
      ).toThrow('Detached recovery records');
      expect(readdirSync(f.root)).toEqual([]);
    },
  );

  it.each(['{"value":"\\ud800"}', '{"value":"\\udfff"}', '{"value":"😀"}'])(
    'preserves ASCII JSON surrogate escapes and valid paired text byte-exactly',
    (json) => {
      const { outputDir, plan } = stage([{ store: 'app', json }]);
      expect(
        readFileSync(join(outputDir, 'inert-evidence', 'record-0001.payload')),
      ).toEqual(Buffer.from(json));
      expect(plan.records[0].sha256).toBe(
        createHash('sha256').update(Buffer.from(json)).digest('hex'),
      );
    },
  );

  it('refuses an existing destination or symlinked output parent', () => {
    const f = fixture();
    mkdirSync(f.outputDir);
    const records = [{ store: 'app', json: '{}' }];
    expect(() =>
      stageStationHomeRecoveryCandidate({
        ...f,
        declaredSourceSchemaVersion: 1,
        records,
      }),
    ).toThrow();
    const link = join(f.root, 'alias');
    symlinkSync(
      f.outputDir,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() =>
      stageStationHomeRecoveryCandidate({
        outputDir: join(link, 'candidate'),
        declaredSourceSchemaVersion: 1,
        records,
      }),
    ).toThrow();
    expect(readdirSync(f.outputDir)).toEqual([]);
  });

  it('refuses count, UTF-8 byte, total-byte and declared-version bounds before creating output', () => {
    const f = fixture();
    for (const records of [
      [],
      Array.from({ length: 129 }, () => ({ store: 'app', json: '{}' })),
      [{ store: 'app', json: 'é'.repeat(140000) }],
      Array.from({ length: 17 }, () => ({
        store: 'unknown',
        json: 'x'.repeat(256 * 1024),
      })),
    ]) {
      expect(() =>
        stageStationHomeRecoveryCandidate({
          ...f,
          declaredSourceSchemaVersion: 1,
          records,
        }),
      ).toThrow('Detached recovery records');
      expect(readdirSync(f.root)).toEqual([]);
    }
    expect(() =>
      stageStationHomeRecoveryCandidate({
        ...f,
        declaredSourceSchemaVersion: 2 as 1,
        records: [{ store: 'app', json: '{}' }],
      }),
    ).toThrow();
  });
});
