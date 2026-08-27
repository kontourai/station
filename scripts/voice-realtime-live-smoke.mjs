#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const providerIndex = process.argv.indexOf('--provider');
const provider =
  providerIndex >= 0 ? process.argv[providerIndex + 1] : undefined;
const validateCredentials = process.argv.includes('--validate-credentials');

if (!provider) {
  console.error(
    'NOT_VERIFIED: pass --provider <id>; no provider was selected.',
  );
  process.exitCode = 2;
} else {
  const credentialName =
    provider === 'elevenlabs-realtime'
      ? 'ELEVENLABS_API_KEY'
      : provider === 'openai-realtime-compatible'
        ? 'OPENAI_API_KEY'
        : provider === 'nova-s2s'
          ? 'AWS_ACCESS_KEY_ID'
          : undefined;
  const credentialFileName =
    provider === 'elevenlabs-realtime'
      ? 'ELEVENLABS_API_KEY_FILE'
      : provider === 'openai-realtime-compatible'
        ? 'OPENAI_API_KEY_FILE'
        : undefined;
  if (!hasCredential(provider, credentialName, credentialFileName)) {
    console.error(
      `NOT_VERIFIED: ${provider} requires configured credentials; no live request was made.`,
    );
    process.exitCode = 2;
  } else if (validateCredentials) {
    console.error(
      'NOT_VERIFIED: credential configuration was found; no live request was made.',
    );
    process.exitCode = 2;
  } else if (provider === 'nova-s2s') {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/voice-realtime-nova-smoke.ts'],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 330_000,
      },
    );
    if (
      result.status === 2 &&
      result.stdout.includes('NOVA_START_SPEECH_STOP_COMPLETE')
    ) {
      console.error(
        'NOT_VERIFIED: Nova start/speech/stop completed, but its S2S bridge has no text-turn or explicit interrupt; AC2 remains unproven.',
      );
      process.exitCode = 2;
    } else {
      console.error(
        'NOT_VERIFIED: Nova realtime smoke could not complete; no upstream response was printed.',
      );
      process.exitCode = 2;
    }
  } else if (provider === 'openai-realtime-compatible') {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/voice-realtime-openai-smoke.ts'],
      {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 180_000,
      },
    );
    if (
      result.status === 0 &&
      result.stdout.includes(
        'OPENAI_REALTIME_START_TEXT_SPEECH_INTERRUPT_STOP_COMPLETE',
      )
    ) {
      console.log('OPENAI_REALTIME_START_TEXT_SPEECH_INTERRUPT_STOP_COMPLETE');
    } else {
      const stage =
        result.stderr.match(/FAIL_STAGE:([a-z-]+)/)?.[1] ?? 'unknown';
      console.error(
        `FAIL: OpenAI realtime smoke did not complete at stage=${stage}; provider details were suppressed.`,
      );
      process.exitCode = 1;
    }
  } else {
    console.error(
      'NOT_VERIFIED: a provider-specific injected live transport is required before this harness can create a session.',
    );
    process.exitCode = 2;
  }
}

function hasCredential(provider, credentialName, credentialFileName) {
  if (credentialName && process.env[credentialName]?.trim()) return true;
  if (provider === 'nova-s2s' && process.env.AWS_PROFILE?.trim()) return true;
  // A protected file keeps credentials out of process listings and command
  // history. Its path and contents are deliberately never included in output.
  const credentialFile = credentialFileName
    ? process.env[credentialFileName]
    : undefined;
  if (!credentialFile) return false;
  try {
    const stat = statSync(credentialFile);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return false;
    return readFileSync(credentialFile, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}
