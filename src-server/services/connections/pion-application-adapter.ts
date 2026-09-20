import { existsSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { ApplicationChannel } from '@kontourai/station-connect/application-channel';
import { readJsonFile } from '@kontourai/station-shared/json-file-storage';
import {
  createStationTempDir,
  removeStationTempDir,
} from '@kontourai/station-shared/temp-dir';
import {
  spawnOwnedChild,
  terminateProcessTree,
} from '../infra/process-utils.js';
import {
  PION_APPLICATION_IPC_VERSION,
  PionApplicationIpc,
} from './pion-application-ipc.js';

export type PionAdapterProfile = 'application' | 'diagnosticEcho';
export interface PionApplicationAdapterInput {
  executable: string;
  profile: PionAdapterProfile;
  applicationChannelLabel?: string;
  offer: { type: 'offer'; sdp: string };
  certificatePem: string;
  privateKeyPem: string;
  turn: { url: string; username: string; password: string };
  accept(channel: ApplicationChannel): void;
  signal: AbortSignal;
}
export function validatePionAdapterProfile(
  profile: PionAdapterProfile | undefined,
  label: string | undefined,
) {
  if (profile !== 'application' && profile !== 'diagnosticEcho')
    throw new Error(
      profile === undefined ? 'pion_profile_required' : 'pion_profile_unknown',
    );
  if (profile === 'application' && !label)
    throw new Error('pion_application_label_required');
  if (profile === 'diagnosticEcho' && label)
    throw new Error('pion_diagnostic_profile_invalid');
}
function executable(path: string) {
  if (!isAbsolute(path)) throw new Error('pion_executable_invalid');
  const resolved = realpathSync(path);
  const info = lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error('pion_executable_invalid');
  return resolved;
}
function boundedOutput(
  stream: Readable | undefined,
  onFailure: (error: Error) => void,
) {
  let bytes = 0;
  let text = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 64 * 1024)
      onFailure(new Error('pion_diagnostic_output_exceeded_bound'));
    else text += chunk;
  });
  return () => text;
}
export async function startPionApplicationAdapter(
  input: PionApplicationAdapterInput,
) {
  validatePionAdapterProfile(input.profile, input.applicationChannelLabel);
  if (process.platform === 'win32')
    throw new Error('pion_private_pipe_custody_unavailable_on_windows');
  input.signal.throwIfAborted();
  if (
    Buffer.byteLength(input.offer.sdp) > 128 * 1024 ||
    Buffer.byteLength(input.certificatePem) > 64 * 1024 ||
    Buffer.byteLength(input.privateKeyPem) > 64 * 1024 ||
    [input.turn.url, input.turn.username, input.turn.password].some(
      (value) => typeof value !== 'string' || Buffer.byteLength(value) > 4096,
    )
  )
    throw new Error('pion_configuration_invalid');
  const resolvedExecutable = executable(input.executable);
  const directory = await createStationTempDir('pion-application');
  for (const path of [dirname(directory), directory]) {
    const info = lstatSync(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0
    ) {
      await removeStationTempDir(directory);
      throw new Error('pion_temp_custody_invalid');
    }
  }
  input.signal.throwIfAborted();
  const certificate = join(directory, 'certificate.pem');
  const key = join(directory, 'private-key.pem');
  try {
    writeFileSync(certificate, input.certificatePem, {
      flag: 'wx',
      mode: 0o600,
    });
    writeFileSync(key, input.privateKeyPem, { flag: 'wx', mode: 0o600 });
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({
        Offer: input.offer,
        Certificate: certificate,
        Key: key,
        URL: input.turn.url,
        Username: input.turn.username,
        Password: input.turn.password,
        Profile: input.profile,
        ProtocolVersion:
          input.profile === 'application'
            ? PION_APPLICATION_IPC_VERSION
            : 'station.diagnostic-echo/v1',
        ApplicationChannelLabel: input.applicationChannelLabel ?? '',
      }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    await removeStationTempDir(directory);
    throw error;
  }
  const owned = spawnOwnedChild(resolvedExecutable, [directory], {
    cwd: directory,
    stdio:
      input.profile === 'application'
        ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'pipe'],
  });
  const child = owned.proc;
  let failure: Error | undefined;
  let ipc: PionApplicationIpc | undefined;
  let shutdown: Promise<void> | undefined;
  let stdout = () => '';
  let aborted = () => {};
  const close = () =>
    (shutdown ??= (async () => {
      input.signal.removeEventListener('abort', aborted);
      ipc?.close();
      await terminateProcessTree(child, {
        graceMs: 2_000,
        killConfirmMs: 3_000,
      });
      ipc?.finish();
      if (input.profile === 'application' && stdout() !== '')
        throw new Error('pion_application_content_diagnostic_boundary');
      if (failure) throw failure;
      owned.release();
      await removeStationTempDir(directory);
      if (existsSync(directory))
        throw new Error('pion_temp_cleanup_incomplete');
    })());
  const fail = (error: Error) => {
    failure ??= error;
    void close().catch(() => {});
  };
  child.once('error', () => fail(new Error('pion_process_failed')));
  child.once('exit', () => {
    if (!shutdown) fail(new Error('pion_process_exited'));
  });
  stdout = boundedOutput(child.stdout ?? undefined, fail);
  boundedOutput(child.stderr ?? undefined, fail);
  try {
    if (input.profile === 'application') {
      const write = child.stdio?.[3];
      const read = child.stdio?.[4];
      if (!write || !read || !('write' in write) || !('read' in read))
        throw new Error('pion_application_pipes_unavailable');
      ipc = new PionApplicationIpc(
        write as Writable,
        read as Readable,
        input.accept,
      );
    }
  } catch (error) {
    failure =
      error instanceof Error
        ? error
        : new Error('pion_application_setup_failed');
    await close().catch(() => {});
    throw error;
  }
  aborted = () => fail(new Error('pion_application_aborted'));
  input.signal.addEventListener('abort', aborted, { once: true });
  try {
    const deadline = Date.now() + 25_000;
    while (true) {
      input.signal.throwIfAborted();
      if (failure) throw failure;
      try {
        const answer = readJsonFile<{ type: unknown; sdp: unknown }>(
          join(directory, 'answer.json'),
          { type: null, sdp: null },
          { maxBytes: 128 * 1024, label: 'Pion answer' },
        );
        if (
          Object.keys(answer).sort().join(',') === 'sdp,type' &&
          answer.type === 'answer' &&
          typeof answer.sdp === 'string' &&
          answer.sdp.length > 0 &&
          Buffer.byteLength(answer.sdp) <= 128 * 1024
        ) {
          const version = readJsonFile<Record<string, unknown>>(
            join(directory, 'version.json'),
            {},
            { maxBytes: 4096, label: 'Pion version' },
          );
          if (
            Object.keys(version).sort().join(',') !== 'go,pion' ||
            version.pion !== 'v4.2.20' ||
            typeof version.go !== 'string' ||
            !version.go.startsWith('go1.26')
          )
            throw new Error('pion_version_invalid');
          return {
            answer: { type: 'answer' as const, sdp: answer.sdp },
            close,
          };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (Date.now() >= deadline) throw new Error('pion_answer_timeout');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'pion_adapter_startup_cleanup_failed',
      );
    }
    throw error;
  }
}
