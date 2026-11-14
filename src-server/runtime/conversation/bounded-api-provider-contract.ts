import { createHash } from 'node:crypto';
import {
  REPORT_INPUT_TOOL_NAME,
  readReportInputQuestion,
  reportInputToolDefinition,
} from './report-input-profile.js';

export type BoundedApiProvider = 'anthropic' | 'google';
export type BoundedApiContractFailure =
  | 'untrusted_contract'
  | 'invalid_contract'
  | 'stale_contract'
  | 'binding_mismatch'
  | 'unsupported_wire'
  | 'insufficient_envelope'
  | 'usage_unknown';

export class BoundedApiProviderContractError extends Error {
  constructor(readonly code: BoundedApiContractFailure) {
    super(`Bounded API provider contract refused: ${code}`);
    this.name = 'BoundedApiProviderContractError';
  }
}

/** Current host selection for provider-inference-before-tax tariff accounting.
 * This binding neither authenticates an invoice account nor proves model entitlement. */
export interface BoundedApiProviderBinding {
  provider: BoundedApiProvider;
  endpointUrl: string;
  apiVersion: string;
  modelId: string;
  modelRevision: string;
  connectionId: string;
  connectionRevision: string;
  credentialRevision: string;
  principalId: string;
  /** Station tenancy scope, not a provider organization or invoice identity. */
  tenantId: string;
  sourceId: string;
  sourceRevision: string;
  optionsSha256: string;
  /** Exact wire-producing distribution; native profiles name the platform package. */
  sdkPackage: string;
  sdkVersion: string;
}

/** Expected from server-owned native image preparation, never from a route DTO. */
export interface BoundedNativeProducerBinding {
  engine: 'claude';
  cliVersion: string;
  executableSha256: string;
  imageId: string;
  preparationSha256: string;
}

/** Trusted SERVER capability, never a deserialized client value or request option.
 * The real host owner must approve exact bytes only after checking provider
 * authority, complete framing/cache input bound, unbilled over-limit rejection,
 * inclusive output cap, pinned revision, no hidden work and the FULL tariff.
 * A digest authenticates nothing by itself. There is intentionally no issuer,
 * default registry, environment fallback, or entitlement upgrade in this module.
 */
export interface BoundedApiQualificationRegistryOwner {
  read(id: string):
    | Readonly<{
        serializedContract: string;
        contractSha256: string;
        authorityKind: 'provider-public-contract';
        authorityRef: string;
        evidenceRevision: string;
        sourceSha256s: readonly string[];
        validFromMs: number;
        expiresAtMs: number;
      }>
    | undefined;
}

export interface BoundedApiFinalWire {
  url: string;
  method: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  redirect: 'error';
  /** Assigned by the physical-attempt owner, not copied from a request body. */
  requestOrdinal: number;
}

export interface BoundedApiRemainingEnvelope {
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  currency: 'USD';
}

export interface ResolvedBoundedApiProviderContract {
  readonly id: string;
  readonly revision: string;
  readonly contractSha256: string;
  readonly evidenceDigest: string;
}

export interface BoundedApiAttemptQuote {
  readonly contractId: string;
  readonly contractRevision: string;
  readonly contractSha256: string;
  readonly evidenceDigest: string;
  readonly wireSha256: string;
  readonly inputUpperBoundTokens: number;
  readonly outputUpperBoundTokens: number;
  readonly costMicros: number;
  readonly currency: 'USD';
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
type Rational = Readonly<{ n: bigint; d: bigint }>;
type Band = Readonly<{
  min: number;
  max: number;
  input: Rational;
  cacheRead: Rational;
  cacheWrite5m: Rational;
  cacheWrite1h: Rational;
  output: Rational;
}>;
type Facts = Readonly<{
  profile:
    | 'direct-text-single-request-v1'
    | 'report-input-single-request-v1'
    | 'native-text-single-request-v1';
  nativeProducer?: Readonly<BoundedNativeProducerBinding>;
  binding: BoundedApiProviderBinding;
  maxInput: number;
  maxOutput: number;
  thinkingModes: readonly string[];
  /** Approved exact-model semantics; absence does not qualify budget zero. */
  thinkingBudgetZero:
    | 'disables-thinking'
    | 'does-not-disable-thinking'
    | undefined;
  cacheMode: 'none' | 'anthropic-ephemeral' | 'google-implicit';
  bands: readonly Band[];
  fixedFee: Rational;
  validFrom: number;
  expiresAt: number;
}>;
type State = {
  facts: Facts;
  owner: BoundedApiQualificationRegistryOwner;
  registryDigest: string;
  qualification: NonNullable<
    ReturnType<BoundedApiQualificationRegistryOwner['read']>
  >;
};
const contracts = new WeakMap<ResolvedBoundedApiProviderContract, State>();
const quotes = new WeakMap<
  BoundedApiAttemptQuote,
  Readonly<{
    contract: ResolvedBoundedApiProviderContract;
    thinkingDisabled: boolean;
  }>
>();
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const BINDING_KEYS = [
  'provider',
  'endpointUrl',
  'apiVersion',
  'modelId',
  'modelRevision',
  'connectionId',
  'connectionRevision',
  'credentialRevision',
  'principalId',
  'tenantId',
  'sourceId',
  'sourceRevision',
  'optionsSha256',
  'sdkPackage',
  'sdkVersion',
] as const;

function fail(code: BoundedApiContractFailure): never {
  throw new BoundedApiProviderContractError(code);
}
function integer(
  value: unknown,
  code: BoundedApiContractFailure,
  min = 0,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < min
  )
    fail(code);
  return value;
}
function str(
  value: unknown,
  code: BoundedApiContractFailure,
  max = 1024,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Refuse control bytes in qualification identifiers.
    /[\u0000-\u001f]/u.test(value)
  )
    fail(code);
  return value;
}
function object(value: unknown, code: BoundedApiContractFailure): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(code);
  return value as Obj;
}
function closed(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: BoundedApiContractFailure,
): Obj {
  const result = object(value, code);
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    fail(code);
  return result;
}
function list(
  value: unknown,
  code: BoundedApiContractFailure,
  min = 0,
  max = 512,
): Json[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail(code);
  return value;
}
function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function digest(value: unknown, code: BoundedApiContractFailure): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(code);
  return value;
}
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Bounded JSON parser also refuses duplicate keys, prototype keys and nonfinite
 * numbers, so canonicalization cannot conceal unsupported fields. */
function parse(
  text: unknown,
  maxBytes: number,
  code: BoundedApiContractFailure,
): Json {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes)
    fail(code);
  let at = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(text[at] ?? '\0')) at++;
  };
  const string = (): string => {
    const start = at++;
    let escaped = false;
    while (at < text.length) {
      const char = text[at++];
      if (!escaped && char === '"') {
        try {
          return JSON.parse(text.slice(start, at)) as string;
        } catch {
          fail(code);
        }
      }
      if (!escaped && char === '\\') escaped = true;
      else escaped = false;
    }
    return fail(code);
  };
  const value = (depth: number): Json => {
    if (depth > 16 || ++nodes > 20000) fail(code);
    whitespace();
    const char = text[at];
    if (char === '"') return string();
    if (char === '{') {
      at++;
      const result: Obj = Object.create(null);
      whitespace();
      if (text[at] === '}') {
        at++;
        return result;
      }
      for (;;) {
        whitespace();
        if (text[at] !== '"') fail(code);
        const key = string();
        if (
          ['__proto__', 'prototype', 'constructor'].includes(key) ||
          Object.hasOwn(result, key)
        )
          fail(code);
        whitespace();
        if (text[at++] !== ':') fail(code);
        result[key] = value(depth + 1);
        whitespace();
        const end = text[at++];
        if (end === '}') return result;
        if (end !== ',') fail(code);
      }
    }
    if (char === '[') {
      at++;
      const result: Json[] = [];
      whitespace();
      if (text[at] === ']') {
        at++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        whitespace();
        const end = text[at++];
        if (end === ']') return result;
        if (end !== ',') fail(code);
      }
    }
    for (const [literal, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return result;
      }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      text.slice(at),
    );
    if (!token) fail(code);
    at += token[0].length;
    const result = Number(token[0]);
    if (!Number.isFinite(result)) fail(code);
    return result;
  };
  const result = value(0);
  whitespace();
  if (at !== text.length) fail(code);
  return result;
}

