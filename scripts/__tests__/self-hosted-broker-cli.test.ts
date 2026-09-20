import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../lib/owned-process.mjs';

describe('self-hosted broker CLI', () => {
  test('publishes one private bundle and reuses it on an exact init retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-broker-cli-'));
    const configPath = join(root, 'config.json');
    const credentialsPath = join(root, 'credentials.json');
    const databasePath = join(root, 'broker.sqlite');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 'station-self-hosted-broker/v1',
        databasePath,
        credentialsPath,
        port: 0,
        provision: [
          {
            stationId: 'station-12345678',
            enrollmentId: 'enroll-12345678',
            routingGeneration: 1,
            browserOrigin: 'http://localhost:4173',
          },
        ],
      }),
      { mode: 0o600 },
    );
    const run = () =>
      execFileSync(
        resolve('node_modules/.bin/tsx'),
        ['scripts/self-hosted-broker.ts', 'init', configPath],
        {
          cwd: resolve(import.meta.dirname, '../..'),
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 64 * 1024,
        },
      );
    try {
      run();
      const first = readFileSync(credentialsPath, 'utf8');
      run();
      expect(readFileSync(credentialsPath, 'utf8')).toBe(first);
      const db = new DatabaseSync(databasePath, { readOnly: true });
      expect(
        (
          db.prepare('SELECT count(*) count FROM broker_leases').get() as {
            count: number;
          }
        ).count,
      ).toBe(1);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('starts, stops, and restarts a loopback ephemeral listener', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-broker-serve-'));
    const configPath = join(root, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 'station-self-hosted-broker/v1',
        databasePath: join(root, 'broker.sqlite'),
        credentialsPath: join(root, 'unused.json'),
        port: 0,
        provision: [],
      }),
      { mode: 0o600 },
    );
    const launch = async () => {
      const execution = executeOwnedCommand(
        resolve('node_modules/.bin/tsx'),
        ['scripts/self-hosted-broker.ts', 'serve', configPath],
        spawn,
        'self-hosted broker CLI test',
        {
          cwd: resolve(import.meta.dirname, '../..'),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const capture = captureOwnedProcessOutput(execution, {
        maxBytes: 16 * 1024,
      });
      if (!('stdout' in execution.child))
        throw new Error('broker child did not expose bounded output');
      const child = execution.child;
      let observed = '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const address = await Promise.race([
          new Promise<{ port: number }>((resolveReady, reject) => {
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (text: string) => {
              observed += text;
              if (Buffer.byteLength(observed) > 16 * 1024)
                return reject(
                  new Error('broker readiness output exceeded bound'),
                );
              const line = observed
                .split('\n')
                .find((value) =>
                  value.startsWith('STATION_SELF_HOSTED_BROKER '),
                );
              if (line)
                resolveReady(
                  JSON.parse(line.slice('STATION_SELF_HOSTED_BROKER '.length)),
                );
            });
            execution.completion.then((result) =>
              reject(
                new Error(`broker exited before ready (${result.status})`),
              ),
            );
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('broker readiness exceeded bound')),
              10_000,
            );
          }),
        ]);
        const response = await fetch(
          `http://127.0.0.1:${address.port}/broker/v1/connections`,
          {
            method: 'OPTIONS',
            headers: {
              origin: 'https://unknown.example',
              'access-control-request-method': 'POST',
              'access-control-request-headers':
                'Authorization, Content-Type, X-Broker-Credential-Id',
            },
            signal: AbortSignal.timeout(5000),
          },
        );
        expect(response.status).toBe(401);
      } finally {
        clearTimeout(timer);
        const stopped = await terminateSuiteExecution(execution, {
          waitForSuiteSettlement,
          terminationGraceMs: 2000,
          terminationForceMs: 3000,
          processLabel: 'self-hosted broker CLI test',
        });
        const output = capture.finish();
        expect(output.truncated).toBe(false);
        expect(stopped.settled).toBe(true);
        expect(stopped.errors).toEqual([]);
      }
    };
    try {
      await launch();
      await launch();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('a credential publication failure does not create broker state', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-broker-fault-'));
    try {
      const databasePath = join(root, 'broker.sqlite');
      const credentialsPath = join(root, 'credentials');
      mkdirSync(credentialsPath, { mode: 0o700 });
      const configPath = join(root, 'config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 'station-self-hosted-broker/v1',
          databasePath,
          credentialsPath,
          port: 0,
          provision: [
            {
              stationId: 'station-12345678',
              enrollmentId: 'enroll-12345678',
              routingGeneration: 1,
              browserOrigin: 'http://localhost:4173',
            },
          ],
        }),
        { mode: 0o600 },
      );
      expect(() =>
        execFileSync(
          resolve('node_modules/.bin/tsx'),
          ['scripts/self-hosted-broker.ts', 'init', configPath],
          {
            cwd: resolve(import.meta.dirname, '../..'),
            windowsHide: true,
            timeout: 10_000,
            maxBuffer: 64 * 1024,
            stdio: 'pipe',
          },
        ),
      ).toThrow();
      expect(existsSync(databasePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
