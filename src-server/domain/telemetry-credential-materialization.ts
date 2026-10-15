import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AuthRef } from '@kontourai/station-contracts/datum-secret-reference';
import { terminateProcessTree } from '../services/infra/process-utils.js';

const childEntry = new URL(
  import.meta.url.endsWith('.ts')
    ? '../services/secrets/telemetry-key-materialization-child.ts'
    : './telemetry-key-materialization-child.js',
  import.meta.url,
);

/** Datum retains reference/backend semantics; its blocking runner is isolated and deadline-owned. */
export function materializeTelemetryCredential(
  authRef: AuthRef,
  environment: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted)
    return Promise.reject(new Error('Telemetry credential lookup cancelled.'));
  return new Promise((resolve, reject) => {
    const childEnvironment = Object.fromEntries(
      Object.entries(environment).filter(
        ([name]) =>
          [
            'PATH',
            'HOME',
            'USER',
            'LOGNAME',
            'TMPDIR',
            'TMP',
            'TEMP',
            'SystemRoot',
            'windir',
            'ComSpec',
            'PATHEXT',
            'XDG_CONFIG_HOME',
          ].includes(name) || name.startsWith('OP_'),
      ),
    );
    const child = spawn(
      process.execPath,
      [
        ...(childEntry.pathname.endsWith('.ts') ? ['--import', 'tsx'] : []),
        fileURLToPath(childEntry),
      ],
      {
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'json',
        env: childEnvironment,
      },
    );
    let settled = false;
    const finish = (key?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void terminateProcessTree(child, {
        processGroup: true,
        graceMs: 0,
        killConfirmMs: 500,
        taskkillTimeoutMs: 500,
      }).then(
        () =>
          key === undefined
            ? reject(new Error('Telemetry credential lookup failed.'))
            : resolve(key),
        () => reject(new Error('Telemetry credential cleanup failed.')),
      );
    };
    const onAbort = () => finish();
    const timer = setTimeout(onAbort, 3_000);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('message', (message: unknown) => {
      const key =
        message && typeof message === 'object' && 'key' in message
          ? message.key
          : undefined;
      finish(
        typeof key === 'string' &&
          key.length > 0 &&
          Buffer.byteLength(key) <= 8192
          ? key
          : undefined,
      );
    });
    child.once('error', () => finish());
    child.once('exit', () => finish());
    child.send({ authRef }, (error) => {
      if (error) finish();
    });
    if (signal?.aborted) finish();
  });
}