/** Native and SDK preparation share the same bounded, duplicate-refusing parser.
 * Parsing grants neither provider qualification nor source authority. */
export function parseBoundedApiRequestBody(serialized: string): unknown {
  return parse(serialized, 2 * 1024 * 1024, 'unsupported_wire');
}

function rational(value: unknown): Rational {
  const v = closed(value, ['numerator', 'denominator'], [], 'invalid_contract');
  const n = str(v.numerator, 'invalid_contract', 64);
  const d = str(v.denominator, 'invalid_contract', 64);
  if (!/^(0|[1-9]\d*)$/u.test(n) || !/^[1-9]\d*$/u.test(d))
    fail('invalid_contract');
  return { n: BigInt(n), d: BigInt(d) };
}
function plus(a: Rational, b: Rational): Rational {
  return { n: a.n * b.d + b.n * a.d, d: a.d * b.d };
}
function times(count: number, rate: Rational): Rational {
  return { n: BigInt(count) * rate.n, d: rate.d };
}
function maxRate(rates: readonly Rational[]): Rational {
  return rates.reduce((a, b) => (a.n * b.d >= b.n * a.d ? a : b));
}
function micros(rate: Rational, code: BoundedApiContractFailure): number {
  const result = (rate.n + rate.d - 1n) / rate.d;
  if (result > MAX_SAFE) fail(code);
  return Number(result);
}
function registryDigest(
  record: NonNullable<ReturnType<BoundedApiQualificationRegistryOwner['read']>>,
): string {
  return hash(
    canonical({
      contractSha256: record.contractSha256,
      authorityKind: record.authorityKind,
      authorityRef: record.authorityRef,
      evidenceRevision: record.evidenceRevision,
      sourceSha256s: [...record.sourceSha256s],
      validFromMs: record.validFromMs,
      expiresAtMs: record.expiresAtMs,
    }),
  );
}
function officialEndpoint(
  binding: BoundedApiProviderBinding,
  profile: Facts['profile'],
): void {
  const native = profile === 'native-text-single-request-v1';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(binding.modelId))
    fail('invalid_contract');
  if (binding.provider === 'anthropic') {
    if (
      binding.endpointUrl !== 'https://api.anthropic.com/v1/messages' ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(binding.apiVersion) ||
      binding.sdkPackage !==
        (native
          ? '@anthropic-ai/claude-agent-sdk-linux-arm64'
          : '@ai-sdk/anthropic')
    )
      fail('invalid_contract');
  } else if (binding.provider === 'google') {
    if (native) fail('invalid_contract');
    const base = `https://generativelanguage.googleapis.com/v1beta/models/${binding.modelId}`;
    if (
      ![
        `${base}:generateContent`,
        `${base}:streamGenerateContent?alt=sse`,
      ].includes(binding.endpointUrl) ||
      binding.apiVersion !== 'v1beta' ||
      binding.sdkPackage !== '@ai-sdk/google'
    )
      fail('invalid_contract');
  } else fail('invalid_contract');
}

/** Reads only an approved server record. This validates its shape/current binding;
 * it cannot establish the truth of a provider contract or generation entitlement. */
export function resolveBoundedApiProviderContract(
  id: string,
  expected: Readonly<BoundedApiProviderBinding>,
  owner: BoundedApiQualificationRegistryOwner,
  nowMs: number,
): ResolvedBoundedApiProviderContract {
  return resolveContract(id, expected, owner, nowMs);
}

// UNWIRED #91: production native source admission and reservation must use this distinct profile.
/** Native approval additionally binds the actual executable, image and preparer.
 * This validates a supplied approval; it cannot issue one or mint source authority. */
export function resolveBoundedNativeApiProviderContract(
  id: string,
  expected: Readonly<BoundedApiProviderBinding>,
  expectedProducer: Readonly<BoundedNativeProducerBinding>,
  owner: BoundedApiQualificationRegistryOwner,
  nowMs: number,
): ResolvedBoundedApiProviderContract {
  return resolveContract(
    id,
    expected,
    owner,
    nowMs,
    readNativeProducer(expectedProducer),
  );
}

function resolveContract(
  id: string,
  expected: Readonly<BoundedApiProviderBinding>,
  owner: BoundedApiQualificationRegistryOwner,
  nowMs: number,
  expectedProducer?: Readonly<BoundedNativeProducerBinding>,
): ResolvedBoundedApiProviderContract {
  integer(nowMs, 'invalid_contract');
  str(id, 'invalid_contract');
  const record = owner.read(id);
  if (!record) fail('untrusted_contract');
  const { facts, revision, evidenceDigest } = readQualifiedFacts(
    id,
    expected,
    record,
    nowMs,
  );
  if (
    expectedProducer
      ? JSON.stringify(facts.nativeProducer) !==
        JSON.stringify(expectedProducer)
      : facts.nativeProducer !== undefined
  )
    fail('binding_mismatch');
  const handle = Object.freeze({
    id,
    revision,
    contractSha256: record.contractSha256,
    evidenceDigest,
  });
  contracts.set(handle, {
    facts,
    owner,
    registryDigest: evidenceDigest,
    qualification: {
      serializedContract: record.serializedContract,
      contractSha256: record.contractSha256,
      authorityKind: record.authorityKind,
      authorityRef: record.authorityRef,
      evidenceRevision: record.evidenceRevision,
      sourceSha256s: [...record.sourceSha256s],
      validFromMs: record.validFromMs,
      expiresAtMs: record.expiresAtMs,
    },
  });
  return handle;
}

function readNativeProducer(
  value: unknown,
): Readonly<BoundedNativeProducerBinding> {
  const raw = closed(
    value,
    [
      'engine',
      'cliVersion',
      'executableSha256',
      'imageId',
      'preparationSha256',
    ],
    [],
    'invalid_contract',
  );
  if (
    raw.engine !== 'claude' ||
    !/^\d+\.\d+\.\d+$/.test(str(raw.cliVersion, 'invalid_contract')) ||
    !/^sha256:[a-f0-9]{64}$/.test(str(raw.imageId, 'invalid_contract'))
  )
    fail('invalid_contract');
  return Object.freeze({
    engine: 'claude',
    cliVersion: str(raw.cliVersion, 'invalid_contract'),
    executableSha256: digest(raw.executableSha256, 'invalid_contract'),
    imageId: str(raw.imageId, 'invalid_contract'),
    preparationSha256: digest(raw.preparationSha256, 'invalid_contract'),
  });
}

function contractProfile(value: unknown): Facts['profile'] {
  switch (value) {
    case 'direct-text-single-request-v1':
    case 'report-input-single-request-v1':
    case 'native-text-single-request-v1':
      return value;
    default:
      return fail('invalid_contract');
  }
}

function nativeProducerForRecord(
  profile: Facts['profile'],
  value: unknown,
  sources: readonly string[],
) {
  if (profile !== 'native-text-single-request-v1') {
    if (value !== undefined) fail('invalid_contract');
    return undefined;
  }
  const producer = readNativeProducer(value);
  if (
    [
      producer.executableSha256,
      producer.imageId.slice(7),
      producer.preparationSha256,
    ].some((source) => !sources.includes(source))
  )
    fail('untrusted_contract');
  return producer;
}

