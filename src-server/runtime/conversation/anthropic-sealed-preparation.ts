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
const VALID_FROM = Date.parse('2026-11-13T20:30:00Z');
// Twelve hours from the earliest reviewed snapshot; startup cannot extend it.
const EXPIRES = Date.parse('2026-11-14T08:12:15.083Z');
const INPUT_RESERVATION = 1_048_576;
const INPUT_VALID_FROM = Date.parse('2026-11-13T20:30:00Z');
const INPUT_SOURCES = [
  '8de7a2c9e11c1baf96af426cc78d944e6f3316a8df1f2166c27087760edfe84d',
  '00b3bc548d6d432182726d798b7b0d4b38bbf37f0a70caf50453f5dbd1aed84d',
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
  '6e175b7363b058e0a9e70f8e4816f060af3eef6abe253fe90c2af2b26ec20f04',
  '5c0a7741ac03733fe75638d0a573d893b04d3ef51f99e23fffeecdd8bac385ab',
  '83f84dd60807535b68a783827e96ab437dd194081d3d0da1d60c1f2efdecad70',
  'fb245db57e57983541ce5ca68e2c1dca73ae5553a249215aeed4a25791ce2186',
  'e47d061186addad93e3e88249d5e2d1696b755721356cf9b0427098018b7b7a5',
  '9067656991b86a332720f74233c20552d2fb6a28e6c9e19cf0a34244973568aa',
  '8043cf06b8adcfa1c429c0e5e149c9a291b2acb322aa33ed582deefa1ceeb8c0',
  '5fbbddc8cacbb52d522c6f7ae7b6911877002bd590a68ea638a9712f69f477ba',
  '5b22a3bfa7cf403728d7b9826bc9cb08e12df3220e7de65393b91ee1e48d36dd',
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
        ? 'sonnet46-input-20261113-sdk30142'
        : 'sonnet46-text-20261113-sdk30142',
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
