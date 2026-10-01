import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { build } from 'esbuild';
import {
  startTauriShellFixture,
  type TauriShellFixture,
} from './direct-webdriver.js';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke?: unknown };
    nativeChatDispatchProof?: {
      phase: string;
      status?: number;
      body?: unknown;
      error?: string;
    };
  }
}

let fixture: TauriShellFixture | undefined;
let server: Server | undefined;
let dispatches = 0;
try {
  fixture = await startTauriShellFixture();
  const origin = `http://127.0.0.1:${fixture.remotePort}`;
  server = createServer((request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/api/orchestration/chat'
    ) {
      response.writeHead(404).end();
      return;
    }
    if (
      request.headers.authorization !== 'Bearer synthetic-tauri-shell-e2e-token'
    ) {
      response.writeHead(401).end();
      return;
    }
    dispatches++;
    request.resume();
    request.on('end', () => {
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ accepted: true, providerTurnId: 'fixture-turn' }),
        );
      }, 26_000);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(fixture!.remotePort, '127.0.0.1', resolve);
  });
  await fixture.driver.waitUntil(
    async () =>
      fixture!.driver.execute(() =>
        Boolean(window.__TAURI_INTERNALS__?.invoke),
      ),
    {
      timeout: 120_000,
      timeoutMsg: 'Native bridge did not become ready.',
    },
  );
  // Fixture selection intent must survive the shell's local-owner bootstrap.
  await fixture.driver.execute(() => {
    localStorage.setItem(
      'station-native-profile-selection-v1',
      JSON.stringify({
        schemaVersion: 1,
        connectionId: 'station-profile:remote-plugin-proof',
      }),
    );
  });
  await fixture.driver.refresh();
  await fixture.driver.waitUntil(
    async () =>
      fixture!.driver.execute(() =>
        Boolean(window.__TAURI_INTERNALS__?.invoke),
      ),
    {
      timeout: 30_000,
      timeoutMsg: 'Native bridge did not return after fixture selection.',
    },
  );
  const proof = await build({
    stdin: {
      loader: 'ts',
      resolveDir: process.cwd(),
      contents: `
      import { invoke } from '@tauri-apps/api/core';
      import { nativeAuthenticatedTransport } from './src-ui/src/platform/native/authenticatedTransport';
      window.nativeChatDispatchProof = { phase: 'pending' };
      (async () => {
        await invoke('station_profile_store_read');
        await invoke('station_profile_authorize_active', { profileName: 'remote-plugin-proof' });
        const response = await nativeAuthenticatedTransport(${JSON.stringify(`${origin}/api/orchestration/chat`)}, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'hello' }),
        });
        window.nativeChatDispatchProof = { phase: 'done', status: response.status, body: await response.json() };
      })().catch(error => { window.nativeChatDispatchProof = { phase: 'failed', error: String(error) }; });
    `,
    },
    bundle: true,
    loader: { '.css': 'empty' },
    format: 'iife',
    platform: 'browser',
    write: false,
  });
  await fixture.driver.executeAsyncSource(
    `${proof.outputFiles[0].text}\narguments[arguments.length - 1]({started:true});`,
  );
  await fixture.driver.waitUntil(
    async () =>
      fixture!.driver.execute(() => {
        const proof = window.nativeChatDispatchProof;
        return proof?.phase !== 'pending';
      }),
    { timeout: 90_000, timeoutMsg: 'Native chat dispatch did not settle.' },
  );
  const result = await fixture.driver.execute(
    () => window.nativeChatDispatchProof,
  );
  assert.deepEqual(result, {
    phase: 'done',
    status: 200,
    body: { accepted: true, providerTurnId: 'fixture-turn' },
  });
  assert.equal(dispatches, 1);
  console.log(
    'Native WebView/IPC/HTTP chat dispatch received its provider-turn receipt after a 26-second header delay.',
  );
} finally {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  await fixture?.stop();
}