function readQualifiedFacts(
  id: string,
  expected: Readonly<BoundedApiProviderBinding>,
  record: NonNullable<ReturnType<BoundedApiQualificationRegistryOwner['read']>>,
  nowMs: number,
) {
  integer(nowMs, 'invalid_contract');
  str(id, 'invalid_contract');
  digest(record.contractSha256, 'untrusted_contract');
  if (record.authorityKind !== 'provider-public-contract')
    fail('untrusted_contract');
  str(record.authorityRef, 'untrusted_contract');
  str(record.evidenceRevision, 'untrusted_contract');
  if (
    !Array.isArray(record.sourceSha256s) ||
    record.sourceSha256s.length < 1 ||
    record.sourceSha256s.length > 16 ||
    new Set(record.sourceSha256s).size !== record.sourceSha256s.length
  )
    fail('untrusted_contract');
  record.sourceSha256s.forEach((value) => digest(value, 'untrusted_contract'));
  integer(record.validFromMs, 'untrusted_contract');
  integer(record.expiresAtMs, 'untrusted_contract', record.validFromMs + 1);
  if (nowMs < record.validFromMs || nowMs >= record.expiresAtMs)
    fail('stale_contract');
  if (
    typeof record.serializedContract !== 'string' ||
    hash(record.serializedContract) !== record.contractSha256
  )
    fail('untrusted_contract');
  const raw = closed(
    parse(record.serializedContract, 65536, 'invalid_contract'),
    ['schema', 'id', 'revision', 'binding', 'evidence', 'limits', 'tariff'],
    ['nativeProducer'],
    'invalid_contract',
  );
  const profile = contractProfile(raw.schema);
  if (raw.id !== id) fail('invalid_contract');
  const revision = str(raw.revision, 'invalid_contract');
  const bindingObject = closed(
    raw.binding,
    BINDING_KEYS,
    [],
    'invalid_contract',
  );
  const expectedObject = closed(expected, BINDING_KEYS, [], 'binding_mismatch');
  const fields = Object.fromEntries(
    BINDING_KEYS.map((key) => [
      key,
      str(bindingObject[key], 'invalid_contract'),
    ]),
  );
  BINDING_KEYS.forEach((key) => {
    if (fields[key] !== expectedObject[key]) fail('binding_mismatch');
  });
  const provider = fields.provider;
  if (provider !== 'anthropic' && provider !== 'google')
    fail('invalid_contract');
  const binding: BoundedApiProviderBinding = {
    provider,
    endpointUrl: fields.endpointUrl,
    apiVersion: fields.apiVersion,
    modelId: fields.modelId,
    modelRevision: fields.modelRevision,
    connectionId: fields.connectionId,
    connectionRevision: fields.connectionRevision,
    credentialRevision: fields.credentialRevision,
    principalId: fields.principalId,
    tenantId: fields.tenantId,
    sourceId: fields.sourceId,
    sourceRevision: fields.sourceRevision,
    optionsSha256: fields.optionsSha256,
    sdkPackage: fields.sdkPackage,
    sdkVersion: fields.sdkVersion,
  };
  const nativeProducer = nativeProducerForRecord(
    profile,
    raw.nativeProducer,
    record.sourceSha256s,
  );
  officialEndpoint(binding, profile);
  digest(binding.optionsSha256, 'invalid_contract');
  const evidence = closed(
    raw.evidence,
    [
      'authorityKind',
      'authorityRef',
      'revision',
      'sourceSha256s',
      'validFromMs',
      'expiresAtMs',
    ],
    [],
    'invalid_contract',
  );
  if (
    evidence.authorityKind !== 'provider-public-contract' ||
    evidence.authorityRef !== record.authorityRef ||
    evidence.revision !== record.evidenceRevision ||
    canonical(evidence.sourceSha256s!) !==
      canonical([...record.sourceSha256s]) ||
    evidence.validFromMs !== record.validFromMs ||
    evidence.expiresAtMs !== record.expiresAtMs
  )
    fail('untrusted_contract');
  const limits = closed(
    raw.limits,
    ['inputTokens', 'outputTokens', 'thinkingModes'],
    ['thinkingBudgetZero'],
    'invalid_contract',
  );
  const maxInput = integer(limits.inputTokens, 'invalid_contract', 1);
  const maxOutput = integer(limits.outputTokens, 'invalid_contract', 1);
  const thinkingModes = list(
    limits.thinkingModes,
    'invalid_contract',
    1,
    8,
  ).map((v) => str(v, 'invalid_contract', 32));
  const allowedModes =
    binding.provider === 'anthropic'
      ? ['disabled', 'adaptive', 'enabled', 'omitted']
      : ['budget', 'level', 'omitted'];
  if (
    new Set(thinkingModes).size !== thinkingModes.length ||
    thinkingModes.some((v) => !allowedModes.includes(v))
  )
    fail('invalid_contract');
  const thinkingBudgetZero = limits.thinkingBudgetZero;
  if (
    thinkingBudgetZero !== undefined &&
    (binding.provider !== 'google' ||
      !thinkingModes.includes('budget') ||
      (thinkingBudgetZero !== 'disables-thinking' &&
        thinkingBudgetZero !== 'does-not-disable-thinking'))
  )
    fail('invalid_contract');
  const tariff = closed(
    raw.tariff,
    [
      'currency',
      'scope',
      'geography',
      'serviceTier',
      'speed',
      'cacheMode',
      'bands',
      'fixedFee',
    ],
    [],
    'invalid_contract',
  );
  if (
    tariff.currency !== 'USD' ||
    tariff.scope !== 'provider-inference-before-tax' ||
    tariff.geography !==
      (binding.provider === 'anthropic' ? 'global' : 'developer-api') ||
    tariff.serviceTier !== 'standard' ||
    tariff.speed !== 'standard'
  )
    fail('invalid_contract');
  const cacheMode = tariff.cacheMode;
  if (
    cacheMode !== 'none' &&
    cacheMode !==
      (binding.provider === 'anthropic'
        ? 'anthropic-ephemeral'
        : 'google-implicit')
  )
    fail('invalid_contract');
  const bands = list(tariff.bands, 'invalid_contract', 1, 32).map((value) => {
    const band = closed(
      value,
      ['minInputTokens', 'maxInputTokens', 'rates'],
      [],
      'invalid_contract',
    );
    const rates = closed(
      band.rates,
      ['input', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'output'],
      [],
      'invalid_contract',
    );
    const min = integer(band.minInputTokens, 'invalid_contract');
    return {
      min,
      max: integer(band.maxInputTokens, 'invalid_contract', min),
      input: rational(rates.input),
      cacheRead: rational(rates.cacheRead),
      cacheWrite5m: rational(rates.cacheWrite5m),
      cacheWrite1h: rational(rates.cacheWrite1h),
      output: rational(rates.output),
    };
  });
  let next = 0n;
  for (const band of bands) {
    if (BigInt(band.min) !== next || band.max > maxInput)
      fail('invalid_contract');
    next = BigInt(band.max) + 1n;
  }
  if (next !== BigInt(maxInput) + 1n) fail('invalid_contract');
  if (
    profile === 'report-input-single-request-v1' &&
    (binding.provider !== 'anthropic' ||
      thinkingModes.length !== 1 ||
      thinkingModes[0] !== 'omitted')
  )
    fail('invalid_contract');
  const facts: Facts = {
    profile,
    nativeProducer,
    binding: Object.freeze(binding),
    maxInput,
    maxOutput,
    thinkingModes: Object.freeze(thinkingModes),
    thinkingBudgetZero,
    cacheMode,
    bands,
    fixedFee: rational(tariff.fixedFee),
    validFrom: record.validFromMs,
    expiresAt: record.expiresAtMs,
  };
  const evidenceDigest = registryDigest(record);
  return { facts, revision, evidenceDigest };
}

function current(
  handle: ResolvedBoundedApiProviderContract,
  nowMs: number,
): Facts {
  const state = contracts.get(handle);
  if (!state) fail('untrusted_contract');
  integer(nowMs, 'invalid_contract');
  if (nowMs < state.facts.validFrom || nowMs >= state.facts.expiresAt)
    fail('stale_contract');
  const record = state.owner.read(handle.id);
  if (
    !record ||
    registryDigest(record) !== state.registryDigest ||
    hash(record.serializedContract) !== handle.contractSha256
  )
    fail('untrusted_contract');
  return state.facts;
}

