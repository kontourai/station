import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { restrictAccountLabTcp } from './local-collaboration-network.mjs';

if (process.argv[2] === '--account-station-child') {
  const raw: unknown = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  assert(raw && typeof raw === 'object');
  const input = raw as {
    port: number;
    allowedProbePort: number;
    blockedProbePort: number;
    probeNonce: string;
    virtualApplication?: boolean;
    additionalAllowedTcpPorts?: unknown;
    deniedAdditionalTcpPort?: unknown;
  };
  for (const port of [
    input.port,
    input.allowedProbePort,
    input.blockedProbePort,
  ])
    assert(Number.isSafeInteger(port) && port > 1024 && port < 65533);
  assert(
    typeof input.probeNonce === 'string' &&
      /^[a-f0-9]{64}$/.test(input.probeNonce),
  );
  assert(input.blockedProbePort !== input.allowedProbePort);
  const additionalAllowedTcpPorts = input.additionalAllowedTcpPorts ?? [];
  assert(
    Array.isArray(additionalAllowedTcpPorts) &&
      additionalAllowedTcpPorts.length <= 4 &&
      additionalAllowedTcpPorts.every(
        (port) => Number.isSafeInteger(port) && port > 1024 && port < 65533,
      ) &&
      new Set(additionalAllowedTcpPorts).size ===
        additionalAllowedTcpPorts.length,
  );
  if (input.deniedAdditionalTcpPort !== undefined)
    assert(
      Number.isSafeInteger(input.deniedAdditionalTcpPort) &&
        (input.deniedAdditionalTcpPort as number) > 1024 &&
        (input.deniedAdditionalTcpPort as number) < 65536 &&
        !additionalAllowedTcpPorts.includes(input.deniedAdditionalTcpPort),
    );
  restrictAccountLabTcp([
    input.allowedProbePort,
    ...Array.from({ length: 4 }, (_, offset) => input.port + offset),
    ...additionalAllowedTcpPorts,
  ]);
  const allowed = await fetch(
    `http://127.0.0.1:${input.allowedProbePort}/probe`,
    { signal: AbortSignal.timeout(5000) },
  );
  assert.equal(await allowed.text(), input.probeNonce);
  await assert.rejects(
    fetch(`http://127.0.0.1:${input.blockedProbePort}/probe`, {
      signal: AbortSignal.timeout(5000),
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.cause instanceof Error &&
      'code' in error.cause &&
      error.cause.code === 'ACCOUNT_LAB_TCP_REFUSED',
  );
  if (input.deniedAdditionalTcpPort !== undefined)
    await assert.rejects(
      fetch(`http://127.0.0.1:${input.deniedAdditionalTcpPort}/probe`, {
        signal: AbortSignal.timeout(5000),
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        'code' in error.cause &&
        error.cause.code === 'ACCOUNT_LAB_TCP_REFUSED',
    );
  const lifetime = setTimeout(
    () => process.kill(process.pid, 'SIGTERM'),
    300000,
  );
  lifetime.unref();
  if (input.virtualApplication === true) {
    const { runVirtualLabStation } = await import(
      './local-collaboration-virtual-station.js'
    );
    await runVirtualLabStation(input.port);
  } else await import('../../src-server/index.js');
}
