import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server, Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreePort } from '../lib/free-ports.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const STARTUP_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 1_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const REBIND_TIMEOUT_MS = 5_000;
const REBIND_RETRY_INTERVAL_MS = 50;
const OUTPUT_TAIL_LENGTH = 8_000;
const MAX_STARTUP_ATTEMPTS = 5;

type ProbeOutcome =
  | 'reachable'
  | 'refused'
  | 'timeout'
  | 'unreachable'
  | 'error';
type ProbeResult = { address: string; outcome: ProbeOutcome };
type ProbePreflight = {
  controlPort: number;
  probes: ProbeResult[];
  probativeAddresses: string[];
};
type StartupAttempt = { port: number; status: 'collision' | 'ready' };
type StartupObservation = 'pending' | 'collision' | 'ready';
type CleanupStep = { name: string; run: () => Promise<void> };
type CleanupResource = { name: string; steps: CleanupStep[] };
type ViteProcess = {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
};
type StartedVite = ViteProcess & {
  attempts: StartupAttempt[];
  httpStatus: number;
  port: number;
};

const ANSI_ESCAPE_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI starts with ESC.
  /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

function advertisedLoopbackPorts(output: string): number[] {
  const plainOutput = output.replace(ANSI_ESCAPE_PATTERN, '');
  const advertisedUrls = [...plainOutput.matchAll(/\bLocal:\s+(\S+)/g)].map(
    (match) => match[1],
  );

  return advertisedUrls.map((advertisedUrl) => {
    let url: URL;
    try {
      url = new URL(advertisedUrl);
    } catch {
      throw new Error(`Vite advertised an invalid Local URL: ${advertisedUrl}`);
    }

    const port = Number(url.port);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    ) {
      throw new Error(
        `Vite must advertise an exact IPv4 loopback URL with an assigned port; received: ${advertisedUrl}`,
      );
    }

    return port;
  });
}

function classifyStartupOutput(
  output: string,
  exited: boolean,
  expectedPort: number,
): StartupObservation {
  const advertisedPorts = advertisedLoopbackPorts(output);
  if (advertisedPorts.some((port) => port !== expectedPort)) {
    throw new Error(
      `Vite advertised unexpected loopback port(s) ${advertisedPorts.join(',')}; expected ${expectedPort}`,
    );
  }

  if (exited) {
    if (advertisedPorts.length > 0) {
      throw new Error(
        `npm run dev:ui exited after advertising 127.0.0.1:${expectedPort}; this is not a retryable collision`,
      );
    }
    const plainOutput = output.replace(ANSI_ESCAPE_PATTERN, '');
    const exactCollision = new RegExp(
      `(?:^|\\n)Error: Port ${expectedPort} is already in use(?:\\r?\\n|$)`,
    ).test(plainOutput);
    if (exactCollision) return 'collision';
    throw new Error(
      `npm run dev:ui exited without an exact expected-port Vite collision signature\n${outputTail(output)}`,
    );
  }

  return advertisedPorts.length > 0 ? 'ready' : 'pending';
}

function nonLoopbackIpv4Addresses(): string[] {
  return [
    ...new Set(
      Object.values(networkInterfaces())
        .flatMap((addresses) => addresses ?? [])
        .filter((address) => address.family === 'IPv4' && !address.internal)
        .map((address) => address.address),
    ),
  ].sort();
}

function outputTail(value: string): string {
  return value.slice(-OUTPUT_TAIL_LENGTH);
}

async function connect(address: string, port: number): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const socket: Socket = new Socket();
    let settled = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };

    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => finish('reachable'));
    socket.once('timeout', () => finish('timeout'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') {
        finish('refused');
        return;
      }
      if (
        error.code === 'EHOSTUNREACH' ||
        error.code === 'ENETUNREACH' ||
        error.code === 'EADDRNOTAVAIL'
      ) {
        finish('unreachable');
        return;
      }
      finish('error');
    });
    socket.connect(port, address);
  });
}