/** Inert original pricing evidence; deserialization grants no execution capability. */
export function captureBoundedApiHistoricalPricing(
  contract: ResolvedBoundedApiProviderContract,
  quote: BoundedApiAttemptQuote,
  pricedAtMs: number,
): string {
  current(contract, pricedAtMs);
  const state = contracts.get(contract);
  const quoted = quotes.get(quote);
  if (!state || quoted?.contract !== contract) fail('usage_unknown');
  const serialized = JSON.stringify({
    version: 1,
    qualification: state.qualification,
    pricedAtMs,
    quote,
    thinkingDisabled: quoted.thinkingDisabled,
  });
  if (Buffer.byteLength(serialized, 'utf8') > 128 * 1024) fail('usage_unknown');
  return serialized;
}

/** Re-audits caller-authenticated private evidence; this does not authenticate its provenance
 * or register a contract/quote for execution. Current registry state is deliberately unused. */
export function priceBoundedApiHistoricalRawUsage(
  historicalPricingJson: string,
  expectedQuote: BoundedApiAttemptQuote,
  completeResponseJson: string,
) {
  try {
    const historical = closed(
      parse(historicalPricingJson, 128 * 1024, 'usage_unknown'),
      ['version', 'qualification', 'pricedAtMs', 'quote', 'thinkingDisabled'],
      [],
      'usage_unknown',
    );
    if (
      historical.version !== 1 ||
      typeof historical.thinkingDisabled !== 'boolean'
    )
      fail('usage_unknown');
    const rawQuote = closed(
      historical.quote,
      [
        'contractId',
        'contractRevision',
        'contractSha256',
        'evidenceDigest',
        'wireSha256',
        'inputUpperBoundTokens',
        'outputUpperBoundTokens',
        'costMicros',
        'currency',
      ],
      [],
      'usage_unknown',
    );
    if (
      canonical(rawQuote) !==
        canonical(
          parse(JSON.stringify(expectedQuote), 8192, 'usage_unknown'),
        ) ||
      rawQuote.currency !== 'USD'
    )
      fail('usage_unknown');
    const quote: BoundedApiAttemptQuote = {
      contractId: str(rawQuote.contractId, 'usage_unknown'),
      contractRevision: str(rawQuote.contractRevision, 'usage_unknown'),
      contractSha256: digest(rawQuote.contractSha256, 'usage_unknown'),
      evidenceDigest: digest(rawQuote.evidenceDigest, 'usage_unknown'),
      wireSha256: digest(rawQuote.wireSha256, 'usage_unknown'),
      inputUpperBoundTokens: integer(
        rawQuote.inputUpperBoundTokens,
        'usage_unknown',
      ),
      outputUpperBoundTokens: integer(
        rawQuote.outputUpperBoundTokens,
        'usage_unknown',
      ),
      costMicros: integer(rawQuote.costMicros, 'usage_unknown'),
      currency: 'USD',
    };
    const rawRecord = closed(
      historical.qualification,
      [
        'serializedContract',
        'contractSha256',
        'authorityKind',
        'authorityRef',
        'evidenceRevision',
        'sourceSha256s',
        'validFromMs',
        'expiresAtMs',
      ],
      [],
      'usage_unknown',
    );
    if (
      typeof rawRecord.serializedContract !== 'string' ||
      rawRecord.authorityKind !== 'provider-public-contract'
    )
      fail('usage_unknown');
    const record: NonNullable<
      ReturnType<BoundedApiQualificationRegistryOwner['read']>
    > = {
      serializedContract: rawRecord.serializedContract,
      contractSha256: digest(rawRecord.contractSha256, 'usage_unknown'),
      authorityKind: rawRecord.authorityKind,
      authorityRef: str(rawRecord.authorityRef, 'usage_unknown'),
      evidenceRevision: str(rawRecord.evidenceRevision, 'usage_unknown'),
      sourceSha256s: list(rawRecord.sourceSha256s, 'usage_unknown', 1, 16).map(
        (value) => digest(value, 'usage_unknown'),
      ),
      validFromMs: integer(rawRecord.validFromMs, 'usage_unknown'),
      expiresAtMs: integer(rawRecord.expiresAtMs, 'usage_unknown'),
    };
    const serialized = closed(
      parse(record.serializedContract, 65536, 'usage_unknown'),
      ['schema', 'id', 'revision', 'binding', 'evidence', 'limits', 'tariff'],
      ['nativeProducer'],
      'usage_unknown',
    );
    const rawBinding = closed(
      serialized.binding,
      BINDING_KEYS,
      [],
      'usage_unknown',
    );
    const binding: BoundedApiProviderBinding = {
      provider:
        rawBinding.provider === 'anthropic'
          ? 'anthropic'
          : rawBinding.provider === 'google'
            ? 'google'
            : fail('usage_unknown'),
      endpointUrl: str(rawBinding.endpointUrl, 'usage_unknown'),
      apiVersion: str(rawBinding.apiVersion, 'usage_unknown'),
      modelId: str(rawBinding.modelId, 'usage_unknown'),
      modelRevision: str(rawBinding.modelRevision, 'usage_unknown'),
      connectionId: str(rawBinding.connectionId, 'usage_unknown'),
      connectionRevision: str(rawBinding.connectionRevision, 'usage_unknown'),
      credentialRevision: str(rawBinding.credentialRevision, 'usage_unknown'),
      principalId: str(rawBinding.principalId, 'usage_unknown'),
      tenantId: str(rawBinding.tenantId, 'usage_unknown'),
      sourceId: str(rawBinding.sourceId, 'usage_unknown'),
      sourceRevision: str(rawBinding.sourceRevision, 'usage_unknown'),
      optionsSha256: digest(rawBinding.optionsSha256, 'usage_unknown'),
      sdkPackage: str(rawBinding.sdkPackage, 'usage_unknown'),
      sdkVersion: str(rawBinding.sdkVersion, 'usage_unknown'),
    };
    const { facts, revision, evidenceDigest } = readQualifiedFacts(
      quote.contractId,
      binding,
      record,
      integer(historical.pricedAtMs, 'usage_unknown'),
    );
    if (
      revision !== quote.contractRevision ||
      record.contractSha256 !== quote.contractSha256 ||
      evidenceDigest !== quote.evidenceDigest
    )
      fail('usage_unknown');
    return priceRawUsage(
      facts,
      quote,
      historical.thinkingDisabled,
      completeResponseJson,
    );
  } catch {
    return fail('usage_unknown');
  }
}

/** Complete bounded JSON only; duplicate fields never become executable arguments. */
export function parseReportInputArguments(serialized: string): {
  question: string;
} {
  try {
    const input = parse(serialized, 8192, 'usage_unknown');
    return { question: readReportInputQuestion(input) };
  } catch {
    return fail('usage_unknown');
  }
}

/** Parses the raw counterpart of an input request; this DTO grants no effect authority. */
export function readBoundedApiReportInput(
  contract: ResolvedBoundedApiProviderContract,
  completeResponseJson: string,
  nowMs: number,
): Readonly<{ id: string; question: string }> | undefined {
  const facts = current(contract, nowMs);
  if (facts.profile !== 'report-input-single-request-v1') return undefined;
  const response = object(
    parse(completeResponseJson, 8 * 1024 * 1024, 'usage_unknown'),
    'usage_unknown',
  );
  anthropicResponseScope(response, facts, true);
  for (const value of list(response.content, 'usage_unknown', 0, 2048)) {
    const block = object(value, 'usage_unknown');
    if (block.type === 'tool_use')
      return Object.freeze({
        id: str(block.id, 'usage_unknown', 128),
        question: readReportInputQuestion(block.input),
      });
  }
  return undefined;
}

/** Observes an already authenticated profile; it cannot issue or widen one. */
export function boundedApiUsesReportInput(
  contract: ResolvedBoundedApiProviderContract,
  nowMs: number,
): boolean {
  return current(contract, nowMs).profile === 'report-input-single-request-v1';
}

/** Credential/source observation is separate from provider qualification; both must match. */
export function assertBoundedApiCredentialBinding(
  handle: ResolvedBoundedApiProviderContract,
  observed: Pick<
    BoundedApiProviderBinding,
    'provider' | 'connectionId' | 'connectionRevision' | 'credentialRevision'
  >,
  nowMs: number,
): void {
  const facts = current(handle, nowMs);
  for (const key of [
    'provider',
    'connectionId',
    'connectionRevision',
    'credentialRevision',
  ] as const)
    if (facts.binding[key] !== observed[key]) fail('binding_mismatch');
}

