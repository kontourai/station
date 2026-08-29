import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  findFreePortBlock,
  findFreePortOutside,
} from '../../scripts/lib/free-ports.mjs';

const root = resolve(import.meta.dirname, '../..');
const binary = process.env.STATION_TAURI_E2E_BINARY;
if (!binary) throw new Error('STATION_TAURI_E2E_BINARY is required.');

const inheritedRoot = process.env.STATION_TAURI_E2E_ROOT;
const inheritedHome = process.env.STATION_TAURI_E2E_HOME;
const ownsFixture = !inheritedRoot && !inheritedHome;
let stationRoot: string;
let stationHome: string;
let instance: string;
let serverPort: number;
let uiPort: number;
let remotePort: number;
let framePort: number;
let blockedPort: number;
if (ownsFixture) {
  serverPort = await findFreePortBlock(8);
  uiPort = await findFreePortOutside(serverPort, 8);
  remotePort = serverPort + 4;
  framePort = serverPort + 5;
  blockedPort = serverPort + 6;
  stationRoot = mkdtempSync(join(tmpdir(), 'station-tauri-shell-e2e-'));
  instance = basename(stationRoot);
  stationHome = join(stationRoot, 'instances', instance);
  mkdirSync(stationHome, { recursive: true, mode: 0o700 });
  Object.assign(process.env, {
    STATION_TAURI_E2E_ROOT: stationRoot,
    STATION_TAURI_E2E_HOME: stationHome,
    STATION_TAURI_E2E_INSTANCE: instance,
    STATION_TAURI_E2E_SERVER_PORT: String(serverPort),
    STATION_TAURI_E2E_UI_PORT: String(uiPort),
    STATION_TAURI_E2E_REMOTE_PORT: String(remotePort),
    STATION_TAURI_E2E_FRAME_PORT: String(framePort),
    STATION_TAURI_E2E_BLOCKED_PORT: String(blockedPort),
  });
  writeFileSync(
    join(stationHome, '.station-home-schema.json'),
    `${JSON.stringify({ version: 1 }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const profileDirectory = join(stationRoot, 'config');
  mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
  const profileNow = Date.now();
  writeFileSync(
    join(profileDirectory, 'profiles.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        revision: 0,
        defaultProfile: 'remote-plugin-proof',
        profiles: [
          {
            schemaVersion: 1,
            name: 'remote-plugin-proof',
            endpoint: `http://127.0.0.1:${remotePort}`,
            credentialRef: {
              kind: 'station-bearer',
              id: 'tauri-shell-e2e',
            },
            environmentId: '11111111-1111-4111-8111-111111111111',
            setupSource: 'paired',
            configurationState: 'configured',
            createdAt: profileNow,
            updatedAt: profileNow,
          },
        ],
        projectProfiles: {},
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
} else {
  if (!inheritedRoot || !inheritedHome) {
    throw new Error(
      'Inherited Tauri shell config must provide both STATION_TAURI_E2E_ROOT and STATION_TAURI_E2E_HOME.',
    );
  }
  const required = (name: string) => {
    const value = Number(process.env[name]);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Inherited Tauri shell config is missing ${name}.`);
    }
    return value;
  };
  stationRoot = inheritedRoot;
  stationHome = inheritedHome;
  instance = process.env.STATION_TAURI_E2E_INSTANCE ?? basename(stationHome);
  serverPort = required('STATION_TAURI_E2E_SERVER_PORT');
  uiPort = required('STATION_TAURI_E2E_UI_PORT');
  remotePort = required('STATION_TAURI_E2E_REMOTE_PORT');
  framePort = required('STATION_TAURI_E2E_FRAME_PORT');
  blockedPort = required('STATION_TAURI_E2E_BLOCKED_PORT');
}
const outputDir = join(root, '.kontourai', 'tauri-shell-e2e');
mkdirSync(outputDir, { recursive: true });
writeFileSync(
  join(outputDir, 'context.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sourceSha: process.env.STATION_TAURI_E2E_SOURCE_SHA,
      binary,
      stationRoot,
      stationHome,
      instance,
      serverPort,
      uiPort,
      remotePort,
      framePort,
      blockedPort,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

export const config = {
  runner: 'local' as const,
  specs: ['./plugin-host-security.e2e.ts'],
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': { application: binary },
      'wdio:tauriServiceOptions': {
        appBinaryPath: binary,
        appArgs: [],
        driverProvider: 'embedded' as const,
        env: {
          STATION_HOME: stationHome,
          STATION_ROOT: stationRoot,
          STATION_INSTANCE: instance,
          STATION_PORT: String(serverPort),
          STATION_UI_PORT: String(uiPort),
          STATION_NODE: process.execPath,
          STATION_DESKTOP_LOG_LEVEL: 'debug',
          STATION_TAURI_E2E_MOCK_CREDENTIAL: '1',
        },
        captureBackendLogs: true,
        captureFrontendLogs: true,
        backendLogLevel: 'debug' as const,
        frontendLogLevel: 'debug' as const,
      },
    },
  ],
  services: [
    [
      '@wdio/tauri-service',
      {
        driverProvider: 'embedded' as const,
        captureBackendLogs: true,
        captureFrontendLogs: true,
      },
    ],
  ],
  framework: 'mocha' as const,
  reporters: ['spec'],
  logLevel: 'info' as const,
  outputDir,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  mochaOpts: { ui: 'bdd', timeout: 120_000 },
  onComplete() {
    if (!ownsFixture) return;
    const allowedPrefix = join(tmpdir(), 'station-tauri-shell-e2e-');
    if (!stationRoot.startsWith(allowedPrefix)) {
      throw new Error(
        `Refusing to remove unexpected Tauri E2E fixture: ${stationRoot}`,
      );
    }
    rmSync(stationRoot, { recursive: true, force: true });
  },
};
