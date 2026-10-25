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
const VALID_FROM = Date.parse('2026-10-24T01:59:12Z');
// The earliest retained pricing/cap snapshot bounds freshness; startup cannot extend it.
const EXPIRES = Date.parse('2026-10-25T01:59:08Z');
const INPUT_RESERVATION = 1_048_576;
const INPUT_VALID_FROM = Date.parse('2026-10-24T22:40:30Z');
const INPUT_SOURCES = [
  '9fc4cbee3ba65c83bd9c32405c8d145e6c8b0741aa04d952dbfc5e4f66ac8d52',
  '6032b9e5be6b6b5c6fc5334245cc9a84d098c51671b6c03519699435d9060714',
];
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
  '3112facadfc1a8a613e86a5b8feb189c60ccf7627b036150d8ae95f5a3086f57',
  '755352fe69f106f1b955ed67557687af4405291e1dd287da199607c48c3b766c',
  'ef11a43637c6a81388ec3bef36a6d22b10942bac0b9702e7d798dfd2c481cf75',
  'b81977f7d71eef0e043c2ba7d6f3ca6bf0c44d3597e34e16d5718a401350b6f6',
  'a42e2ba539360e9bccc24fc31e772bba500ce384f7f247b8f195263a97b8c31f',
  '8e4a2ee9786a9d5b9aebae0d8261a07558e3881aa3d8a13b2506de9c4e17feb9',
  '155af13aaf165e25ad2dcd840822c96d216895e26b36978c654466806a9e4574',
  '8fda511f7cdaf00e764abd01721a909301ac4394f5f66a5f6968d9b7c9595d13',
  'eeae4a4ed73e8bb4e5ff61640463b41b7a830d8a8c6fc878b5cc063af08a36fe',
  '4610415a59e328a8706b611ec206fa6fe1607b2746c0545e44fb4106a93dd7bb',
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
      sdkVersion: '3.0.134',
    };
    const id = `anthropic-${inputTool ? 'input' : 'text'}:${sha(canonicalJson(binding))}`;
    const evidence = {
      authorityKind: 'provider-public-contract' as const,
      authorityRef: 'https://platform.claude.com/docs/en/about-claude/pricing',
      revision: inputTool
        ? 'sonnet46-input-20261024'
        : 'sonnet46-text-20261024',
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