/** SDK source preparation cannot consume an approval for a native producer. */
export function assertBoundedApiSdkProfile(
  handle: ResolvedBoundedApiProviderContract,
  nowMs: number,
): void {
  if (current(handle, nowMs).nativeProducer !== undefined)
    fail('binding_mismatch');
}

function wireHeaders(
  provider: BoundedApiProvider,
  wire: BoundedApiFinalWire,
): Obj {
  const headers: Obj = Object.create(null);
  const keyHeader = provider === 'anthropic' ? 'x-api-key' : 'x-goog-api-key';
  for (const [key, value] of Object.entries(wire.headers)) {
    const lower = key.toLowerCase();
    if (
      Object.hasOwn(headers, lower) ||
      ![
        'content-type',
        keyHeader,
        'user-agent',
        ...(provider === 'anthropic' ? ['anthropic-version'] : []),
      ].includes(lower)
    )
      fail('unsupported_wire');
    headers[lower] = str(value, 'unsupported_wire', 16384);
  }
  if (
    headers['content-type'] !== 'application/json' ||
    typeof headers[keyHeader] !== 'string'
  )
    fail('unsupported_wire');
  delete headers[keyHeader]; // Secrets never enter any digest, quote or error.
  delete headers['user-agent'];
  return headers;
}

function optionsDigest(
  provider: BoundedApiProvider,
  wire: BoundedApiFinalWire,
  body: Obj,
): string {
  const excluded =
    provider === 'anthropic'
      ? ['messages', 'system']
      : ['contents', 'systemInstruction'];
  const options = Object.fromEntries(
    Object.entries(body).filter(([key]) => !excluded.includes(key)),
  );
  return hash(
    canonical({
      url: wire.url,
      method: wire.method,
      headers: wireHeaders(provider, wire),
      body: options,
    }),
  );
}

/** Used by the trusted options owner to bind final non-prompt wire options. It
 * creates no qualification; resolve still requires approved registry bytes. */
export function boundedApiWireOptionsSha256(
  provider: BoundedApiProvider,
  wire: BoundedApiFinalWire,
): string {
  if (provider !== 'anthropic' && provider !== 'google')
    fail('unsupported_wire');
  return optionsDigest(
    provider,
    wire,
    object(
      parse(wire.body, 8 * 1024 * 1024, 'unsupported_wire'),
      'unsupported_wire',
    ),
  );
}

function sampling(body: Obj, keys: readonly string[]): void {
  for (const key of keys) {
    if (!Object.hasOwn(body, key)) continue;
    const value = body[key];
    if (typeof value !== 'number' || !Number.isFinite(value))
      fail('unsupported_wire');
    if (key === 'top_k' || key === 'topK')
      integer(value, 'unsupported_wire', 1);
    else if (key === 'seed') integer(value, 'unsupported_wire');
    else if (key === 'temperature') {
      if (value < 0 || value > 2) fail('unsupported_wire');
    } else if (value < 0 || value > 1) fail('unsupported_wire');
  }
}
function cacheControl(value: unknown, facts: Facts): void {
  const cache = closed(value, ['type'], ['ttl'], 'unsupported_wire');
  if (
    facts.cacheMode !== 'anthropic-ephemeral' ||
    cache.type !== 'ephemeral' ||
    (cache.ttl !== undefined && cache.ttl !== '5m' && cache.ttl !== '1h')
  )
    fail('unsupported_wire');
}
function textParts(
  value: unknown,
  provider: BoundedApiProvider,
  facts: Facts,
): void {
  if (typeof value === 'string' && provider === 'anthropic') return;
  for (const valuePart of list(value, 'unsupported_wire', 1, 1024)) {
    const part = closed(
      valuePart,
      provider === 'anthropic' ? ['type', 'text'] : ['text'],
      provider === 'anthropic' ? ['cache_control'] : [],
      'unsupported_wire',
    );
    if (
      (provider === 'anthropic' && part.type !== 'text') ||
      typeof part.text !== 'string'
    )
      fail('unsupported_wire');
    if (part.cache_control !== undefined)
      cacheControl(part.cache_control, facts);
  }
}
function stops(value: unknown): void {
  list(value, 'unsupported_wire', 1, 16).forEach((v) =>
    str(v, 'unsupported_wire', 1024),
  );
}
function outputCap(body: Obj, facts: Facts): number {
  const { binding } = facts;
  if (binding.provider === 'anthropic') {
    if (facts.profile === 'report-input-single-request-v1') {
      closed(
        body,
        [
          'model',
          'max_tokens',
          'messages',
          'inference_geo',
          'service_tier',
          'stream',
          'tools',
          'tool_choice',
        ],
        [],
        'unsupported_wire',
      );
      if (
        body.stream !== true ||
        canonical(body.tools) !== canonical([reportInputToolDefinition()]) ||
        canonical(body.tool_choice) !==
          canonical({ type: 'auto', disable_parallel_tool_use: true })
      )
        fail('unsupported_wire');
    }
    closed(
      body,
      [
        'model',
        'max_tokens',
        'messages',
        'inference_geo',
        'service_tier',
        ...(facts.nativeProducer ? ['tools', 'stream'] : []),
      ],
      [
        'system',
        'stream',
        'thinking',
        'speed',
        'temperature',
        'top_p',
        'top_k',
        'stop_sequences',
        'cache_control',
        'output_config',
        ...(facts.profile === 'report-input-single-request-v1'
          ? ['tools', 'tool_choice']
          : []),
      ],
      'unsupported_wire',
    );
    if (
      facts.nativeProducer &&
      (body.stream !== true || canonical(body.tools ?? null) !== '[]')
    )
      fail('unsupported_wire');
    if (
      body.model !== binding.modelId ||
      body.inference_geo !== 'global' ||
      body.service_tier !== 'standard_only' ||
      (body.speed !== undefined && body.speed !== 'standard') ||
      (body.stream !== undefined && typeof body.stream !== 'boolean')
    )
      fail('unsupported_wire');
    for (const value of list(body.messages, 'unsupported_wire', 1, 512)) {
      const message = closed(
        value,
        ['role', 'content'],
        [],
        'unsupported_wire',
      );
      if (message.role !== 'user' && message.role !== 'assistant')
        fail('unsupported_wire');
      textParts(message.content, 'anthropic', facts);
    }
    if (body.system !== undefined) textParts(body.system, 'anthropic', facts);
    if (body.cache_control !== undefined)
      cacheControl(body.cache_control, facts);
    const cap = integer(body.max_tokens, 'unsupported_wire', 1);
    if (body.thinking !== undefined) {
      const thinking = closed(
        body.thinking,
        ['type'],
        ['budget_tokens'],
        'unsupported_wire',
      );
      if (!facts.thinkingModes.includes(str(thinking.type, 'unsupported_wire')))
        fail('unsupported_wire');
      if (thinking.type === 'enabled') {
        if (integer(thinking.budget_tokens, 'unsupported_wire', 1024) >= cap)
          fail('unsupported_wire');
      } else if (thinking.budget_tokens !== undefined) fail('unsupported_wire');
    } else if (!facts.thinkingModes.includes('omitted'))
      fail('unsupported_wire');
    if (body.output_config !== undefined) {
      const config = closed(
        body.output_config,
        ['effort'],
        [],
        'unsupported_wire',
      );
      if (
        !['low', 'medium', 'high', 'xhigh', 'max'].includes(
          str(config.effort, 'unsupported_wire'),
        )
      )
        fail('unsupported_wire');
    }
    sampling(body, ['temperature', 'top_p', 'top_k']);
    if (body.stop_sequences !== undefined) stops(body.stop_sequences);
    return cap;
  }
  closed(
    body,
    ['contents', 'generationConfig', 'serviceTier'],
    ['systemInstruction'],
    'unsupported_wire',
  );
  if (body.serviceTier !== 'standard') fail('unsupported_wire');
  for (const value of list(body.contents, 'unsupported_wire', 1, 512)) {
    const content = closed(value, ['role', 'parts'], [], 'unsupported_wire');
    if (content.role !== 'user' && content.role !== 'model')
      fail('unsupported_wire');
    textParts(content.parts, 'google', facts);
  }
  if (body.systemInstruction !== undefined) {
    const system = closed(
      body.systemInstruction,
      ['parts'],
      [],
      'unsupported_wire',
    );
    textParts(system.parts, 'google', facts);
  }
  const config = closed(
    body.generationConfig,
    ['maxOutputTokens'],
    [
      'candidateCount',
      'thinkingConfig',
      'temperature',
      'topP',
      'topK',
      'seed',
      'stopSequences',
      'responseMimeType',
    ],
    'unsupported_wire',
  );
  if (
    (config.candidateCount !== undefined && config.candidateCount !== 1) ||
    (config.responseMimeType !== undefined &&
      config.responseMimeType !== 'text/plain')
  )
    fail('unsupported_wire');
  if (config.thinkingConfig !== undefined) {
    const thinking = closed(
      config.thinkingConfig,
      [],
      ['thinkingBudget', 'thinkingLevel', 'includeThoughts'],
      'unsupported_wire',
    );
    if (thinking.thinkingBudget !== undefined) {
      if (
        !facts.thinkingModes.includes('budget') ||
        thinking.thinkingLevel !== undefined ||
        typeof thinking.thinkingBudget !== 'number' ||
        !Number.isSafeInteger(thinking.thinkingBudget) ||
        thinking.thinkingBudget < -1
      )
        fail('unsupported_wire');
      if (
        thinking.thinkingBudget === 0 &&
        facts.thinkingBudgetZero === undefined
      )
        fail('unsupported_wire');
    } else if (thinking.thinkingLevel !== undefined) {
      if (
        !facts.thinkingModes.includes('level') ||
        !['minimal', 'low', 'medium', 'high'].includes(
          str(thinking.thinkingLevel, 'unsupported_wire'),
        )
      )
        fail('unsupported_wire');
    } else if (!facts.thinkingModes.includes('omitted'))
      fail('unsupported_wire');
    if (
      thinking.includeThoughts !== undefined &&
      typeof thinking.includeThoughts !== 'boolean'
    )
      fail('unsupported_wire');
  } else if (!facts.thinkingModes.includes('omitted')) fail('unsupported_wire');
  sampling(config, ['temperature', 'topP', 'topK', 'seed']);
  if (config.stopSequences !== undefined) stops(config.stopSequences);
  return integer(config.maxOutputTokens, 'unsupported_wire', 1);
}

