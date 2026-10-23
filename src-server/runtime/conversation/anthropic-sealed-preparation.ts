// UNWIRED(#91): request serving must compose this issuer with actual rounds/task custody.
import { createHash } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '@kontourai/relay';
import { claimSdkSourceLease } from '../../services/orchestration/delegation-group-source-admission.js';
import {
  type BoundedApiFinalWire,
  type BoundedApiProviderBinding,
  BoundedApiProviderContractError,
  type BoundedApiQualificationRegistryOwner,
  boundedApiWireOptionsSha256,
  resolveBoundedApiProviderContract,
} from './bounded-api-provider-contract.js';
import {
  type ObservedSdkProviderCredential,
  readObservedSdkProviderCredential,
} from './provider-credential-observation.js';

const MODEL = 'claude-sonnet-4-6';
const VERSION = '2026-10-21';
const VALID_FROM = Date.parse('2026-10-23T08:20:00Z');
// The earliest retained pricing/cap snapshot bounds freshness; startup cannot extend it.
const EXPIRES = Date.parse('2026-10-24T01:04:41Z');
const INPUT_RESERVATION = 1_048_576;
const SDK = [
  [
    'dist/index.mjs',
    '30dbd47f2a8e9cbc34b6c200e4c2d193afc8cac69311d47bd3e2c8de9864602c',
  ],
  [
    'package.json',
    '04ed5716d3a8c78254b2938cc266f6966ab0deb081f65941789bbeb3fb8f8581',
  ],
] as const;
const SOURCES = [
  'a311c85d4f86c21373c4eaa97ab4898e5a5d1c25c1c95ac08d02cdd9c18e1ec3',
  '1ea49b9306d45735a680413214711467e79f9fe2f7bd6503628f4ded5e7578b9',
  '03a351b63972e221ab2147b5ce7f8df46d71da172ad607c2b37940cbfbbd1b97',
  '35a9be5a71aa07fb087aa641221c7a428e66632fce3bfd6a832eaa680e7fe36d',
  '642f5d0dc03713c8133e34bf123193ce2c6307c47770252f1f793e35d768db6b',
  '563bd87261c4cdcced4584334cfafbba34bc43ca2e5bf668d12d854a7051e6f5',
  'ae071e7fe88112be98e0221b9910660daa0a73ca85c3c4ef9576d564c6d1d134',
  'b9198df8268f1c1035ebf8cc669fbace58bd0cdb53ab7b6a74af3d79cf4f2967',
  '2c5e4d62c6df9d5e7c97371c32c1c16fdd9bcf63c461a8dcdcd0937926b3db64',
  'c4acb2e0710eea3eac219d44b4370d73ef227b29b33ef198439779e5276cb6b7',
];
const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const refuse = (): never => {
  throw new BoundedApiProviderContractError('untrusted_contract');
};
const stamp = (path: string) => {
  const s = lstatSync(path, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.size > 2n * 1024n * 1024n)
    refuse();
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].join(':');
};
type RecordValue = NonNullable<
  ReturnType<BoundedApiQualificationRegistryOwner['read']>
>;

const preparationOwners = new WeakSet<object>();

