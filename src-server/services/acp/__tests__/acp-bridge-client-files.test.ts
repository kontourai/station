import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, sep, win32 } from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import {
  createACPBridgeClient,
  normalizedClientPath,
} from '../acp-bridge-client.js';

/**
 * #3957: the ACP client file-system methods act in Station's own process, so
 * a relative path would land in Station's working directory.
 */
const makeTempDir = trackTempDirs();

function client(fileMethodsOffered?: boolean) {
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
    ...(fileMethodsOffered === undefined ? {} : { fileMethodsOffered }),
  });
}

async function refusal(pending: unknown, code = -32602) {
  const error = await Promise.resolve(pending).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RequestError);
  expect((error as RequestError).code).toBe(code);
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

  test('an engine not offered the methods is refused: nothing is read or written for it', async () => {
    const dir = realpathSync(makeTempDir('acp-bridge-3957-'));
    writeFileSync(join(dir, 'kept.txt'), 'kept');
    const notOffered = client(false);
    const write = await refusal(
      notOffered.writeTextFile!({
        sessionId: 's',
        path: join(dir, 'kept.txt'),
        content: 'changed',
      }),
      -32601,
    );
    expect(write).toMatch(/did not offer the client file methods/);
    await refusal(
      notOffered.readTextFile!({ sessionId: 's', path: join(dir, 'kept.txt') }),
      -32601,
    );
    expect(readFileSync(join(dir, 'kept.txt'), 'utf8')).toBe('kept');
  });
});

describe('#3957 normalizedClientPath on Windows', () => {
  test.each([
    ['C:/Users/a/x.ts', 'C:\\Users\\a\\x.ts'],
    ['C:\\Users\\a\\x.ts', 'C:\\Users\\a\\x.ts'],
    ['C:/Users/a/../x.ts', undefined],
    ['C://Users/a/x.ts', undefined],
    ['Users/a/x.ts', undefined],
  ])('%s -> %s', (input, expected) => {
    expect(normalizedClientPath(input, win32)).toBe(expected);
  });
});