export function quoteBoundedApiProviderAttempt(
  contract: ResolvedBoundedApiProviderContract,
  wire: BoundedApiFinalWire,
  remaining: Readonly<BoundedApiRemainingEnvelope>,
  nowMs: number,
): BoundedApiAttemptQuote {
  const facts = current(contract, nowMs);
  if (
    wire.url !== facts.binding.endpointUrl ||
    wire.method !== 'POST' ||
    wire.redirect !== 'error' ||
    wire.requestOrdinal !== 1
  )
    fail('unsupported_wire');
  const headers = wireHeaders(facts.binding.provider, wire);
  if (
    facts.binding.provider === 'anthropic' &&
    headers['anthropic-version'] !== facts.binding.apiVersion
  )
    fail('unsupported_wire');
  const body = object(
    parse(wire.body, 8 * 1024 * 1024, 'unsupported_wire'),
    'unsupported_wire',
  );
  const cap = outputCap(body, facts);
  if (
    cap > facts.maxOutput ||
    optionsDigest(facts.binding.provider, wire, body) !==
      facts.binding.optionsSha256
  )
    fail('unsupported_wire');
  const hold = Math.max(
    ...facts.bands.map((band) => {
      const allowedRates =
        facts.cacheMode === 'anthropic-ephemeral'
          ? [band.input, band.cacheRead, band.cacheWrite5m, band.cacheWrite1h]
          : facts.cacheMode === 'google-implicit'
            ? [band.input, band.cacheRead]
            : [band.input];
      return micros(
        plus(
          plus(
            times(facts.maxInput, maxRate(allowedRates)),
            times(cap, band.output),
          ),
          facts.fixedFee,
        ),
        'invalid_contract',
      );
    }),
  );
  if (
    remaining.currency !== 'USD' ||
    integer(remaining.inputTokens, 'insufficient_envelope') < facts.maxInput ||
    integer(remaining.outputTokens, 'insufficient_envelope') < cap ||
    integer(remaining.costMicros, 'insufficient_envelope') < hold
  )
    fail('insufficient_envelope');
  const quote = Object.freeze({
    contractId: contract.id,
    contractRevision: contract.revision,
    contractSha256: contract.contractSha256,
    evidenceDigest: contract.evidenceDigest,
    wireSha256: hash(wire.body),
    inputUpperBoundTokens: facts.maxInput,
    outputUpperBoundTokens: cap,
    costMicros: hold,
    currency: 'USD' as const,
  });
  const thinking =
    facts.binding.provider === 'anthropic'
      ? body.thinking
      : object(body.generationConfig, 'unsupported_wire').thinkingConfig;
  const thinkingDisabled =
    thinking !== undefined &&
    (facts.binding.provider === 'anthropic'
      ? object(thinking, 'unsupported_wire').type === 'disabled'
      : object(thinking, 'unsupported_wire').thinkingBudget === 0 &&
        facts.thinkingBudgetZero === 'disables-thinking');
  quotes.set(quote, Object.freeze({ contract, thinkingDisabled }));
  return quote;
}