/** One reviewed direct-text profile. This authenticates public inference terms, not entitlement or invoices. */
export class AnthropicSealedPreparation {
  readonly #witnesses: readonly { path: string; stamp: string }[];
  readonly #records = new Map<
    string,
    { record: RecordValue; current(): void }
  >();
  private constructor(witnesses: readonly { path: string; stamp: string }[]) {
    this.#witnesses = witnesses;
    Object.freeze(this);
  }
  static isOwner(value: unknown): value is AnthropicSealedPreparation {
    return (
      value !== null &&
      typeof value === 'object' &&
      preparationOwners.has(value)
    );
  }
  static async create(): Promise<AnthropicSealedPreparation> {
    const entry = new URL(import.meta.resolve('@ai-sdk/anthropic'));
    const root = new URL('../', entry);
    const witnesses = [];
    for (const [relative, expected] of SDK) {
      const path = fileURLToPath(new URL(relative, root));
      const before = stamp(path);
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (sha(await fd.readFile()) !== expected || stamp(path) !== before)
          refuse();
      } finally {
        await fd.close();
      }
      witnesses.push({ path, stamp: before });
    }
    const owner = new AnthropicSealedPreparation(witnesses);
    preparationOwners.add(owner);
    owner.assertCurrent();
    return owner;
  }
  get apiVersion(): string {
    this.assertCurrent();
    return VERSION;
  }
  assertSelection(provider: string, model: string): void {
    this.assertCurrent();
    if (provider !== 'anthropic' || model !== MODEL) refuse();
  }
  assertCurrent(): void {
    if (!preparationOwners.has(this)) refuse();
    const now = Date.now();
    if (now < VALID_FROM || now >= EXPIRES)
      throw new BoundedApiProviderContractError('stale_contract');
    for (const witness of this.#witnesses)
      if (stamp(witness.path) !== witness.stamp) refuse();
  }
  qualifySourceWire(
    token: object,
    credential: ObservedSdkProviderCredential,
    wire: BoundedApiFinalWire,
  ) {
    this.assertCurrent();
    const lease = claimSdkSourceLease(token);
    lease.assertCurrentSync();
    const source = lease.binding;
    const observed = readObservedSdkProviderCredential(
      credential,
      'anthropic',
      source.request,
    );
    if (observed.hostContextId !== source.hostContextId) refuse();
    const headers = new Headers(wire.headers);
    const body = JSON.parse(wire.body);
    if (
      wire.url !== 'https://api.anthropic.com/v1/messages' ||
      wire.method !== 'POST' ||
      wire.redirect !== 'error' ||
      wire.requestOrdinal !== 1 ||
      headers.get('anthropic-version') !== VERSION ||
      headers.get('x-api-key') !== observed.apiKey ||
      Object.keys(body).sort().join(',') !==
        'inference_geo,max_tokens,messages,model,service_tier' ||
      body.model !== MODEL ||
      body.inference_geo !== 'global' ||
      body.service_tier !== 'standard_only' ||
      !Number.isSafeInteger(body.max_tokens) ||
      body.max_tokens < 1 ||
      body.max_tokens > 128000
    )
      throw new BoundedApiProviderContractError('unsupported_wire');
    const messages = body.messages;
    const content = messages?.[0]?.content;
    if (
      !Array.isArray(messages) ||
      messages.length !== 1 ||
      messages[0].role !== 'user' ||
      Object.keys(messages[0]).sort().join(',') !== 'content,role' ||
      !Array.isArray(content) ||
      content.length !== 2 ||
      content.some(
        (part) =>
          !part ||
          Object.keys(part).sort().join(',') !== 'text,type' ||
          part.type !== 'text' ||
          typeof part.text !== 'string',
      ) ||
      content[1].text !== lease.serialization
    )
      throw new BoundedApiProviderContractError('unsupported_wire');
    const binding: BoundedApiProviderBinding = {
      provider: 'anthropic',
      endpointUrl: wire.url,
      apiVersion: VERSION,
      modelId: MODEL,
      modelRevision: MODEL,
      connectionId: observed.connectionId,
      connectionRevision: observed.connectionRevision,
      credentialRevision: observed.credentialRevision,
      principalId: source.principalId,
      tenantId: `personal:${source.hostContextId}`,
      sourceId: source.source.repository_id,
      sourceRevision: source.source.source_admission_receipt.digest,
      optionsSha256: boundedApiWireOptionsSha256('anthropic', wire),
      sdkPackage: '@ai-sdk/anthropic',
      sdkVersion: '3.0.134',
    };
    const id = `anthropic-text:${sha(canonicalJson(binding))}`;
    const evidence = {
      authorityKind: 'provider-public-contract' as const,
      authorityRef: 'https://platform.claude.com/docs/en/about-claude/pricing',
      revision: 'sonnet46-text-20261023',
      sourceSha256s: SOURCES,
      validFromMs: VALID_FROM,
      expiresAtMs: EXPIRES,
    };
    const rate = (n: string, d = '1') => ({ numerator: n, denominator: d });
    const serializedContract = canonicalJson({
      schema: 'direct-text-single-request-v1',
      id,
      revision: evidence.revision,
      binding,
      evidence,
      limits: {
        inputTokens: INPUT_RESERVATION,
        outputTokens: 128000,
        thinkingModes: ['omitted'],
      },
      tariff: {
        currency: 'USD',
        scope: 'provider-inference-before-tax',
        geography: 'global',
        serviceTier: 'standard',
        speed: 'standard',
        cacheMode: 'none',
        fixedFee: rate('0'),
        bands: [
          {
            minInputTokens: 0,
            maxInputTokens: INPUT_RESERVATION,
            rates: {
              input: rate('3'),
              output: rate('15'),
              cacheRead: rate('3', '10'),
              cacheWrite5m: rate('15', '4'),
              cacheWrite1h: rate('6'),
            },
          },
        ],
      },
    });
    const record: RecordValue = {
      serializedContract,
      contractSha256: sha(serializedContract),
      authorityKind: evidence.authorityKind,
      authorityRef: evidence.authorityRef,
      evidenceRevision: evidence.revision,
      sourceSha256s: SOURCES,
      validFromMs: VALID_FROM,
      expiresAtMs: EXPIRES,
    };
    const previous = this.#records.get(id);
    if (previous) {
      previous.current();
      if (canonicalJson(previous.record) !== canonicalJson(record)) refuse();
      return resolveBoundedApiProviderContract(id, binding, this, Date.now());
    }
    if (this.#records.size >= 1024) refuse();
    this.#records.set(id, {
      record,
      current: () => {
        this.assertCurrent();
        lease.assertDisclosureCurrentSync();
        readObservedSdkProviderCredential(
          credential,
          'anthropic',
          source.request,
        );
      },
    });
    return resolveBoundedApiProviderContract(id, binding, this, Date.now());
  }
  read(id: string): RecordValue | undefined {
    this.assertCurrent();
    const entry = this.#records.get(id);
    entry?.current();
    return entry ? structuredClone(entry.record) : undefined;
  }
}