async function waitForAdvertisedPort(
  child: ChildProcessWithoutNullStreams,
  expectedPort: number,
  output: () => string,
): Promise<'collision' | 'ready'> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const observation = classifyStartupOutput(
      output(),
      child.exitCode !== null,
      expectedPort,
    );
    if (observation !== 'pending') return observation;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Timed out waiting for npm run dev:ui to advertise 127.0.0.1:${expectedPort}\n${outputTail(output())}`,
  );
}

async function waitForHttp(
  child: ChildProcessWithoutNullStreams,
  port: number,
  output: () => string,
): Promise<number> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = 'no response received';

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `npm run dev:ui exited before HTTP readiness with code ${child.exitCode}\n${outputTail(output())}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
      await response.arrayBuffer();
      return response.status;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(
    `Timed out waiting for npm run dev:ui on its advertised port 127.0.0.1:${port}: ${lastError}\n${outputTail(output())}`,
  );
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ]);
}

async function stopProcessTree(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // The process tree already exited.
    }
    if (!(await waitForExit(child, SHUTDOWN_TIMEOUT_MS))) {
      throw new Error(`Process tree ${child.pid} did not exit after taskkill`);
    }
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // The process tree already exited.
    }
  }
  if (await waitForExit(child, SHUTDOWN_TIMEOUT_MS)) return;

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process tree already exited.
    }
  }
  if (!(await waitForExit(child, SHUTDOWN_TIMEOUT_MS))) {
    throw new Error(`Process tree ${child.pid} did not exit after SIGKILL`);
  }
}

async function provePortCanRebind(
  port: number,
  host = '127.0.0.1',
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(port, host, () => server.close(resolve));
  });
}

async function provePortCanRebindEventually(
  port: number,
  host = '127.0.0.1',
  timeoutMs = REBIND_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await provePortCanRebind(port, host);
      return;
    } catch (error) {
      const socketError = error as NodeJS.ErrnoException;
      if (socketError.code !== 'EADDRINUSE' || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(REBIND_RETRY_INTERVAL_MS, deadline - Date.now()),
        ),
      );
      if (Date.now() >= deadline) throw error;
    }
  }
}

function spawnVite(port: number): ViteProcess {
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(
    npmExecutable,
    ['run', 'dev:ui', '--', '--port', String(port), '--strictPort'],
    {
      cwd: REPO_ROOT,
      detached: process.platform !== 'win32',
      env: process.env,
      windowsHide: true,
      // .cmd files aren't directly executable at the Win32 CreateProcess
      // level (unlike POSIX, which just needs the executable bit) - Node's
      // own docs recommend shell:true for this, and spawning npm.cmd
      // without it throws EINVAL.
      shell: process.platform === 'win32',
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('error', (error) => {
    stderr += `\nspawn error: ${error.message}`;
  });
  return {
    child,
    output: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
  };
}

async function startViteWithCollisionRetries(
  allocatePort: () => Promise<number>,
): Promise<StartedVite> {
  const attempts: StartupAttempt[] = [];
  const collisionDiagnostics: string[] = [];

  for (let attempt = 1; attempt <= MAX_STARTUP_ATTEMPTS; attempt += 1) {
    const port = await allocatePort();
    const vite = spawnVite(port);
    activeChild = vite.child;

    try {
      const status = await waitForAdvertisedPort(vite.child, port, vite.output);
      attempts.push({ port, status });
      if (status === 'collision') {
        collisionDiagnostics.push(
          `attempt ${attempt} port ${port}: ${outputTail(vite.output())}`,
        );
        await stopProcessTree(vite.child);
        activeChild = undefined;
        continue;
      }

      const httpStatus = await waitForHttp(vite.child, port, vite.output);
      return { ...vite, attempts, httpStatus, port };
    } catch (error) {
      try {
        await stopProcessTree(vite.child);
        activeChild = undefined;
      } catch (cleanupError) {
        throw new AggregateError(
          [asError(error), asError(cleanupError)],
          'Vite startup failed and process-tree cleanup also failed; startup failure is first',
        );
      }
      throw error;
    }
  }

  throw new Error(
    `npm run dev:ui exhausted ${MAX_STARTUP_ATTEMPTS} collision retries\n${collisionDiagnostics.join('\n')}`,
  );
}

async function occupyLoopbackPort(): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => socket.destroy());
  server.unref();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to occupy a deterministic loopback port'));
        return;
      }
      resolve(address.port);
    });
  });
  return { port, server };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function startWildcardControlListener(): Promise<{
  port: number;
  server: Server;
}> {
  const server = createServer((socket) => socket.destroy());
  server.unref();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to start wildcard control listener'));
        return;
      }
      resolve(address.port);
    });
  });
  return { port, server };
}