function responseString(value: unknown): void {
  if (typeof value !== 'string') fail('usage_unknown');
}
function optionalResponseString(value: unknown): void {
  if (value !== undefined && value !== null) responseString(value);
}
function reportedScope(value: unknown, expected: string): void {
  // The approved request pins these values. Nullable optional response metadata
  // need not repeat that proof; a reported contradiction is always unresolved.
  if (value !== undefined && value !== null && value !== expected)
    fail('usage_unknown');
}
function safetyRatings(value: unknown): void {
  if (value === undefined || value === null) return;
  for (const entry of list(value, 'usage_unknown', 0, 32)) {
    const rating = closed(
      entry,
      ['category', 'probability'],
      ['blocked', 'severity', 'probabilityScore', 'severityScore'],
      'usage_unknown',
    );
    str(rating.category, 'usage_unknown', 128);
    if (
      ![
        'HARM_PROBABILITY_UNSPECIFIED',
        'NEGLIGIBLE',
        'LOW',
        'MEDIUM',
        'HIGH',
      ].includes(str(rating.probability, 'usage_unknown'))
    )
      fail('usage_unknown');
    if (
      rating.blocked !== undefined &&
      rating.blocked !== null &&
      typeof rating.blocked !== 'boolean'
    )
      fail('usage_unknown');
    if (
      rating.severity !== undefined &&
      rating.severity !== null &&
      ![
        'HARM_SEVERITY_UNSPECIFIED',
        'NEGLIGIBLE',
        'LOW',
        'MEDIUM',
        'HIGH',
      ].includes(str(rating.severity, 'usage_unknown'))
    )
      fail('usage_unknown');
    for (const key of ['probabilityScore', 'severityScore']) {
      const score = rating[key];
      if (
        score !== undefined &&
        score !== null &&
        (typeof score !== 'number' ||
          !Number.isFinite(score) ||
          score < 0 ||
          score > 1)
      )
        fail('usage_unknown');
    }
  }
}
function anthropicResponseScope(
  response: Obj,
  facts: Facts,
  thinkingDisabled: boolean,
): void {
  if (
    response.model !== facts.binding.modelId ||
    response.type !== 'message' ||
    response.role !== 'assistant' ||
    ![
      'end_turn',
      'max_tokens',
      'stop_sequence',
      'refusal',
      'model_context_window_exceeded',
      ...(facts.profile === 'report-input-single-request-v1'
        ? ['tool_use']
        : []),
    ].includes(str(response.stop_reason, 'usage_unknown'))
  )
    fail('usage_unknown');
  str(response.id, 'usage_unknown');
  if (response.container !== undefined && response.container !== null)
    fail('usage_unknown');
  if (response.stop_sequence !== null) responseString(response.stop_sequence);
  if (
    (response.stop_reason === 'stop_sequence') !==
    (typeof response.stop_sequence === 'string')
  )
    fail('usage_unknown');
  let toolCalls = 0;
  for (const value of list(response.content, 'usage_unknown', 0, 2048)) {
    const block = object(value, 'usage_unknown');
    if (block.type === 'text') {
      closed(block, ['type', 'text'], ['citations'], 'usage_unknown');
      responseString(block.text);
      // This class has no documents, grounding or server tools to cite.
      if (block.citations !== undefined && block.citations !== null)
        list(block.citations, 'usage_unknown', 0, 0);
    } else if (
      block.type === 'tool_use' &&
      facts.profile === 'report-input-single-request-v1'
    ) {
      closed(block, ['type', 'id', 'name', 'input'], [], 'usage_unknown');
      str(block.id, 'usage_unknown', 128);
      if (++toolCalls > 1 || block.name !== REPORT_INPUT_TOOL_NAME)
        fail('usage_unknown');
      readReportInputQuestion(block.input);
    } else if (block.type === 'thinking') {
      if (thinkingDisabled) fail('usage_unknown');
      closed(block, ['type', 'thinking', 'signature'], [], 'usage_unknown');
      responseString(block.thinking);
      responseString(block.signature);
    } else if (block.type === 'redacted_thinking') {
      if (thinkingDisabled) fail('usage_unknown');
      closed(block, ['type', 'data'], [], 'usage_unknown');
      responseString(block.data);
    } else fail('usage_unknown');
  }
  if ((response.stop_reason === 'tool_use') !== (toolCalls === 1))
    fail('usage_unknown');
}
function googleResponseScope(
  response: Obj,
  facts: Facts,
  thinkingDisabled: boolean,
): Obj {
  if (response.modelVersion !== facts.binding.modelRevision)
    fail('usage_unknown');
  optionalResponseString(response.responseId);
  if (
    response.promptFeedback !== undefined &&
    response.promptFeedback !== null
  ) {
    const feedback = closed(
      response.promptFeedback,
      [],
      ['blockReason', 'safetyRatings'],
      'usage_unknown',
    );
    // A prompt-blocked result has no ordinary candidate to settle in this class.
    if (
      feedback.blockReason !== undefined &&
      feedback.blockReason !== null &&
      feedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED'
    )
      fail('usage_unknown');
    safetyRatings(feedback.safetyRatings);
  }
  if (response.modelStatus !== undefined && response.modelStatus !== null) {
    const status = closed(
      response.modelStatus,
      [],
      ['modelStage', 'retirementTime', 'message'],
      'usage_unknown',
    );
    if (
      status.modelStage !== undefined &&
      ![
        'MODEL_STAGE_UNSPECIFIED',
        'EXPERIMENTAL',
        'UNSTABLE_EXPERIMENTAL',
        'PREVIEW',
        'STABLE',
        'LEGACY',
      ].includes(str(status.modelStage, 'usage_unknown'))
    )
      fail('usage_unknown');
    optionalResponseString(status.retirementTime);
    optionalResponseString(status.message);
  }
  const candidates = list(response.candidates, 'usage_unknown', 1, 1);
  const candidate = closed(
    candidates[0],
    ['finishReason'],
    [
      'content',
      'index',
      'safetyRatings',
      'finishMessage',
      'citationMetadata',
      'tokenCount',
      'avgLogprobs',
    ],
    'usage_unknown',
  );
  if (
    ![
      'STOP',
      'MAX_TOKENS',
      'SAFETY',
      'RECITATION',
      'BLOCKLIST',
      'PROHIBITED_CONTENT',
      'SPII',
      'OTHER',
    ].includes(str(candidate.finishReason, 'usage_unknown'))
  )
    fail('usage_unknown');
  if (
    candidate.index !== undefined &&
    integer(candidate.index, 'usage_unknown') !== 0
  )
    fail('usage_unknown');
  optionalResponseString(candidate.finishMessage);
  safetyRatings(candidate.safetyRatings);
  if (
    candidate.avgLogprobs !== undefined &&
    (typeof candidate.avgLogprobs !== 'number' ||
      !Number.isFinite(candidate.avgLogprobs))
  )
    fail('usage_unknown');
  if (candidate.content !== undefined && candidate.content !== null) {
    const content = closed(
      candidate.content,
      [],
      ['role', 'parts'],
      'usage_unknown',
    );
    if (content.role !== undefined && content.role !== 'model')
      fail('usage_unknown');
    for (const entry of content.parts === undefined || content.parts === null
      ? []
      : list(content.parts, 'usage_unknown', 0, 2048)) {
      const part = closed(
        entry,
        ['text'],
        ['thought', 'thoughtSignature'],
        'usage_unknown',
      );
      responseString(part.text);
      if (
        part.thought !== undefined &&
        part.thought !== null &&
        typeof part.thought !== 'boolean'
      )
        fail('usage_unknown');
      if (thinkingDisabled && part.thought === true) fail('usage_unknown');
      optionalResponseString(part.thoughtSignature);
    }
  }
  if (
    candidate.citationMetadata !== undefined &&
    candidate.citationMetadata !== null
  ) {
    // Training-data recitation citations are not paid retrieval/grounding.
    const citations = closed(
      candidate.citationMetadata,
      [],
      ['citationSources'],
      'usage_unknown',
    );
    for (const entry of citations.citationSources === undefined
      ? []
      : list(citations.citationSources, 'usage_unknown', 0, 128)) {
      const source = closed(
        entry,
        [],
        ['startIndex', 'endIndex', 'uri', 'license'],
        'usage_unknown',
      );
      const start =
        source.startIndex === undefined
          ? undefined
          : integer(source.startIndex, 'usage_unknown');
      const end =
        source.endIndex === undefined
          ? undefined
          : integer(source.endIndex, 'usage_unknown');
      if (start !== undefined && end !== undefined && end < start)
        fail('usage_unknown');
      optionalResponseString(source.uri);
      optionalResponseString(source.license);
    }
  }
  return candidate;
}
function optionalCount(value: unknown): number | undefined {
  return value === undefined || value === null
    ? undefined
    : integer(value, 'usage_unknown');
}
function tokenDetails(
  value: unknown,
  expected: number | undefined,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const counts = list(value, 'usage_unknown', 0, 1).map((entry) => {
    const detail = closed(
      entry,
      ['modality', 'tokenCount'],
      [],
      'usage_unknown',
    );
    if (detail.modality !== 'TEXT') fail('usage_unknown');
    return integer(detail.tokenCount, 'usage_unknown');
  });
  const total = safeSum(counts);
  if (expected !== undefined && total !== expected) fail('usage_unknown');
  return total;
}

/** Prices COMPLETE raw JSON for one physical response, not normalized SDK usage.
 * SSE assembly/terminal detection belongs to the transport owner, which must
 * assemble the same complete response before calling. Any failure means UNKNOWN
 * usage: the Flow adapter retains its hold; this module never releases capacity.
 * costMicros is a tariff-derived metering bound, not provider-reported dollars. */
export function priceBoundedApiProviderRawUsage(
  contract: ResolvedBoundedApiProviderContract,
  quote: BoundedApiAttemptQuote,
  completeResponseJson: string,
  nowMs: number,
): Readonly<{
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  currency: 'USD';
  rawResponseSha256: string;
  costBasis: 'tariff-upper-bound';
}> {
  try {
    const quoted = quotes.get(quote);
    if (quoted?.contract !== contract) fail('usage_unknown');
    return priceRawUsage(
      current(contract, nowMs),
      quote,
      quoted.thinkingDisabled,
      completeResponseJson,
    );
  } catch {
    return fail('usage_unknown');
  }
}

