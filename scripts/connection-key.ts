import { isAbsolute } from 'node:path';
import {
  formatStationConnectionKeyConfirmationCode,
  stationConnectionKeyConfirmationCode,
} from '@kontourai/station-shared/connection-proof';
import { base64url, calculateJwkThumbprint } from 'jose';
import { ConnectionKeyCandidateIssuer } from '../src-server/services/ssh/connection-key-candidate-issuer.js';
import { ConnectionSigningKeyStore } from '../src-server/services/ssh/connection-signing-key-store.js';

const SCHEMA = 'station.connection-key/v1';
const FINGERPRINT_SCHEMA = 'station.connection-key-fingerprint/v1';
const CANDIDATE_SCHEMA = 'station.connection-key-candidate-report/v1';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USAGE =
  'Usage: npm run connection:key -- <inspect|initialize|rotate|fingerprint|candidate> --home=<absolute-existing-home> [--expected-generation=<integer> --expected-key-id=<JWK-thumbprint> --acknowledge-device-reapproval] [--expected-station-id=<uuid> --expected-enrollment-id=<uuid> --broker-origin=<origin> --challenge=<32-byte-base64url> --client-instance-id=<uuid> --client-key-thumbprint=<JWK-thumbprint>]';

type ParsedCommand =
  | { operation: 'inspect' | 'initialize' | 'fingerprint'; home: string }
  | { operation: 'rotate'; home: string; generation: number; keyId: string }
  | ({ operation: 'candidate'; home: string } & CandidateOptions);

interface CandidateOptions {
  expectedStationId: string;
  expectedEnrollmentId: string;
  brokerOrigin: string;
  challenge: string;
  clientInstanceId: string;
  clientKeyThumbprint: string;
}

function parse(args: string[]): ParsedCommand {
  const [inputOperation, ...options] = args;
  if (
    !['inspect', 'initialize', 'rotate', 'fingerprint', 'candidate'].includes(
      inputOperation,
    )
  )
    throw new Error('invalid_arguments');
  const operation = inputOperation as ParsedCommand['operation'];
  const allowed = allowedOptions(operation);
  const values = new Map<string, string>();
  for (const option of options) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(option);
    if (!match || !allowed.includes(match[1]) || values.has(match[1]))
      throw new Error('invalid_arguments');
    const [, key, value] = match;
    if (key === 'acknowledge-device-reapproval' ? value !== undefined : !value)
      throw new Error('invalid_arguments');
    values.set(key, value ?? 'true');
  }
  const home = values.get('home');
  if (!home || !isAbsolute(home) || home.includes('\0'))
    throw new Error('invalid_arguments');
  if (operation === 'rotate')
    return { operation, home, ...parseRotationOptions(values) };
  if (operation === 'candidate')
    return { operation, home, ...parseCandidateOptions(values) };
  return { operation, home };
}

function allowedOptions(operation: ParsedCommand['operation']): string[] {
  if (operation === 'rotate')
    return [
      'home',
      'expected-generation',
      'expected-key-id',
      'acknowledge-device-reapproval',
    ];
  if (operation === 'candidate')
    return [
      'home',
      'expected-station-id',
      'expected-enrollment-id',
      'broker-origin',
      'challenge',
      'client-instance-id',
      'client-key-thumbprint',
    ];
  return ['home'];
}

function parseRotationOptions(values: Map<string, string>) {
  const generation = values.get('expected-generation');
  const keyId = values.get('expected-key-id');
  if (
    !generation ||
    !/^[1-9][0-9]*$/.test(generation) ||
    !Number.isSafeInteger(Number(generation)) ||
    !keyId ||
    !/^[A-Za-z0-9_-]{43}$/.test(keyId) ||
    values.get('acknowledge-device-reapproval') !== 'true'
  )
    throw new Error('invalid_arguments');
  return { generation: Number(generation), keyId };
}

function parseCandidateOptions(values: Map<string, string>): CandidateOptions {
  const expectedStationId = values.get('expected-station-id');
  const expectedEnrollmentId = values.get('expected-enrollment-id');
  const brokerOrigin = values.get('broker-origin');
  const challenge = values.get('challenge');
  const clientInstanceId = values.get('client-instance-id');
  const clientKeyThumbprint = values.get('client-key-thumbprint');
  if (
    !expectedStationId ||
    !UUID.test(expectedStationId) ||
    !expectedEnrollmentId ||
    !UUID.test(expectedEnrollmentId) ||
    !brokerOrigin ||
    !isBrokerOrigin(brokerOrigin) ||
    !challenge ||
    !isCanonical32ByteBase64Url(challenge) ||
    !clientInstanceId ||
    !UUID.test(clientInstanceId) ||
    !clientKeyThumbprint ||
    !isCanonical32ByteBase64Url(clientKeyThumbprint)
  )
    throw new Error('invalid_arguments');
  return {
    expectedStationId,
    expectedEnrollmentId,
    brokerOrigin,
    challenge,
    clientInstanceId,
    clientKeyThumbprint,
  };
}

function isCanonical32ByteBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const bytes = base64url.decode(value);
    return bytes.byteLength === 32 && base64url.encode(bytes) === value;
  } catch {
    return false;
  }
}

function isBrokerOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
    url.hostname.toLowerCase(),
  );
  return (
    url.origin === value &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
  );
}

async function run() {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log(USAGE);
    return;
  }
  // Parse completely before opening a home. No default home, account lookup,
  // listener, secret export, or remote authorization path exists here.
  const parsed = parse(process.argv.slice(2));
  const { operation, home } = parsed;
  const store = new ConnectionSigningKeyStore(home);
  let trust = store.readDescriptor();
  if (operation === 'candidate') {
    const issuer = new ConnectionKeyCandidateIssuer(store);
    const issued = await issuer.issue({
      brokerOrigin: parsed.brokerOrigin,
      expectedStationId: parsed.expectedStationId,
      expectedEnrollmentId: parsed.expectedEnrollmentId,
      challenge: parsed.challenge,
      clientInstanceId: parsed.clientInstanceId,
      clientKeyThumbprint: parsed.clientKeyThumbprint,
    });
    process.stdout.write(
      `${JSON.stringify({
        schema: CANDIDATE_SCHEMA,
        operation,
        status: 'present',
        candidate: issued.candidate,
        keyId: issued.keyId,
        confirmationCode: formatStationConnectionKeyConfirmationCode(
          issued.confirmationCode,
        ),
        expiresAt: issued.expiresAt,
      })}\n`,
    );
    return;
  }
  if (operation === 'fingerprint') {
    if (!trust) {
      process.stdout.write(
        `${JSON.stringify({ schema: FINGERPRINT_SCHEMA, operation, status: 'absent' })}\n`,
      );
      process.exitCode = 2;
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        schema: FINGERPRINT_SCHEMA,
        operation,
        status: 'present',
        stationId: trust.stationId,
        enrollmentId: trust.enrollmentId,
        generation: trust.generation,
        keyId: await calculateJwkThumbprint(trust.signingKey),
        confirmationCode: formatStationConnectionKeyConfirmationCode(
          await stationConnectionKeyConfirmationCode(trust),
        ),
      })}\n`,
    );
    return;
  }
  if (operation === 'initialize') trust = await store.initialize();
  else if (operation === 'rotate') {
    if (!trust) throw new Error('key_store_missing');
    if (
      trust.generation !== parsed.generation ||
      (await calculateJwkThumbprint(trust.signingKey)) !== parsed.keyId
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
    'candidate_invalid',
    'candidate_stale',
    'candidate_key_unavailable',
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
