import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { describe, expect, test, vi } from 'vitest';
import {
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../../../scripts/lib/owned-process.mjs';
import {
  buildOpenSshWorkerProbeArgs,
  createSystemOpenSshWorkerProbeRunner,
} from '../openssh-worker-probe.js';

const INPUT = {
  alias: 'brian-media',
  controlPath: '/private/control.sock',
  remoteProjectPath: '~/dev/github/kontourai/station',
  remotePort: 3141,
};

const RESULT = {
  protocolVersion: 1,
  nodeVersion: 'v24.18.0',
  platform: 'linux',
  arch: 'x64',
  remoteHome: '/home/brian',
  remoteProjectPath: '/home/brian/dev/github/kontourai/station',
  environmentId: '11111111-1111-4111-8111-111111111111',
  instanceId: 'brian-media-dogfood',
  sha: 'a'.repeat(40),
  bootId: '22222222-2222-4222-8222-222222222222',
};

describe('OpenSSH remote worker probe', () => {
  test('uses fixed argv and a base64url protocol payload', () => {
    const args = buildOpenSshWorkerProbeArgs(INPUT);
    expect(args).toEqual(
      expect.arrayContaining([
        '-S',
        '/private/control.sock',
        'ForwardAgent=no',
        'PermitLocalCommand=no',
        '--',
        'brian-media',
        'node',
        '-',
      ]),
    );
    expect(args.join(' ')).not.toContain(INPUT.remoteProjectPath);
    const payload = JSON.parse(
      Buffer.from(args.at(-1) ?? '', 'base64url').toString('utf8'),
    );
    expect(payload).toEqual({
      protocolVersion: 1,
      remoteProjectPath: INPUT.remoteProjectPath,
      remotePort: 3141,
    });
    expect(args.at(-1)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('streams a static worker over stdin and validates its response', async () => {
    const runProcess = vi.fn(async ({ args, stdin }) => {
      expect(args).toEqual(buildOpenSshWorkerProbeArgs(INPUT));
      expect(stdin).toContain(
        "fetch(base + '/.well-known/station/v1', options)",
      );
      expect(stdin).toContain('remoteHome: os.homedir()');
      expect(stdin).not.toContain("fetch(base + '/.well-known/station')\n");
      expect(stdin).not.toContain(INPUT.remoteProjectPath);
      return { stdout: JSON.stringify(RESULT), stderr: '', exitCode: 0 };
    });
    const run = createSystemOpenSshWorkerProbeRunner(runProcess);
    await expect(run(INPUT)).resolves.toEqual(RESULT);
    expect(runProcess).toHaveBeenCalledOnce();
  });

  test('surfaces only the bounded worker reason on remote failure', async () => {
    const run = createSystemOpenSshWorkerProbeRunner(async () => ({
      stdout: '',
      stderr: JSON.stringify({
        protocolVersion: 1,
        error: 'project-unavailable',
        path: '/private/remote/path',
      }),
      exitCode: 1,
    }));
    await expect(run(INPUT)).rejects.toThrow(
      'Remote Station worker failed: project-unavailable',
    );
  });

  test('rejects oversized or control-bearing remote identity fields', async () => {
    const oversized = createSystemOpenSshWorkerProbeRunner(async () => ({
      stdout: JSON.stringify({ ...RESULT, environmentId: 'x'.repeat(257) }),
      stderr: '',
      exitCode: 0,
    }));
    await expect(oversized(INPUT)).rejects.toThrow('incompatible');

    const controlBearing = createSystemOpenSshWorkerProbeRunner(async () => ({
      stdout: JSON.stringify({ ...RESULT, instanceId: 'remote\nspoofed' }),
      stderr: '',
      exitCode: 0,
    }));
    await expect(controlBearing(INPUT)).rejects.toThrow('incompatible');
  });

  test('rejects unsafe project path input before process launch', async () => {
    const runProcess = vi.fn();
    const run = createSystemOpenSshWorkerProbeRunner(runProcess);
    await expect(
      run({ ...INPUT, remoteProjectPath: '/tmp/project\nProxyCommand bad' }),
    ).rejects.toThrow('Remote project path is invalid');
    expect(runProcess).not.toHaveBeenCalled();
  });
});

describe('remote worker listener identity', () => {
  test.each(['direct', '/.well-known/station/v1', '/api/system/identity'])(
    'executes the shipped worker against %s responses',
    async (redirectPath) => {
      let redirectedRequests = 0;
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.searchParams.has('redirected')) redirectedRequests += 1;
        if (
          url.pathname === redirectPath &&
          !url.searchParams.has('redirected')
        ) {
          response.writeHead(302, { location: `${url.pathname}?redirected=1` });
          response.end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify(
            url.pathname === '/.well-known/station/v1'
              ? { environmentId: RESULT.environmentId }
              : {
                  instanceId: RESULT.instanceId,
                  sha: RESULT.sha,
                  bootId: RESULT.bootId,
                },
          ),
        );
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Missing fixture listener');
        const run = createSystemOpenSshWorkerProbeRunner(
          async ({ args, stdin }) => {
            // Execute exactly the program and payload sent through SSH, replacing
            // only the SSH transport with a local child for this listener test.
            const execution = executeOwnedProcess(
              process.execPath,
              ['-', args.at(-1) ?? ''],
              spawn,
              'Station identity worker fixture',
              { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
            );
            let stdout = '';
            let stderr = '';
            execution.child.stdout?.on('data', (chunk) => {
              stdout += chunk.toString();
            });
            execution.child.stderr?.on('data', (chunk) => {
              stderr += chunk.toString();
            });
            execution.child.stdin?.end(stdin);
            try {
              if (!(await waitForSuiteSettlement(execution, 5000)))
                throw new Error('Worker fixture timed out');
              const result = await execution.completion;
              return { stdout, stderr, exitCode: result.status ?? 1 };
            } finally {
              const cleanup = await terminateSuiteExecution(execution, {
                processLabel: 'Station identity worker fixture',
                waitForSuiteSettlement,
                terminationGraceMs: 1000,
                terminationForceMs: 1000,
              });
              expect(cleanup).toMatchObject({ settled: true, errors: [] });
            }
          },
        );
        const result = run({
          ...INPUT,
          remoteProjectPath: tmpdir(),
          remotePort: address.port,
        });
        if (redirectPath === 'direct') {
          await expect(result).resolves.toMatchObject({
            environmentId: RESULT.environmentId,
            instanceId: RESULT.instanceId,
            sha: RESULT.sha,
            bootId: RESULT.bootId,
          });
        } else {
          await expect(result).rejects.toThrow('station-unavailable');
        }
        expect(redirectedRequests).toBe(0);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
