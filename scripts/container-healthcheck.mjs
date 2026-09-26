#!/usr/bin/env node
import { invokedDirectly } from './lib/module-entry.mjs';

export async function checkContainerHealth({
  baseUrl = 'http://127.0.0.1:3000',
  expectedSha = process.env.STATION_IMAGE_SHA,
  timeoutMs = 4000,
} = {}) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? ''))
    throw new Error('Container image SHA is missing or invalid');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 4000)
    throw new Error('Container health timeout must be between 1 and 4000ms');
  const [identityResponse, readinessResponse] = await Promise.all([
    fetch(new URL('/__station/identity', baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    }),
    fetch(new URL('/api/system/readiness', baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    }),
  ]);
  if (!identityResponse.ok || !readinessResponse.ok)
    throw new Error(
      `Container is not ready (identity=${identityResponse.status}, readiness=${readinessResponse.status})`,
    );
  const [identity, readiness] = await Promise.all([
    identityResponse.json(),
    readinessResponse.json(),
  ]);
  if (identity.sha !== expectedSha)
    throw new Error('Container image identity mismatch');
  if (readiness.ready !== true || readiness.status !== 'ready')
    throw new Error('Container backend is not ready');
}

if (invokedDirectly(import.meta.url)) {
  try {
    await checkContainerHealth();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
