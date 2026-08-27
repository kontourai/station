#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { exactProcessIdentity } from '../packages/shared/src/process-identity.mjs';
import { createWindowsOwnedControlStdin } from './lib/windows-owned-control-stdin.mjs';
import {
  createWindowsOwnedProtocol,
  MAX_WINDOWS_GUARD_RECORD_BYTES,
} from './lib/windows-owned-protocol.mjs';
import { createWindowsOwnedSettlement } from './lib/windows-owned-settlement.mjs';

function fail(message) {
  process.send?.({
    type: 'owned-command-complete',
    status: null,
    signal: null,
    error: String(message),
  });
  setInterval(() => {}, 60_000).unref();
}
function parseCommand() {
  const command = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url'));
  if (
    typeof command?.executable !== 'string' ||
    !Array.isArray(command?.args) ||
    !command.args.every((arg) => typeof arg === 'string') ||
    typeof command?.guardPath !== 'string' ||
    !Number.isInteger(command?.parent?.pid) ||
    typeof command?.parent?.start !== 'string'
  )
    throw new Error('invalid owned command envelope');
  return command;
}
let command;
try {
  command = parseCommand();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (command) {
  const protocol = createWindowsOwnedProtocol();
  let guard;
  let published = false;
  let buffered = Buffer.alloc(0);
  let outputsClosed = false;
  let keepalive;
  let successfullySettled = false;
  const publish = (
    result,
    { keepalive: retain = false, afterPublish } = {},
  ) => {
    if (published) return;
    published = true;
    if (retain && process.connected) keepalive = setInterval(() => {}, 60_000);
    const publishedResult = () => afterPublish?.();
    if (!process.connected || !process.send) return publishedResult();
    process.send(
      { type: 'owned-command-complete', ...result },
      publishedResult,
    );
  };
  const closeOutputs = () => {
    if (!outputsClosed) {
      outputsClosed = true;
      // These are the receiver-visible EOF barriers. Keep IPC/keepalive
      // separate so the coordinator cannot finish capture ahead of raw data.
      process.stdout.end();
      process.stderr.end();
    }
  };
  const finishAbortSettlement = () => {
    closeOutputs();
    clearInterval(keepalive);
    if (!process.connected) return process.exit(0);
    process.send?.({ type: 'owned-command-tree-settled' }, () => {
      if (process.connected) process.disconnect();
    });
  };
  const finishSuccessfulSettlement = (status) => {
    // Settlement has already proved guard exit, both raw EOFs, and drained
    // destination writes. Releasing this process is what closes its inherited
    // Windows receiver pipes; ending process.stdout/stderr does not do so.
    successfullySettled = true;
    publish(
      { status, signal: null, error: null },
      {
        afterPublish: () => {
          clearInterval(keepalive);
          if (process.connected) process.disconnect();
          else process.exit(0);
        },
      },
    );
  };
  const settlement = createWindowsOwnedSettlement({
    onComplete: finishSuccessfulSettlement,
    onAbortSettled: finishAbortSettlement,
  });
  const abort = (error) => {
    settlement.abort();
    const result = protocol.abort();
    if (result.ok) controlStdin?.writeAndEnd(result.record);
    publish(
      { status: null, signal: null, error: String(error) },
      { keepalive: true },
    );
  };
  guard = spawn(
    command.guardPath,
    [
      String(command.parent.pid),
      command.parent.start,
      command.executable,
      ...command.args,
    ],
    {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    },
  );
  const controlStdin = createWindowsOwnedControlStdin(guard.stdin);
  const raw = [guard.stdio[3], guard.stdio[4]];
  const forwardRaw = (stream, destination, index) => {
    stream?.on('data', (chunk) => {
      settlement.writeStart(index);
      const drained = destination.write(chunk, () => {
        settlement.writeFinish(index);
      });
      if (!drained) {
        stream.pause();
        destination.once('drain', () => stream.resume());
      }
    });
  };
  forwardRaw(raw[0], process.stdout, 0);
  forwardRaw(raw[1], process.stderr, 1);
  raw.forEach((stream, index) => {
    stream?.once('end', () => {
      settlement.rawEnd(index);
    });
    stream?.once('error', (error) => abort(error.message));
  });
  guard.stdout.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (
      buffered.length > MAX_WINDOWS_GUARD_RECORD_BYTES &&
      !buffered.includes(0x0a)
    )
      return abort('Windows owned guard control record exceeded its limit');
    let newline = buffered.indexOf(0x0a);
    while (newline >= 0) {
      let record;
      try {
        record = new TextDecoder('utf8', { fatal: true })
          .decode(buffered.subarray(0, newline))
          .replace(/\r$/, '');
      } catch {
        return abort('Windows owned guard control record was not valid UTF-8');
      }
      buffered = buffered.subarray(newline + 1);
      const received = protocol.receive(record);
      if (!received.ok) return abort(received.error.message);
      if (received.action === 'bound') {
        const target = exactProcessIdentity(received.pid);
        const guardIdentity = guard.pid
          ? exactProcessIdentity(guard.pid)
          : null;
        if (!target || target.start !== received.processStart || !guardIdentity)
          return abort(
            'Windows owned guard binding did not match exact identities',
          );
        process.send?.({
          type: 'owned-command-bound',
          pid: received.pid,
          processStart: received.processStart,
          guard: guardIdentity,
          jobBound: true,
        });
      } else {
        settlement.complete(received.status);
      }
      newline = buffered.indexOf(0x0a);
    }
  });
  guard.stdout.once('end', () => {
    if (buffered.length > 0)
      abort('Windows owned guard control stream ended with a partial record');
    else if (protocol.state() !== 'complete')
      abort('Windows owned guard control stream ended before completion');
  });
  guard.stderr.on('data', (chunk) => process.stderr.write(chunk));
  guard.once('error', (error) => abort(error.message));
  guard.once('close', (status, signal) => {
    if (status !== 0 || signal || protocol.state() !== 'complete') {
      settlement.guardClose(false);
      return abort(
        `Windows Job guard exited before valid completion (${status ?? signal ?? 'unknown'})`,
      );
    }
    settlement.guardClose(true);
  });
  const disconnect = () => {
    if (successfullySettled) return process.exit(0);
    if (protocol.state() === 'complete') return finishAbortSettlement();
    abort('Windows owned coordinator disconnected');
    const force = setTimeout(() => guard?.kill(), 5_000);
    force.unref();
    guard?.once('close', () => {
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.once('disconnect', disconnect);
  process.on('message', (message) => {
    if (message?.type === 'owned-command-resume') {
      const resumed = protocol.resume();
      if (!resumed.ok) return abort(resumed.error.message);
      if (!controlStdin.write(resumed.record))
        abort('Windows owned guard control stdin was unavailable');
    } else if (message?.type === 'owned-command-abort')
      abort('lease publication failed');
  });
}
