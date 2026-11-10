import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  describeRunningTurns,
  readRunningTurns,
} from '../commands/lifecycle.js';
import {
  getProfileCredentialStore,
  type ProfileCredentialStore,
  profileCredentialRef,
  setProfileCredentialStore,
} from '../commands/profile-credentials.js';
import { upsertProfile } from '../commands/profile-store.js';

const CREDENTIAL = 'paired-device-credential';

let root: string;
let previousCredentialStore: ProfileCredentialStore;
let previousHome: string | undefined;
let previousRoot: string | undefined;
const servers: Server[] = [];

function memoryCredentialStore(): ProfileCredentialStore & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    get: (ref) => values.get(ref.id),
    set: (ref, credential) => void values.set(ref.id, credential),
    delete: (ref) => void values.delete(ref.id),
    status: (ref) => (values.has(ref.id) ? 'available' : 'missing'),
  };
}

/**
 * A loopback stand-in for `GET /api/system/core-update/running-turns`, with
 * the real route's wire shapes: the bare `{turns, hiddenCount}` body for a
 * caller holding the credential, and the 401 envelope the credential gate
 * answers anyone else.
 */
async function startStubStation(
  answer: (respond: (status: number, body: string) => void) => void,
) {
  const requests: Array<{ url: string; authorization: string | undefined }> =
    [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url ?? '',
      authorization: request.headers.authorization,
    });
    const respond = (status: number, body: string) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(body);
    };
    if (
      request.method !== 'GET' ||
      request.url !== '/api/system/core-update/running-turns'
    )
      return respond(404, JSON.stringify({ error: 'not_found' }));
    if (request.headers.authorization !== `Bearer ${CREDENTIAL}`)
      return respond(
        401,
        JSON.stringify({
          success: false,
          error: { code: 'authentication_required' },
        }),
      );
    answer(respond);
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (address === null || typeof address !== 'object')
    throw new Error('stub Station failed to bind');
  return { port: address.port, requests };
}

/** A Station saved on this device, with its credential in the keyring. */
function saveStation(port: number, name = 'local'): void {
  const credentialRef = profileCredentialRef(`test:${name}`);
  getProfileCredentialStore().set(credentialRef, CREDENTIAL);
  upsertProfile({
    name,
    endpoint: `http://127.0.0.1:${port}`,
    setupSource: 'existing',
    configurationState: 'configured',
    credentialRef,
    makeDefault: true,
    force: true,
  });
}

const twoTurnsAndAHiddenOne = JSON.stringify({
  turns: [
    {
      sessionId: 'task:build',
      conversationId: 'task:build',
      title: 'Fix the build',
      engine: 'claude',
      startedAt: '2026-11-10T10:00:00.000Z',
    },
    {
      sessionId: 'chat:untitled',
      conversationId: null,
      title: null,
      engine: 'codex',
      startedAt: null,
    },
  ],
  hiddenCount: 1,
});

// Created before the hook that closes the stub servers, so the directory is
// removed after they are closed.
const makeTempDir = trackTempDirs();

beforeEach(() => {
  previousCredentialStore = getProfileCredentialStore();
  setProfileCredentialStore(memoryCredentialStore());
  root = makeTempDir('station-running-turns-');
  previousHome = process.env.STATION_HOME;
  previousRoot = process.env.STATION_ROOT;
  process.env.STATION_HOME = join(root, 'instances', 'stable');
  process.env.STATION_ROOT = root;
});

