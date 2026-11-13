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
import { reportInputToolDefinition } from './report-input-profile.js';

const MODEL = 'claude-sonnet-4-6';
const VERSION = '2026-10-21';
const VALID_FROM = Date.parse('2026-10-31T02:15:00Z');
// The earliest retained pricing/cap snapshot bounds freshness; startup cannot extend it.
const EXPIRES = Date.parse('2026-10-31T21:57:45.679Z');
const INPUT_RESERVATION = 1_048_576;
const INPUT_VALID_FROM = Date.parse('2026-10-31T02:15:00Z');
const INPUT_SOURCES = [
  '9cfd74b9085448d42da7b6632fb908b764159f37e77dd644d2503369239023ff',
  '85f3a48d1aa56da63c28d0adcde5d85bce55c5616de70fcfd7c86e6dd5e48bb6',
  'eb0fa6af00d91517f2c5d7bf6bbe79c97b74461b6420213f740a965486489d79',
];
const SDK = [
  [
    'dist/index.mjs',
    '81e24dc30f6c652bf12c9aaae2d082a956020f43bd2dfde82213e56371e3d530',
  ],
  [
    'package.json',
    'c7a50c86f1189a55186b91e3047c0e40688377b63725e402e72b87e0028ed096',
  ],
] as const;
const SOURCES = [
  'c92acb78991145659dd2dcbde67ae5f26c0d5314536e66f4397e620280cbbfc6',
  '01e0a50c56274c867968f480ad73bff0e9e1e4748bf49f72840058f35a80f332',
  '02083697070ff7e1a0544d45468e53d69abb2a76663cc86eda721ccf419d9693',
  '5c33ab689842ca2f32bccfc97950a044ba570424773321d87bc3cfb0e5128a80',
  '092bcc936c46d55400a9ee79de189772de52bb5c069fd8786ef4543228ea50dd',
  '7f63e402b16b134a82d5a55f5bcdd7deac84f2035b7732ef595e5f898bed9e27',
  '1184fe7357f121b66cb7a5e51b35226202b50964902f5c0272a9d8eb6dbcc36d',
  '1319bd2fdc490e6ef3dd03bed40f35e3cb7e34759d0b44cb2d9b0c884bd92b99',
  '89a596d3cf66522d1c8e95d81ab41b069f6d360ecbe1db9111bd3757b0985d17',
  '01b068305849d6e02e432b8e6e64986d0d42c2a4d0dd970eff83fb3b20c8e9eb',
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

/** Fixed text and client-input profiles; these qualify inference terms, never tool effects or invoices. */
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
    inputTool = false,
  ) {
    this.assertCurrent();
    if (inputTool && Date.now() < INPUT_VALID_FROM)
      throw new BoundedApiProviderContractError('stale_contract');
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
        (inputTool
          ? 'inference_geo,max_tokens,messages,model,service_tier,stream,tool_choice,tools'
          : body.stream === true
            ? 'inference_geo,max_tokens,messages,model,service_tier,stream'
            : 'inference_geo,max_tokens,messages,model,service_tier') ||
      (inputTool &&
        (body.stream !== true ||
          canonicalJson(body.tools) !==
            canonicalJson([reportInputToolDefinition()]) ||
          canonicalJson(body.tool_choice) !==
            canonicalJson({
              type: 'auto',
              disable_parallel_tool_use: true,
            }))) ||
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
      sdkVersion: '3.0.142',
    };
    const id = `anthropic-${inputTool ? 'input' : 'text'}:${sha(canonicalJson(binding))}`;
    const evidence = {
      authorityKind: 'provider-public-contract' as const,
      authorityRef: 'https://platform.claude.com/docs/en/about-claude/pricing',
      revision: inputTool
        ? 'sonnet46-input-20261031-sdk30142'
        : 'sonnet46-text-20261031-sdk30142',
      sourceSha256s: inputTool ? [...SOURCES, ...INPUT_SOURCES] : SOURCES,
      validFromMs: inputTool ? INPUT_VALID_FROM : VALID_FROM,
      expiresAtMs: EXPIRES,
    };
    const rate = (n: string, d = '1') => ({ numerator: n, denominator: d });
    const serializedContract = canonicalJson({
      schema: inputTool
        ? 'report-input-single-request-v1'
        : 'direct-text-single-request-v1',
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
      sourceSha256s: evidence.sourceSha256s,
      validFromMs: evidence.validFromMs,
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
        if (inputTool && Date.now() < INPUT_VALID_FROM)
          throw new BoundedApiProviderContractError('stale_contract');
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
