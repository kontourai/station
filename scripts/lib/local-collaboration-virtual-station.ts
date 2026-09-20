import assert from 'node:assert/strict';
import { serveApplicationChannel } from '@kontourai/station-connect/application-channel';
import { formatReadinessHandshake } from '../../src-server/runtime/bootstrap/readiness-handshake.js';
import { StationRuntime } from '../../src-server/runtime/bootstrap/station-runtime.js';
import { ApplicationIpc } from './application-ipc.js';

/** Full runtime with an owned parent IPC adapter, never a replacement auth route. */
export async function runVirtualLabStation(port: number) {
  assert(process.send && process.connected);
  const origin = process.env.STATION_AUTHENTICATION_ORIGIN;
  const home = process.env.STATION_HOME;
  assert(origin && home);
  let ipc: ApplicationIpc | undefined;
  const runtime = new StationRuntime({
    projectHomeDir: home,
    port,
    host: '127.0.0.1',
    logLevel: 'error',
    virtualApplication: {
      origin,
      ready(application) {
        ipc = new ApplicationIpc(
          {
            send: (packet, done) => process.send!(packet, done),
            subscribe(listener) {
              process.on('message', listener);
              return () => {
                process.off('message', listener);
              };
            },
          },
          (channel) => {
            serveApplicationChannel(channel, origin, application);
          },
        );
      },
    },
  });
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      ipc?.close();
      await runtime.shutdown();
      process.exitCode = 0;
      if (process.connected) process.disconnect?.();
    })());
  const interrupted = () => {
    void stop().catch(() => {
      process.exitCode = 1;
      if (process.connected) process.disconnect?.();
    });
  };
  process.once('SIGTERM', interrupted);
  process.once('SIGINT', interrupted);
  process.once('disconnect', interrupted);
  try {
    await runtime.initialize();
    if (stopping) {
      await stopping;
      return;
    }
    process.stdout.write(formatReadinessHandshake(port, '127.0.0.1'));
  } catch (error) {
    await stop();
    throw error;
  }
}