afterEach(async () => {
  setProfileCredentialStore(previousCredentialStore);
  if (previousHome === undefined) delete process.env.STATION_HOME;
  else process.env.STATION_HOME = previousHome;
  if (previousRoot === undefined) delete process.env.STATION_ROOT;
  else process.env.STATION_ROOT = previousRoot;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('readRunningTurns: what a restart is about to interrupt', () => {
  it('reads the instance’s running turns with the credential this device saved for it', async () => {
    const stub = await startStubStation((respond) =>
      respond(200, twoTurnsAndAHiddenOne),
    );
    saveStation(stub.port);

    const running = await readRunningTurns({ serverPort: stub.port });

    expect(running).toEqual({
      turns: [
        { title: 'Fix the build', engine: 'claude' },
        { title: null, engine: 'codex' },
      ],
      hiddenCount: 1,
    });
    expect(stub.requests).toEqual([
      {
        url: '/api/system/core-update/running-turns',
        authorization: `Bearer ${CREDENTIAL}`,
      },
    ]);
    expect(describeRunningTurns(running)).toEqual([
      '3 agent turns are running and will be interrupted:',
      '  · Fix the build (claude)',
      '  · Untitled session (codex)',
      '  · 1 more in a session this device may not read',
    ]);
  });

  it('with no saved credential for the instance, sends nothing and reports nothing', async () => {
    const stub = await startStubStation((respond) =>
      respond(200, twoTurnsAndAHiddenOne),
    );

    const running = await readRunningTurns({ serverPort: stub.port });

    expect(running).toBeUndefined();
    expect(stub.requests).toEqual([]);
    expect(describeRunningTurns(running)).toEqual([]);
  });

  it('never sends a credential saved for a Station on another port', async () => {
    const stub = await startStubStation((respond) =>
      respond(200, twoTurnsAndAHiddenOne),
    );
    saveStation(stub.port + 1, 'elsewhere');

    expect(await readRunningTurns({ serverPort: stub.port })).toBeUndefined();
    expect(stub.requests).toEqual([]);
  });

  it('a refused read reports nothing', async () => {
    const stub = await startStubStation((respond) =>
      respond(200, twoTurnsAndAHiddenOne),
    );
    saveStation(stub.port);
    getProfileCredentialStore().set(
      profileCredentialRef('test:local'),
      'revoked-credential',
    );

    expect(await readRunningTurns({ serverPort: stub.port })).toBeUndefined();
    expect(stub.requests).toHaveLength(1);
  });

  it.each([
    ['a server error', 500, JSON.stringify({ success: false })],
    ['a body that is not the route’s shape', 200, JSON.stringify({ ok: 1 })],
    ['a body that is not JSON', 200, '<html>'],
  ])('%s reports nothing', async (_name, status, body) => {
    const stub = await startStubStation((respond) => respond(status, body));
    saveStation(stub.port);

    expect(await readRunningTurns({ serverPort: stub.port })).toBeUndefined();
  });

  it('an instance that does not answer in time reports nothing', async () => {
    const stub = await startStubStation(() => {
      // Never answers.
    });
    saveStation(stub.port);

    expect(
      await readRunningTurns({ serverPort: stub.port }, { timeoutMs: 50 }),
    ).toBeUndefined();
  });

  it('an instance that is not listening reports nothing', async () => {
    const stub = await startStubStation((respond) =>
      respond(200, twoTurnsAndAHiddenOne),
    );
    saveStation(stub.port);
    await new Promise<void>((resolve) =>
      servers.splice(0)[0]!.close(() => resolve()),
    );

    expect(await readRunningTurns({ serverPort: stub.port })).toBeUndefined();
  });
});

describe('describeRunningTurns', () => {
  it('says nothing when no turn is running', () => {
    expect(describeRunningTurns({ turns: [], hiddenCount: 0 })).toEqual([]);
  });

  it('names one turn in the singular', () => {
    expect(
      describeRunningTurns({
        turns: [{ title: 'Weekly report', engine: 'claude' }],
        hiddenCount: 0,
      }),
    ).toEqual([
      '1 agent turn is running and will be interrupted:',
      '  · Weekly report (claude)',
    ]);
  });

  it('counts turns it cannot name', () => {
    expect(describeRunningTurns({ turns: [], hiddenCount: 2 })).toEqual([
      '2 agent turns are running and will be interrupted:',
      '  · 2 in sessions this device may not read',
    ]);
  });

  it('lists at most ten titles and counts the rest', () => {
    const lines = describeRunningTurns({
      turns: Array.from({ length: 12 }, (_unused, index) => ({
        title: `Task ${index + 1}`,
        engine: 'claude',
      })),
      hiddenCount: 0,
    });
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe(
      '12 agent turns are running and will be interrupted:',
    );
    expect(lines[10]).toBe('  · Task 10 (claude)');
    expect(lines[11]).toBe('  · 2 more');
  });

  it('escapes control characters in a title, which is another person’s text', () => {
    expect(
      describeRunningTurns({
        turns: [{ title: 'a\u001b[2Jb\nc', engine: 'claude' }],
        hiddenCount: 0,
      })[1],
    ).toBe('  · a\\u001b[2Jb\\u000ac (claude)');
  });
});
