import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { createACPBridgeClient } from '../acp-bridge-client.js';

/**
 * #3957: the ACP client file-system methods act in Station's own process, so
 * a relative path would land in Station's working directory.
 */
const makeTempDir = trackTempDirs();

function client(
  fileAccessRefusal?: (
    path: string,
    access: 'read' | 'write',
  ) => string | undefined,
) {
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  return createACPBridgeClient({
    cwd: process.cwd(),
    terminals: new Map(),
    approvalRegistry: new ApprovalRegistry(silent as never),
    getActiveWriter: () => null,
    nextTerminalId: () => 'term',
    onSessionUpdate: async () => {},
    onExtNotification: () => {},
    onExtMethod: () => ({}),
    ...(fileAccessRefusal ? { fileAccessRefusal } : {}),
  });
}

async function refusal(pending: unknown) {
  const error = await Promise.resolve(pending).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RequestError);
  expect((error as RequestError).code).toBe(-32602);
  return (error as RequestError).message;
}

describe('#3957 ACP client file methods', () => {
  test('a relative path is refused, not resolved against Station’s directory', async () => {
    const name = `acp-bridge-3957-${Date.now()}.txt`;
    const message = await refusal(
      client().writeTextFile!({ sessionId: 's', path: name, content: 'x' }),
    );
    expect(message).toMatch(/absolute and normalized/);
    expect(existsSync(join(process.cwd(), name))).toBe(false);
    await refusal(
      client().readTextFile!({ sessionId: 's', path: 'package.json' }),
    );
  });

  test.each([
    ['a `..` segment', (dir: string) => `${dir}${sep}a${sep}..${sep}b.txt`],
    ['a repeated separator', (dir: string) => `${dir}${sep}${sep}b.txt`],
  ])('a path with %s is refused', async (_label, path) => {
    const dir = realpathSync(makeTempDir('acp-bridge-3957-'));
    await refusal(
      client().writeTextFile!({
        sessionId: 's',
        path: path(dir),
        content: 'x',
      }),
    );
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
  });

  test('without a session rule, an absolute path works as before (an engine that decides for itself)', async () => {
    const dir = realpathSync(makeTempDir('acp-bridge-3957-'));
    const path = join(dir, 'a.txt');
    await client().writeTextFile!({ sessionId: 's', path, content: 'hello' });
    expect(readFileSync(path, 'utf8')).toBe('hello');
    expect(await client().readTextFile!({ sessionId: 's', path })).toEqual({
      content: 'hello',
    });
  });

  test("the session's rule refuses a read or write before it happens", async () => {
    const dir = realpathSync(makeTempDir('acp-bridge-3957-'));
    mkdirSync(join(dir, 'p'));
    writeFileSync(join(dir, 'p', 'secret.txt'), 'kept');
    const asked: string[] = [];
    const confined = client((path, access) => {
      asked.push(`${access} ${path}`);
      return 'it is outside the project';
    });
    const write = await refusal(
      confined.writeTextFile!({
        sessionId: 's',
        path: join(dir, 'p', 'secret.txt'),
        content: 'changed',
      }),
    );
    expect(write).toMatch(/it is outside the project/);
    await refusal(
      confined.readTextFile!({
        sessionId: 's',
        path: join(dir, 'p', 'secret.txt'),
      }),
    );
    expect(readFileSync(join(dir, 'p', 'secret.txt'), 'utf8')).toBe('kept');
    expect(asked).toEqual([
      `write ${join(dir, 'p', 'secret.txt')}`,
      `read ${join(dir, 'p', 'secret.txt')}`,
    ]);
  });
});