async function discoverProbativeAddresses(
  externalAddresses: string[],
): Promise<ProbePreflight> {
  const control = await startWildcardControlListener();
  let probes: ProbeResult[] = [];
  let probativeAddresses: string[] = [];
  let primaryError: unknown;
  try {
    probes = await Promise.all(
      externalAddresses.map(async (address) => ({
        address,
        outcome: await connect(address, control.port),
      })),
    );
    probativeAddresses = probes
      .filter(({ outcome }) => outcome === 'reachable')
      .map(({ address }) => address);
    if (probativeAddresses.length === 0) {
      throw new Error(
        `NOT_VERIFIED: no non-internal IPv4 address reached the explicit 0.0.0.0 control listener; outcomes=${probes.map(({ address, outcome }) => `${address}:${outcome}`).join(',')}`,
      );
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupStatus = 'failed';
  try {
    await finishWithGuaranteedCleanup(primaryError, [
      {
        name: 'wildcard-control-listener',
        steps: [
          { name: 'close-server', run: () => closeServer(control.server) },
          {
            name: 'rebind-wildcard-port',
            run: () => provePortCanRebind(control.port, '0.0.0.0'),
          },
        ],
      },
    ]);
    cleanupStatus = 'control-closed-and-wildcard-port-rebound';
  } finally {
    console.info(
      `[vite-loopback-control] wildcard=0.0.0.0:${control.port} external=${probes.map(({ address, outcome }) => `${address}:${outcome}`).join(',')} probative=${probativeAddresses.join(',') || 'none'} cleanup=${cleanupStatus}`,
    );
  }

  return { controlPort: control.port, probes, probativeAddresses };
}

function validStartupAttemptSequence(
  attempts: StartupAttempt[],
  firstCollisionPort: number,
  readyPort: number,
): boolean {
  if (
    attempts.length < 2 ||
    attempts.length > MAX_STARTUP_ATTEMPTS ||
    attempts[0]?.port !== firstCollisionPort ||
    attempts[0]?.status !== 'collision'
  ) {
    return false;
  }
  const finalAttempt = attempts.at(-1);
  if (finalAttempt?.port !== readyPort || finalAttempt.status !== 'ready') {
    return false;
  }
  return attempts.slice(0, -1).every(({ status }) => status === 'collision');
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function runCleanupResource(resource: CleanupResource): Promise<void> {
  const errors: Error[] = [];
  for (const step of resource.steps) {
    try {
      await step.run();
    } catch (error) {
      errors.push(
        new Error(`${resource.name}/${step.name}: ${asError(error).message}`, {
          cause: error,
        }),
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Cleanup failed for ${resource.name}`);
  }
}

async function finishWithGuaranteedCleanup(
  primaryError: unknown,
  resources: CleanupResource[],
): Promise<void> {
  const results = await Promise.allSettled(resources.map(runCleanupResource));
  const cleanupErrors = results.flatMap((result) =>
    result.status === 'rejected' ? [asError(result.reason)] : [],
  );

  if (primaryError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [asError(primaryError), ...cleanupErrors],
      'Test failed and cleanup also failed; primary failure is first',
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      'One or more cleanup resources failed',
    );
  }
}

let activeChild: ChildProcessWithoutNullStreams | undefined;

afterEach(async () => {
  if (activeChild) {
    await stopProcessTree(activeChild);
    activeChild = undefined;
  }
});

describe('root Vite development listener', () => {
  describe('advertised loopback port extraction', () => {
    it('extracts an assigned port from accumulated ANSI-colored Vite output', () => {
      const output =
        '\u001B[32m  ➜\u001B[39m  Local:   http://127.0.0.1:43127/\n';
      expect(advertisedLoopbackPorts(output)).toEqual([43127]);
    });

    it.each([
      'Local: http://localhost:43127/',
      'Local: http://0.0.0.0:43127/',
      'Local: http://127.0.0.1:0/',
      'Local: http://127.0.0.1:70000/',
      'Local: https://127.0.0.1:43127/',
      'Local: not-a-url',
    ])('rejects a non-loopback or invalid advertised URL: %s', (output) => {
      expect(() => advertisedLoopbackPorts(output)).toThrow(
        /Vite (must advertise|advertised an invalid)/,
      );
    });

    it('rejects any hostile Local advertisement before an exact collision can be retried', () => {
      const output = [
        'Local: http://127.0.0.1:43127/',
        'Local: http://0.0.0.0:43127/',
        'Error: Port 43127 is already in use',
      ].join('\n');
      expect(() => classifyStartupOutput(output, true, 43127)).toThrow(
        /exact IPv4 loopback URL/,
      );
    });

    it('rejects generic EADDRINUSE output without the exact expected-port Vite signature', () => {
      expect(() =>
        classifyStartupOutput(
          'Error: listen EADDRINUSE: address already in use 127.0.0.1:43127',
          true,
          43127,
        ),
      ).toThrow(/without an exact expected-port Vite collision signature/);
    });
  });

  describe('retry and cleanup seams', () => {
    it('accepts multiple collisions before the final ready attempt', () => {
      expect(
        validStartupAttemptSequence(
          [
            { port: 41_001, status: 'collision' },
            { port: 41_002, status: 'collision' },
            { port: 41_003, status: 'collision' },
            { port: 41_004, status: 'ready' },
          ],
          41_001,
          41_004,
        ),
      ).toBe(true);
    });

    it('runs collision cleanup and preserves the primary error when ready cleanup fails', async () => {
      const events: string[] = [];
      const primaryError = new Error('primary security probe failure');
      const occupied = await occupyLoopbackPort();
      let caught: unknown;

      try {
        await finishWithGuaranteedCleanup(primaryError, [
          {
            name: 'ready-vite',
            steps: [
              {
                name: 'stop-process-tree',
                run: async () => {
                  events.push('ready-stop-attempted');
                  throw new Error('synthetic stop failure');
                },
              },
              {
                name: 'rebind-port',
                run: async () => {
                  events.push('ready-rebind-attempted');
                  throw new Error('synthetic rebind failure');
                },
              },
            ],
          },
          {
            name: 'collision-holder',
            steps: [
              {
                name: 'close-server',
                run: async () => {
                  events.push('collision-close-attempted');
                  await closeServer(occupied.server);
                },
              },
              {
                name: 'rebind-port',
                run: async () => {
                  events.push('collision-rebind-attempted');
                  await provePortCanRebind(occupied.port);
                },
              },
            ],
          },
        ]);
      } catch (error) {
        caught = error;
      }

      expect(events).toEqual(
        expect.arrayContaining([
          'ready-stop-attempted',
          'ready-rebind-attempted',
          'collision-close-attempted',
          'collision-rebind-attempted',
        ]),
      );
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors[0]).toBe(primaryError);
      const readyCleanupError = (caught as AggregateError)
        .errors[1] as AggregateError;
      expect(String(readyCleanupError)).toContain(
        'Cleanup failed for ready-vite',
      );
      expect(readyCleanupError.errors).toHaveLength(2);
      expect(readyCleanupError.errors.map(String)).toEqual([
        expect.stringContaining('synthetic stop failure'),
        expect.stringContaining('synthetic rebind failure'),
      ]);
      await provePortCanRebind(occupied.port);
    });

    it('waits for a recently stopped listener before proving its port can rebind', async () => {
      const occupied = await occupyLoopbackPort();
      const delayedClose = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          closeServer(occupied.server).then(resolve, reject);
        }, REBIND_RETRY_INTERVAL_MS * 2);
      });

      await Promise.all([
        provePortCanRebindEventually(occupied.port),
        delayedClose,
      ]);
      await provePortCanRebind(occupied.port);
    });

    it('fails a bounded rebind proof when the listener remains occupied', async () => {
      const occupied = await occupyLoopbackPort();
      try {
        await expect(
          provePortCanRebindEventually(
            occupied.port,
            '127.0.0.1',
            REBIND_RETRY_INTERVAL_MS * 2,
          ),
        ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      } finally {
        await closeServer(occupied.server);
      }
      await provePortCanRebind(occupied.port);
    });
  });

  it('retries a real EADDRINUSE collision, then binds dev:ui to IPv4 loopback only', async () => {
    const externalAddresses = nonLoopbackIpv4Addresses();
    if (externalAddresses.length === 0) {
      throw new Error(
        'NOT_VERIFIED: no non-internal IPv4 interface is available for the required exposure probe',
      );
    }
    const preflight = await discoverProbativeAddresses(externalAddresses);

    const occupied = await Promise.all([
      occupyLoopbackPort(),
      occupyLoopbackPort(),
    ]);
    let allocationCount = 0;
    const allocatePort = async () => {
      const occupiedPort = occupied[allocationCount]?.port;
      allocationCount += 1;
      return occupiedPort ?? findFreePort();
    };
    let started: StartedVite | undefined;
    let probes: ProbeResult[] = [];
    let devCsp = '';
    let devHtml = '';
    let primaryError: unknown;
    try {
      started = await startViteWithCollisionRetries(allocatePort);
      const response = await fetch(`http://127.0.0.1:${started.port}/`);
      devCsp = response.headers.get('content-security-policy') ?? '';
      devHtml = await response.text();
      probes = await Promise.all(
        externalAddresses.map(async (address) => ({
          address,
          outcome: await connect(address, started?.port ?? 0),
        })),
      );
    } catch (error) {
      primaryError = error;
    }

    const cleanupResources: CleanupResource[] = [
      ...(started
        ? [
            {
              name: 'ready-vite',
              steps: [
                {
                  name: 'stop-process-tree',
                  run: async () => {
                    await stopProcessTree(started.child);
                    activeChild = undefined;
                  },
                },
                {
                  name: 'rebind-port',
                  run: () => provePortCanRebindEventually(started.port),
                },
              ],
            },
          ]
        : []),
      ...occupied.map(({ port, server }, index) => ({
        name: `collision-holder-${index + 1}`,
        steps: [
          { name: 'close-server', run: () => closeServer(server) },
          { name: 'rebind-port', run: () => provePortCanRebind(port) },
        ],
      })),
    ];
    let cleanupStatus = 'failed';
    try {
      await finishWithGuaranteedCleanup(primaryError, cleanupResources);
      cleanupStatus = 'all-resources-released-and-ports-rebound';
    } finally {
      console.info(
        `[vite-loopback-proof] startup_attempts=${started?.attempts.map(({ port, status }) => `${port}:${status}`).join(',') ?? 'startup-failed'} advertised_loopback=127.0.0.1:${started?.port ?? 'not-advertised'} http_status=${started?.httpStatus ?? 'startup-failed'} control_probative=${preflight.probativeAddresses.join(',')} external=${probes
          .map(({ address, outcome }) => `${address}:${outcome}`)
          .join(',')} cleanup=${cleanupStatus}`,
      );
    }

    const attempts = started?.attempts ?? [];
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.length).toBeLessThanOrEqual(MAX_STARTUP_ATTEMPTS);
    expect(attempts[0]).toEqual({
      port: occupied[0]?.port,
      status: 'collision',
    });
    expect(attempts.at(-1)).toEqual({
      port: started?.port,
      status: 'ready',
    });
    expect(
      attempts.slice(1, -1).every(({ status }) => status === 'collision'),
    ).toBe(true);
    expect(
      attempts.slice(0, occupied.length).map(({ port, status }) => ({
        port,
        status,
      })),
    ).toEqual(
      occupied.map(({ port }) => ({ port, status: 'collision' as const })),
    );
    expect(
      validStartupAttemptSequence(
        attempts,
        occupied[0]?.port ?? 0,
        started?.port ?? 0,
      ),
    ).toBe(true);
    expect(started?.httpStatus).toBeGreaterThanOrEqual(200);
    const nonce = /'nonce-([^']+)'/.exec(devCsp)?.[1];
    expect(nonce).toBeTruthy();
    expect(devCsp).toContain("default-src 'none'");
    expect(devCsp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(devCsp).not.toContain("'unsafe-eval'");
    expect(devHtml).toContain(`nonce="${nonce ?? 'missing'}"`);
    const scriptTags = devHtml.match(/<script\b[^>]*>/g) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);
    expect(
      scriptTags.every((tag) => tag.includes(`nonce="${nonce ?? 'missing'}"`)),
    ).toBe(true);
    expect(devHtml).not.toContain('__TAURI_SCRIPT_NONCE__');
    expect(preflight.probes).toHaveLength(externalAddresses.length);
    expect(preflight.probativeAddresses.length).toBeGreaterThan(0);
    expect(probes).toHaveLength(externalAddresses.length);
    expect(
      probes.filter(({ address }) =>
        preflight.probativeAddresses.includes(address),
      ),
    ).toEqual(
      preflight.probativeAddresses.map((address) => ({
        address,
        outcome: 'refused',
      })),
    );

    const tauriConfig = JSON.parse(
      await readFile(join(REPO_ROOT, 'src-desktop/tauri.conf.json'), 'utf8'),
    ) as { build: { devUrl: string } };
    expect(tauriConfig.build.devUrl).toBe('http://127.0.0.1:5173');
  }, 45_000);
});