function priceRawUsage(
  facts: Facts,
  quote: BoundedApiAttemptQuote,
  thinkingDisabled: boolean,
  completeResponseJson: string,
) {
  try {
    const response = closed(
      parse(completeResponseJson, 8 * 1024 * 1024, 'usage_unknown'),
      facts.binding.provider === 'anthropic'
        ? [
            'id',
            'type',
            'role',
            'content',
            'model',
            'stop_reason',
            'stop_sequence',
            'usage',
          ]
        : ['modelVersion', 'candidates', 'usageMetadata'],
      facts.binding.provider === 'anthropic'
        ? ['container']
        : ['responseId', 'promptFeedback', 'modelStatus'],
      'usage_unknown',
    );
    let input: number;
    let output: number;
    let uncached: number;
    let read: number;
    let write5m = 0;
    let write1h = 0;
    let unknownWriteSplit = 0;
    let unknownCacheSplit = false;
    if (facts.binding.provider === 'anthropic') {
      anthropicResponseScope(response, facts, thinkingDisabled);
      const usage = closed(
        response.usage,
        [
          'input_tokens',
          'cache_creation_input_tokens',
          'cache_read_input_tokens',
          'output_tokens',
        ],
        [
          'cache_creation',
          'service_tier',
          'inference_geo',
          'speed',
          'output_tokens_details',
          'server_tool_use',
        ],
        'usage_unknown',
      );
      reportedScope(usage.service_tier, 'standard');
      reportedScope(usage.inference_geo, 'global');
      reportedScope(usage.speed, 'standard');
      if (
        usage.server_tool_use !== undefined &&
        usage.server_tool_use !== null
      ) {
        const tools = closed(
          usage.server_tool_use,
          ['web_search_requests', 'web_fetch_requests'],
          [],
          'usage_unknown',
        );
        if (
          integer(tools.web_search_requests, 'usage_unknown') !== 0 ||
          integer(tools.web_fetch_requests, 'usage_unknown') !== 0
        )
          fail('usage_unknown');
      }
      uncached = integer(usage.input_tokens, 'usage_unknown');
      read = integer(usage.cache_read_input_tokens, 'usage_unknown');
      const writes = integer(
        usage.cache_creation_input_tokens,
        'usage_unknown',
      );
      if (usage.cache_creation === undefined || usage.cache_creation === null) {
        // An explicit aggregate zero proves both write counts zero. Positive
        // writes without a TTL split are priced at the maximum allowed TTL rate.
        unknownWriteSplit = writes;
      } else {
        const cache = closed(
          usage.cache_creation,
          ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'],
          [],
          'usage_unknown',
        );
        write5m = integer(cache.ephemeral_5m_input_tokens, 'usage_unknown');
        write1h = integer(cache.ephemeral_1h_input_tokens, 'usage_unknown');
        if (BigInt(writes) !== BigInt(write5m) + BigInt(write1h))
          fail('usage_unknown');
      }
      if (facts.cacheMode === 'none' && (read > 0 || writes > 0))
        fail('usage_unknown');
      input = safeSum([uncached, read, writes]);
      output = integer(usage.output_tokens, 'usage_unknown');
      if (
        usage.output_tokens_details !== undefined &&
        usage.output_tokens_details !== null
      ) {
        const details = closed(
          usage.output_tokens_details,
          ['thinking_tokens'],
          [],
          'usage_unknown',
        );
        const thoughts = integer(details.thinking_tokens, 'usage_unknown');
        if (thoughts > output || (thinkingDisabled && thoughts > 0))
          fail('usage_unknown');
      }
    } else {
      const candidate = googleResponseScope(response, facts, thinkingDisabled);
      const usage = closed(
        response.usageMetadata,
        ['promptTokenCount', 'totalTokenCount'],
        [
          'cachedContentTokenCount',
          'candidatesTokenCount',
          'thoughtsTokenCount',
          'toolUsePromptTokenCount',
          'serviceTier',
          'promptTokensDetails',
          'cacheTokensDetails',
          'candidatesTokensDetails',
          'toolUsePromptTokensDetails',
        ],
        'usage_unknown',
      );
      reportedScope(
        usage.serviceTier === 'unspecified' ? undefined : usage.serviceTier,
        'standard',
      );
      const toolTokens = optionalCount(usage.toolUsePromptTokenCount);
      // Tools are absent in the approved request AND the closed response scope.
      // A positive reported tool component contradicts that qualified class.
      if (toolTokens !== undefined && toolTokens !== 0) fail('usage_unknown');
      input = integer(usage.promptTokenCount, 'usage_unknown');
      const total = integer(usage.totalTokenCount, 'usage_unknown');
      if (total < input) fail('usage_unknown');
      output = total - input; // Documented total = prompt + tool + thoughts + candidates.
      const text = optionalCount(usage.candidatesTokenCount);
      const thoughts = optionalCount(usage.thoughtsTokenCount);
      if (thinkingDisabled && thoughts !== undefined && thoughts > 0)
        fail('usage_unknown');
      if (
        (text !== undefined && text > output) ||
        (thoughts !== undefined && thoughts > output) ||
        (text !== undefined &&
          thoughts !== undefined &&
          safeSum([text, thoughts]) !== output)
      )
        fail('usage_unknown');
      const cached = optionalCount(usage.cachedContentTokenCount);
      unknownCacheSplit = cached === undefined && facts.cacheMode !== 'none';
      read = cached ?? 0; // When unknown, used only after selecting max(input,read) tariff below.
      if (read > input || (facts.cacheMode === 'none' && read !== 0))
        fail('usage_unknown');
      uncached = input - read;
      tokenDetails(usage.promptTokensDetails, input);
      const cacheDetail = tokenDetails(usage.cacheTokensDetails, cached);
      const candidateDetail = tokenDetails(
        usage.candidatesTokensDetails,
        text ?? (thoughts === undefined ? undefined : output - thoughts),
      );
      if (
        (cacheDetail !== undefined &&
          (cacheDetail > input ||
            (facts.cacheMode === 'none' && cacheDetail !== 0))) ||
        (candidateDetail !== undefined && candidateDetail > output)
      )
        fail('usage_unknown');
      tokenDetails(usage.toolUsePromptTokensDetails, 0);
      // Exactly one candidate: its reported count, aggregate candidate count,
      // modality sum and total-minus-thoughts must agree whenever supplied.
      // Missing components stay absent; the inclusive output identity above
      // remains sufficient to price output without inventing text/thought zeros.
      const candidateCount = optionalCount(candidate.tokenCount);
      const candidateCounts = [
        text,
        candidateDetail,
        candidateCount,
        thoughts === undefined ? undefined : output - thoughts,
        thinkingDisabled ? output : undefined,
      ].filter((count): count is number => count !== undefined);
      if (
        candidateCounts.some(
          (count) => count > output || count !== candidateCounts[0],
        )
      )
        fail('usage_unknown');
    }
    if (
      input > quote.inputUpperBoundTokens ||
      output > quote.outputUpperBoundTokens
    )
      fail('usage_unknown');
    const band = facts.bands.find(
      (value) => input >= value.min && input <= value.max,
    );
    if (!band) fail('usage_unknown');
    const charge = [
      times(
        uncached,
        unknownCacheSplit ? maxRate([band.input, band.cacheRead]) : band.input,
      ),
      times(read, band.cacheRead),
      times(write5m, band.cacheWrite5m),
      times(write1h, band.cacheWrite1h),
      times(unknownWriteSplit, maxRate([band.cacheWrite5m, band.cacheWrite1h])),
      times(output, band.output),
    ].reduce(plus, facts.fixedFee);
    const costMicros = micros(charge, 'usage_unknown');
    if (costMicros > quote.costMicros) fail('usage_unknown');
    return Object.freeze({
      inputTokens: input,
      outputTokens: output,
      costMicros,
      currency: 'USD',
      rawResponseSha256: hash(completeResponseJson),
      costBasis: 'tariff-upper-bound',
    });
  } catch {
    return fail('usage_unknown');
  }
}

function safeSum(values: readonly number[]): number {
  const sum = values.reduce((a, b) => a + BigInt(b), 0n);
  if (sum > MAX_SAFE) fail('usage_unknown');
  return Number(sum);
}
