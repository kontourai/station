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
const VALID_FROM = Date.parse('2026-10-25T20:05:31Z');
// The earliest retained pricing/cap snapshot bounds freshness; startup cannot extend it.
const EXPIRES = Date.parse('2026-10-26T20:04:16Z');
const INPUT_RESERVATION = 1_048_576;
const SDK = [
  [
    'dist/index.mjs',
    'da133374ba6af9adc1c8bdc6527b02bf0bafad4b6c1a59f613c59542256c452f',
  ],
  [
    'package.json',
    '406721631ca6b9b90092d30d70fe917ff10acf5a3bd9788885f0763cd9383513',
  ],
] as const;
const SOURCES = [
  'b3ac3ec61c63d9438626d35d31842058aa90595692081fb98a168817c841a05a',
  '732ba2175f9376fca461ee8b36984a99698a8e6e9adcfd198f44e926b7f153ee',
  'b3fc23d05ac51fdeb0c5717c6ece1acc08320fbc0b3d5d62a167b81d5386cf28',
  '591d10118628b44a9f43f0757cf2dadd84ffaded284a5d56799f50f95733aea3',
  '5e4a1a83d6dfccba48c3d53b56e6746fe0f7ad4458de7ba81b0a3993b11e61d2',
  '4e1b587656a82a7aea3e1efd59712f627021d33e99934877727455beb06accc8',
  'aa10559296041385f4155aab8589fecb5302bfc2cc6aec60d50da358b6ca1dd9',
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
      sdkVersion: '3.0.136',
    };
    const id = `google-text:${sha(canonicalJson(binding))}`;
    const evidence = {
      authorityKind: 'provider-public-contract' as const,
      authorityRef: 'https://ai.google.dev/gemini-api/docs/pricing',
      revision: 'flash-lite25-text-20261025',
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
