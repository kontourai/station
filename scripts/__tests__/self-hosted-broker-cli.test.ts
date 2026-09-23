import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { SelfHostedBrokerService } from '../../src-server/services/connections/self-hosted-broker-service.js';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../lib/owned-process.mjs';

test.runIf(process.platform === 'win32')(
  'Windows CLI refuses before creating state or a listener',
  () => {
    expect(() =>
      execFileSync(
        resolve('node_modules/.bin/tsx'),
        ['scripts/self-hosted-broker.ts', 'serve', 'C:\\does-not-exist.json'],
        {
          cwd: resolve(import.meta.dirname, '../..'),
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          stdio: 'pipe',
        },
      ),
    ).toThrow(/self_hosted_broker_private_custody_unavailable_on_windows/);
  },
);
describe.runIf(process.platform !== 'win32')('self-hosted broker CLI', () => {
  test('issues a private one-time invitation and lists/revokes one client grant', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-broker-invite-cli-'));
    const configPath = join(root, 'config.json');
    const databasePath = join(root, 'broker.sqlite');
    const credentialsPath = join(root, 'credentials.json');
    const requestPath = join(root, 'request.json');
    const invitationPath = join(root, 'invitation.json');
    const exactScope = {
      stationId: 'station-12345678',
      enrollmentId: 'enroll-12345678',
      routingGeneration: 1,
      browserOrigin: 'http://localhost:4173',
    };
    const clientOrigin = 'http://localhost:4174';
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 'station-self-hosted-broker/v1',
        databasePath,
        credentialsPath,
        port: 0,
        provision: [exactScope],
      }),
      { mode: 0o600 },
    );
    const run = (mode: string, ...args: string[]) =>
      execFileSync(
        resolve('node_modules/.bin/tsx'),
        ['scripts/self-hosted-broker.ts', mode, configPath, ...args],
        {
          cwd: resolve(import.meta.dirname, '../..'),
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          encoding: 'utf8',
        },
      );
    try {
      run('init');
      writeFileSync(
        requestPath,
        JSON.stringify({
          version: 'station-broker-invitation-request/v1',
          brokerOrigin: 'http://localhost:4312',
          clientOrigin,
          stationSigningKeyId: 'K'.repeat(43),
          stationSigningGeneration: 2,
        }),
        { mode: 0o600 },
      );
      const output = run('invite', requestPath, invitationPath);
      const delivery = JSON.parse(readFileSync(invitationPath, 'utf8')) as {
        version: string;
        link: string;
        invitation: {
          invitationId: string;
          invitationSecret: string;
          scope: typeof exactScope;
        };
      };
      const invitation = delivery.invitation;
      expect(output).toContain('STATION_BROKER_INVITATION_WRITTEN');
      expect(output).not.toContain(invitation.invitationSecret);
      expect(statSync(invitationPath).mode & 0o077).toBe(0);
      expect(invitation.scope).toEqual({
        ...exactScope,
        browserOrigin: clientOrigin,
      });
      expect(delivery.version).toBe('station-broker-invitation-delivery/v1');
      const link = new URL(delivery.link);
      expect(link.origin).toBe(clientOrigin);
      expect(link.pathname).toBe('/connections/computers');
      expect(link.search).toBe('');
      expect(link.hash).toMatch(/^#relay-invite=/);
      expect(
        JSON.parse(
          Buffer.from(
            link.hash.slice('#relay-invite='.length),
            'base64url',
          ).toString('utf8'),
        ),
      ).toEqual(invitation);
      expect(() => run('invite', requestPath, invitationPath)).toThrow();
      const service = new SelfHostedBrokerService(databasePath);
      const grant = service.redeemInvitation(
        invitation as Parameters<typeof service.redeemInvitation>[0],
        clientOrigin,
      );
      service.close();
      const inventory = run('grants');
      expect(inventory).toContain(grant.credential.id);
      expect(inventory).toContain(invitation.invitationId);
      expect(inventory).not.toContain(grant.credential.secret);
      expect(run('revoke', grant.credential.id)).toContain(
        'STATION_BROKER_GRANT_REVOKED',
      );
      const reopened = new SelfHostedBrokerService(databasePath);
      expect(() => reopened.status(invitation.scope, grant.credential)).toThrow(
        'broker_credential_refused',
      );
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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
  test('malformed private credentials expose neither their canary nor database errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-broker-malformed-'));
    try {
      const databasePath = join(root, 'broker.sqlite');
      const credentialsPath = join(root, 'credentials.json');
      const configPath = join(root, 'config.json');
      writeFileSync(credentialsPath, '{"canary":"BROKER_SECRET_CANARY', {
        mode: 0o600,
      });
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
      const result = spawnSync(
        resolve('node_modules/.bin/tsx'),
        ['scripts/self-hosted-broker.ts', 'init', configPath],
        {
          cwd: resolve(import.meta.dirname, '../..'),
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          encoding: 'utf8',
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('self_hosted_broker_refused');
      expect(result.stderr).not.toContain('BROKER_SECRET_CANARY');
      expect(existsSync(databasePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('a bind conflict leaves the unrelated listener alive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-broker-listener-'));
    const listener = createServer((_request, response) =>
      response.end('unrelated'),
    );
    try {
      listener.listen(0, '127.0.0.1');
      await once(listener, 'listening');
      const address = listener.address();
      if (!address || typeof address === 'string')
        throw new Error('missing listener address');
      const configPath = join(root, 'config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 'station-self-hosted-broker/v1',
          databasePath: join(root, 'broker.sqlite'),
          credentialsPath: join(root, 'unused.json'),
          port: address.port,
          provision: [],
        }),
        { mode: 0o600 },
      );
      expect(() =>
        execFileSync(
          resolve('node_modules/.bin/tsx'),
          ['scripts/self-hosted-broker.ts', 'serve', configPath],
          {
            cwd: resolve(import.meta.dirname, '../..'),
            windowsHide: true,
            timeout: 10_000,
            maxBuffer: 64 * 1024,
            stdio: 'pipe',
          },
        ),
      ).toThrow();
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(await response.text()).toBe('unrelated');
    } finally {
      listener.closeAllConnections();
      if (listener.listening)
        await new Promise<void>((resolveClose) =>
          listener.close(() => resolveClose()),
        );
      rmSync(root, { recursive: true, force: true });
    }
  });
});
