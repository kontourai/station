#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  headers,
  optionValue,
  optionValues,
  readCredential,
} from './lib/agent-smoke-client.mjs';
import { renderMatrix, runMatrix } from './lib/engine-matrix.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

export async function main() {
  if (!process.argv.includes('--confirm-billable-engine-matrix')) {
    console.error(
      'Refusing to send chat. Supply --confirm-billable-engine-matrix; up to six turns per advertised model, plus registered scenarios, may be billed within --max-turns (default 24).',
    );
    process.exitCode = 2;
    return;
  }
  let credential;
  const redact = (value) => {
    const message = String(value);
    return (
      credential?.length >= 16
        ? message.replaceAll(credential, '[redacted]')
        : message
    )
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(
        /(api[_-]?key|token|secret|password)(["'=:\s]+)\S+/gi,
        '$1$2[redacted]',
      );
  };
  try {
    const origin = optionValue('origin')?.replace(/\/$/, '');
    const cwd = optionValue('cwd');
    const connectionId = optionValue('connection');
    if (!origin || !cwd || !connectionId)
      throw new Error(
        'Provide --origin, --cwd (a disposable server-side folder), and --connection',
      );
    const timeoutMs = Number(optionValue('timeout-ms') ?? 60_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000)
      throw new Error('timeout-ms must be between 100 and 300000');
    credential = await readCredential();
    if (credential.trim().length < 16)
      throw new Error(
        'Credential must contain at least 16 characters; refusing before network requests',
      );
    const modulePath = optionValue('scenario-module');
    const extension = modulePath
      ? await import(pathToFileURL(resolve(modulePath)).href)
      : {};
    const api = async (path, body, method = body ? 'POST' : 'GET') => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: headers(credential, !!body),
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      const payload = await response.json();
      if (!response.ok || payload.success !== true)
        throw new Error(
          `Station API ${path} failed (${response.status}): ${payload.error ?? 'unsuccessful response'}`,
        );
      return payload;
    };
    const result = await runMatrix({
      api,
      connectionId,
      cwd,
      timeoutMs,
      additionalScenarios: extension.scenarios,
      observeOutputs: extension.observeOutputs,
      modelIds: optionValues('model'),
      agentId: optionValue('agent'),
      maxTurns: Number(optionValue('max-turns') ?? 24),
      onPlan: (plan) =>
        console.error(JSON.stringify({ type: 'engine-matrix-plan', ...plan })),
    });
    // Provider errors can contain arbitrary text; bounded pattern redaction is not a secrecy guarantee.
    const json = JSON.stringify(
      result,
      (_key, value) => (typeof value === 'string' ? redact(value) : value),
      2,
    );
    const safeResult = JSON.parse(json);
    const directory = resolve(
      optionValue('output-dir') ?? 'docs/reference/engine-matrix-runs',
    );
    await mkdir(directory, { recursive: true });
    const stem = `engine-matrix-${result.generatedAt.replaceAll(/[:.]/g, '-')}`;
    await writeFile(resolve(directory, `${stem}.json`), `${json}\n`, {
      flag: 'wx',
    });
    await writeFile(
      resolve(directory, `${stem}.md`),
      renderMatrix(safeResult),
      { flag: 'wx' },
    );
    console.log(json);
    if (result.rows.some((row) => row.status !== 'pass')) process.exitCode = 1;
  } catch (error) {
    console.error(redact(error.message ?? error));
    process.exitCode = 1;
  }
}

if (invokedDirectly(import.meta.url)) await main();
