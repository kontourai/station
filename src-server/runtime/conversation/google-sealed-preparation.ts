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

const MODEL = 'gemini-2.5-flash-lite';
const VERSION = 'v1beta';
const VALID_FROM = Date.parse('2026-11-13T20:30:00Z');
// Twelve hours from the earliest reviewed snapshot; startup cannot extend it.
const EXPIRES = Date.parse('2026-11-14T08:18:00.046Z');
const INPUT_RESERVATION = 1_048_576;
const SDK = [
  [
    'dist/index.mjs',
    '6e55d8ce14a5ac59360418a3e0175a95af7123b81395305653c012be56de9a0d',
  ],
  [
    'package.json',
    '548aa8c4e80c35b83a9dad3dd297d32a89d140a195e846bcccf4bb8456a16083',
  ],
] as const;
const SOURCES = [
  '4239f738649e888a91417186274ff11dc226e1fa214f64597f49dc590550d8c4',
  '6661126edb5ba536092740191d8c453cf65c5f8636798c4848f786efdf701683',
  '147405daf12162045a59e3dcf4665359648a4073b5f44bd9ad4191a411ff3042',
  '60b5d85930bfb3b1ccf815de8fcf5dcd364e02d607a828a3b0765a34bfbd0b93',
  '6dbfd6e650a049489be5289d7a298bde63cd799dc3bb0dc86c8d6b1132be1073',
  '552e6f760798c11b0316652c2effa77641d3b366afc29734f707d0cc56789d50',
  '0b67fd8517f1e55aaa66266a8f56576117b54935d89610f8a81426d1164e81c3',
  'eb634cbd3cb00462c8a88cda2bc9d188639145c383047aff7807b44e44785094',
  '42a3c9ae72d579e75fd36ee5cead6cad6a917a05deb393436a4316bed9e2d697',
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

/** One bounded direct-text profile. This authenticates public inference terms, not entitlement or invoices. */
export class GoogleSealedPreparation {
  readonly #witnesses: readonly { path: string; stamp: string }[];
  readonly #records = new Map<
    string,
    { record: RecordValue; current(): void }
  >();
  private constructor(witnesses: readonly { path: string; stamp: string }[]) {
    this.#witnesses = witnesses;
    Object.freeze(this);
  }
  static isOwner(value: unknown): value is GoogleSealedPreparation {
    return (
      value !== null &&
      typeof value === 'object' &&
      preparationOwners.has(value)
    );
  }
  static async create(): Promise<GoogleSealedPreparation> {
    const entry = new URL(import.meta.resolve('@ai-sdk/google'));
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
    const owner = new GoogleSealedPreparation(witnesses);
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
    if (provider !== 'google' || model !== MODEL) refuse();
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
      'google',
      source.request,
    );
    if (observed.hostContextId !== source.hostContextId) refuse();
    const headers = new Headers(wire.headers);
    const body = JSON.parse(wire.body);
    const config = body.generationConfig;
    if (
      !['generateContent', 'streamGenerateContent?alt=sse'].some(
        (method) =>
          wire.url ===
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:${method}`,
      ) ||
      wire.method !== 'POST' ||
      wire.redirect !== 'error' ||
      wire.requestOrdinal !== 1 ||
      headers.get('x-goog-api-key') !== observed.apiKey ||
      Object.keys(body).sort().join(',') !==
        'contents,generationConfig,serviceTier' ||
      body.serviceTier !== 'standard' ||
      !config ||
      Object.keys(config).sort().join(',') !==
        'maxOutputTokens,thinkingConfig' ||
      !Number.isSafeInteger(config.maxOutputTokens) ||
      config.maxOutputTokens < 1 ||
      config.maxOutputTokens > 65536 ||
      !config.thinkingConfig ||
      Object.keys(config.thinkingConfig).join(',') !== 'thinkingBudget' ||
      config.thinkingConfig.thinkingBudget !== 0
    )
      throw new BoundedApiProviderContractError('unsupported_wire');
    const messages = body.contents;
    const content = messages?.[0]?.parts;
    if (
      !Array.isArray(messages) ||
      messages.length !== 1 ||
      messages[0].role !== 'user' ||
      Object.keys(messages[0]).sort().join(',') !== 'parts,role' ||
      !Array.isArray(content) ||
      content.length !== 2 ||
      content.some(
        (part) =>
          !part ||
          Object.keys(part).join(',') !== 'text' ||
          typeof part.text !== 'string',
      ) ||
      content[1].text !== lease.serialization
    )
      throw new BoundedApiProviderContractError('unsupported_wire');
    const binding: BoundedApiProviderBinding = {
      provider: 'google',
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
      optionsSha256: boundedApiWireOptionsSha256('google', wire),
      sdkPackage: '@ai-sdk/google',
      sdkVersion: '3.0.145',
    };
    const id = `google-text:${sha(canonicalJson(binding))}`;
    const evidence = {
      authorityKind: 'provider-public-contract' as const,
      authorityRef: 'https://ai.google.dev/gemini-api/docs/pricing',
      revision: 'flash-lite25-text-20261113-sdk30145',
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
        outputTokens: 65536,
        thinkingModes: ['budget'],
        thinkingBudgetZero: 'disables-thinking',
      },
      tariff: {
        currency: 'USD',
        scope: 'provider-inference-before-tax',
        geography: 'developer-api',
        serviceTier: 'standard',
        speed: 'standard',
        cacheMode: 'google-implicit',
        fixedFee: rate('0'),
        bands: [
          {
            minInputTokens: 0,
            maxInputTokens: INPUT_RESERVATION,
            rates: {
              input: rate('1', '10'),
              output: rate('2', '5'),
              cacheRead: rate('1', '100'),
              cacheWrite5m: rate('0'),
              cacheWrite1h: rate('0'),
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
        readObservedSdkProviderCredential(credential, 'google', source.request);
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
