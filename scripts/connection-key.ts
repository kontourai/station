import { isAbsolute } from 'node:path';
import { calculateJwkThumbprint } from 'jose';
import { ConnectionSigningKeyStore } from '../src-server/services/ssh/connection-signing-key-store.js';

const SCHEMA = 'station.connection-key/v1';
const USAGE =
  'Usage: npm run connection:key -- <inspect|initialize|rotate> --home=<absolute-existing-home> [--expected-generation=<integer> --expected-key-id=<JWK-thumbprint> --acknowledge-device-reapproval]';

function parse(args: string[]) {
  const [operation, ...options] = args;
  if (!['inspect', 'initialize', 'rotate'].includes(operation))
    throw new Error('invalid_arguments');
  const values = new Map<string, string>();
  const allowed = new Set(
    operation === 'rotate'
      ? [
          'home',
          'expected-generation',
          'expected-key-id',
          'acknowledge-device-reapproval',
        ]
      : ['home'],
  );
  for (const option of options) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(option);
    if (!match || !allowed.has(match[1]) || values.has(match[1]))
      throw new Error('invalid_arguments');
    const [, key, value] = match;
    if (key === 'acknowledge-device-reapproval' ? value !== undefined : !value)
      throw new Error('invalid_arguments');
    values.set(key, value ?? 'true');
  }
  const home = values.get('home');
  if (!home || !isAbsolute(home) || home.includes('\0'))
    throw new Error('invalid_arguments');
  const generation = values.get('expected-generation');
  const keyId = values.get('expected-key-id');
  if (
    operation === 'rotate' &&
    (!generation ||
      !/^[1-9][0-9]*$/.test(generation) ||
      !Number.isSafeInteger(Number(generation)) ||
      !keyId ||
      !/^[A-Za-z0-9_-]{43}$/.test(keyId) ||
      values.get('acknowledge-device-reapproval') !== 'true')
  )
    throw new Error('invalid_arguments');
  return { operation, home, generation: Number(generation), keyId };
}

async function run() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log(USAGE);
    return;
  }
  // Parse completely before opening a home. No default home, account lookup,
  // listener, secret export, or remote authorization path exists here.
  const { operation, home, generation, keyId } = parse(process.argv.slice(2));
  const store = new ConnectionSigningKeyStore(home);
  let trust = store.readDescriptor();
  if (operation === 'initialize') trust = await store.initialize();
  else if (operation === 'rotate') {
    if (!trust) throw new Error('key_store_missing');
    if (
      trust.generation !== generation ||
      (await calculateJwkThumbprint(trust.signingKey)) !== keyId
    )
      throw new Error('key_generation_conflict');
    trust = await store.rotate(trust);
  }
  if (!trust) {
    console.log(
      JSON.stringify({ schema: SCHEMA, operation, status: 'absent' }),
    );
    process.exitCode = 2;
    return;
  }
  console.log(
    JSON.stringify({
      schema: SCHEMA,
      operation,
      status: 'present',
      trust,
      keyId: await calculateJwkThumbprint(trust.signingKey),
    }),
  );
}

void run().catch((error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : '';
  const known = [
    'invalid_arguments',
    'key_store_missing',
    'key_store_invalid',
    'key_generation_conflict',
  ];
  const reason =
    known.find((value) => value === code || value === message) ??
    'key_unavailable';
  // Filesystem and parser exceptions may contain private paths or input.
  // Report only closed reason codes; never serialize the exception or cause.
  console.error(JSON.stringify({ schema: SCHEMA, status: 'refused', reason }));
  if (reason === 'invalid_arguments') console.error(USAGE);
  process.exitCode = 1;
});
