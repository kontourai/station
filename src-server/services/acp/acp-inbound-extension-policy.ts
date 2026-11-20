/**
 * Inbound (agent→client) ACP extension-request policy.
 *
 * ## What this replaces, and why it is a defect rather than untidiness
 *
 * The ACP adapter used to wire `onExtMethod: () => ({})`. Every extension
 * request an agent sent to Station — every `_`-prefixed method the SDK could
 * not route to a spec-defined handler — was answered with an empty JSON-RPC
 * *result*. On the wire, `{}` is a success. The agent process reads it as
 * "Station handled that," and Station computed nothing.
 *
 * That is the prohibited class: **a response Station did not compute,
 * presented as one it did.** On this path it is not hygiene — it is a live
 * user-visible bug.
 *
 * `_kiro/auth/getAccessToken` is Kiro's **token-refresh callback**. In ACP
 * mode Kiro delegates access-token refresh to the host
 * (`--auth=acp-callback (host-mediated refresh via
 * _kiro/auth/getAccessToken)`): when the in-session token expires it asks
 * the *client* for a fresh one instead of re-reading its own still-valid
 * on-disk credential. Upstream: kirodotdev/Kiro#10416, open and
 * maintainer-acknowledged.
 *
 * Live evidence (`kiro-cli 2.16.0`, 2026-08-03) — the axis is the
 * `--agent-engine` flag, which defaults to `v2`:
 *
 * | invocation                      | requests token |
 * |---------------------------------|----------------|
 * | `acp`                           | no             |
 * | `acp --agent-engine v3`         | yes, eagerly at `initialize` |
 * | `--v3 acp --agent-engine v2`    | no             |
 *
 * Upstream reports the failure on both engines; the engine version only
 * changes *when* the callback fires. v3 asks eagerly at `initialize`; v2 —
 * Station's default path — asks lazily, **on expiry**. So any sufficiently
 * long Kiro ACP session in Station reaches this, and `() => ({})` handed
 * Kiro an empty object *as its refreshed token*, after which it failed
 * downstream in a confusing way. A clean refusal produces the legible
 * upstream error instead (`Auth refresh callback failed: Method not
 * supported`).
 *
 * Note what this request is *not*: it is not necessarily an AWS credential.
 * The upstream reporter is on IAM Identity Center, so theirs is AWS-issued;
 * a Google-signed-in machine is not. The `HTTP 400 "profileArn is required"`
 * the archive#1684 probe saw after answering with a decoy proves only that the
 * value was **transmitted** to a remote service as a bearer — which is the
 * part that matters here.
 *
 * ## Part 1 — spec-conformant refusal
 *
 * Per the ACP extensibility spec: an unrecognized *request* receives the
 * standard JSON-RPC `-32601` (Method not found); an unrecognized
 * *notification* SHOULD be ignored. This module supplies the request half;
 * the notification half is the adapter's existing behavior and stays.
 *
 * The refusal is emitted, never inferred. Live evidence says the `-32601`
 * convention is not reliably *observed* by agents — Kiro under
 * `--agent-engine v3` answers `-32603` with vendor-internal detail for
 * methods it does not know, and under the default engine answers `-32601`
 * to everything including its own documented methods. So
 * Station emits the conformant code and never derives support from a code it
 * receives. Nothing in this module reads an inbound error code.
 *
 * ## Part 2 — credentials only through a reviewed binding
 *
 * Standing invariant (docs/decisions/engine-credential-provider.md, which
 * supersedes the blanket ban ADR 0013 recorded): **Station answers an
 * agent's token or credential request only through a reviewed binding.** A
 * binding is one entry of {@link REVIEWED_ENGINE_CREDENTIAL_BINDINGS} or
 * {@link REVIEWED_ENGINE_SECRET_BINDINGS}: one exact wire method, the
 * credential kind, and the launch arguments Station itself adds to make the
 * engine delegate to the host. Its answer comes from an issuer whose only
 * source is Station's engine host-auth vault, never from Station's own
 * principals.
 *
 * The invariant is structural rather than a comment, in three places,
 * because a comment is exactly what the next lazy handler ignores:
 *
 * 1. {@link AcpInboundExtensionRegistry.register} *throws* for a
 *    credential-shaped method name. The generic path can never answer one.
 * 2. {@link AcpInboundExtensionRegistry.registerCredentialResponder} and
 *    {@link AcpInboundExtensionRegistry.registerSecretResponder} accept only
 *    the frozen table entries themselves (object identity, not a matching
 *    shape), and a credential responder only for a built-in launch whose
 *    argv carries the binding's delegation arguments.
 * 3. {@link AcpInboundExtensionRegistry.resolve} serves a credential-shaped
 *    method only from a reviewed responder, so even a registry whose generic
 *    map was mutated by some other route refuses rather than answers.
 *
 * ### What Station would hand over, if a generic handler could answer
 *
 * A reviewed binding hands over only an access token and its expiry from the
 * engine host-auth vault, scoped to the process's connection and credential
 * profile. API keys intentionally supplied by a person are stored separately
 * and passed through the configured connection environment; they do not
 * authorize answering an agent's credential request.
 *
 * Concretely, what is in reach in this process: `STATION_INTERNAL_API_TOKEN`
 * (`src-server/utils/internal-api-token.ts`) — a process-global bearer that
 * authenticates to Station's *entire* internal HTTP API, which the runtime
 * already places into the environment of built-in `station-control` MCP
 * servers. Also in reach: model-connection credentials held by
 * `ConnectionService`, and the per-session station-control bearer that
 * archive#1684 will ride over ACP's HTTP transport. An external agent process is a
 * less-trusted principal; handing any of those to it in response to a
 * self-described "auth" request would be a full privilege transfer prompted
 * by the untrusted side. Hence: the handler for that shape cannot be
 * written, not merely "must not be".
 *
 * ### What actually protects this, stated plainly
 *
 * Independent review made a point worth recording rather than papering
 * over: **the vocabulary predicate is not the protection, and on its own it
 * would be a weak one.**
 *
 * The old `onExtMethod: () => ({})` was, in one narrow sense, safe — it had
 * nothing in scope to leak. This module introduces a handler surface that
 * *could* close over `getInternalApiToken()`, and a name-based predicate is
 * a poor barrier for that. Ranked honestly:
 *
 * 1. **The allowlist is {@link REVIEWED_INBOUND_EXTENSION_REQUESTS}, and
 *    extending it requires a reviewed code change.** This is the
 *    protection. Its entries are requests addressed to a person, answered
 *    with what that person decided; nothing else is answerable.
 * 2. **Both production call sites construct their own registry and share it
 *    with nobody** — the adapter (per session) and the probe (per
 *    connection). No reference escapes, so no route can add a handler at
 *    runtime. This is pinned by a test rather than left as an accident,
 *    because the moment a *shared* registry is threaded through — the only
 *    reason the `registry` option exists — the guarantee degrades to (3).
 * 3. **The credential-name tripwire**, below. Last, not first.
 *
 * ### On the predicate's fuzziness
 *
 * {@link isCredentialShapedExtensionMethod} matches a vocabulary against the
 * method's word segments. It is deliberately generous, and the asymmetry is
 * the point: this predicate can only ever *deny*. It never grants, and it
 * never changes the default, which is already refusal. Over-matching costs a
 * reviewer conversation before an allowlist entry lands; under-matching
 * costs nothing today, because the allowlist is a short reviewed table and
 * every unlisted method is refused anyway. It is a tripwire on the obvious
 * vocabulary, not a proof of completeness. Known misses, so nobody mistakes
 * it for one: `_vendor/session/refresh` (no credential word),
 * `_vendor/getAPIToken` (the camelCase splitter breaks at `t|A`, so
 * `getAPIKey` matches but `getAPIToken` does not), any non-English method
 * name, and `_x/session/bootstrap` — which could return a credential without
 * naming one. The protection is (1) and (2) above; this is a tripwire on top.
 *
 * ### Why this module exists at all, given the SDK
 *
 * The SDK already answers `-32601` for an unhandled request when the client
 * app has no matching handler or raw fallback. Omitting Station's extension
 * request fallback would therefore produce the identical wire code.
 *
 * This module is therefore not what makes the wire correct — it is what
 * makes the refusal **observable and legible**: the named log line, the
 * disposition metric, the user-facing warning the adapter publishes, and the
 * reviewed registry a future allowlisted handler must go through. Any test
 * here that asserts only "an unknown request is refused with -32601" would
 * still pass with this whole module deleted; the tests that discriminate are
 * the ones asserting the log, the warning, and the registry behaviour.
 *
 * See `docs/adr/0013-bind-agent-extensions-to-the-declared-mechanism-not-method-names.md`
 * (Layer 1) for the surrounding design, and archive#1820 for the outbound
 * half, which this module deliberately does not implement.
 */
import { RequestError } from '@agentclientprotocol/sdk/unstable';
import {
  argvDelegatesTo,
  type EngineCredentialBinding,
  type EngineCredentialIssueResult,
  type EngineCredentialRefusal,
  type EngineCredentialScope,
} from '@kontourai/station-contracts/engine-credential-provider';
import {
  type EngineSecretRefusal,
  type EngineSecretStorageBinding,
  readEngineSecretRequest,
} from '@kontourai/station-contracts/engine-secret-storage';
import { acpInboundExtensionRequests } from '../../telemetry/metrics.js';

export type AcpInboundExtensionHandler = (
  method: string,
  params: Record<string, unknown>,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * Why an inbound extension request was refused. Bounded on purpose — it is
 * the only thing that reaches the metric (see the counter note below).
 */
export type AcpInboundExtensionRefusalReason =
  /** No reviewed handler is registered for this method. The default. */
  | 'no-handler'
  /** The method names a credential; refusing it is an invariant, not a gap. */
  | 'credential-shaped';

/**
 * Word vocabulary that makes a method name credential-shaped.
 *
 * Matched against the method's *word segments* (see
 * {@link extensionMethodWords}), not as substrings, so `_kiro/authoring`
 * does not collide with `auth`. Exported for the test that pins it.
 */
export const CREDENTIAL_SHAPED_WORDS: readonly string[] = Object.freeze([
  'apikey',
  'auth',
  'authenticate',
  'authenticated',
  'authentication',
  'authorization',
  'authorize',
  'authz',
  'bearer',
  'cert',
  'certificate',
  'cred',
  'credential',
  'credentials',
  'creds',
  'jwt',
  'key',
  'keychain',
  'keyring',
  'login',
  'oauth',
  'passphrase',
  'passwd',
  'password',
  'refreshtoken',
  'secret',
  'secrets',
  'signin',
  'token',
  'tokens',
]);

const CREDENTIAL_SHAPED_WORD_SET = new Set(CREDENTIAL_SHAPED_WORDS);

/**
 * Split an extension method into lowercase word segments, across both the
 * delimiters ACP method names use in the wild (`_kiro/auth/getAccessToken`,
 * `_kiro.dev/commands/execute`) and camelCase humps. `getAccessToken`
 * becomes `['get', 'access', 'token']`.
 */
export function extensionMethodWords(method: string): string[] {
  return method
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .flatMap((segment) => segment.split(/\s+/))
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
}

/**
 * True when the method name names a credential. Deny-only: see the module
 * header on why generosity here is free and precision is not required.
 */
export function isCredentialShapedExtensionMethod(method: string): boolean {
  return extensionMethodWords(method).some((word) =>
    CREDENTIAL_SHAPED_WORD_SET.has(word),
  );
}

/**
 * Thrown by {@link AcpInboundExtensionRegistry.register}. A distinct class so
 * the test asserting the invariant cannot pass on some unrelated `Error`.
 */
export class AcpCredentialBridgingRefusedError extends Error {
  constructor(readonly method: string) {
    super(
      `Refusing to register an inbound ACP extension handler for '${method}': ` +
        'its name is credential-shaped, and Station never answers an agent ' +
        "request for a token or credential. See this module's header for the " +
        'credentials that would otherwise be in reach.',
    );
    this.name = 'AcpCredentialBridgingRefusedError';
  }
}

/**
 * Who answers a reviewed inbound request. Vendor-scoped: each names one
 * vendor's documented contract, never a cross-vendor meaning.
 */
export type AcpInboundExtensionRequestHandlerId =
  | 'cursor.ask-question'
  | 'cursor.create-plan'
  | 'kiro.user-input'
  | 'kiro.mcp-elicitation'
  | 'kiro.open-external-url'
  | 'grok.ask-user-question'
  | 'client.terminal-facts';

export interface AcpReviewedInboundExtensionRequest {
  /** Exact method name; no prefix or namespace matching. */
  readonly method: string;
  readonly handler: AcpInboundExtensionRequestHandlerId;
  /** Where the request and the answer it takes were observed. */
  readonly evidence?: string;
}

/**
 * Every inbound extension request Station answers. Cursor sends both without
 * declaring them at `initialize`, so they are keyed by exact method name
 * (ADR 0013: inbound requests are answered only through a reviewed entry).
 * Only the chat adapter registers them; the availability probe has no person
 * to ask and keeps an empty registry.
 */
export const REVIEWED_INBOUND_EXTENSION_REQUESTS: readonly AcpReviewedInboundExtensionRequest[] =
  Object.freeze([
    Object.freeze({
      method: 'cursor/ask_question',
      handler: 'cursor.ask-question' as const,
    }),
    Object.freeze({
      method: 'cursor/create_plan',
      handler: 'cursor.create-plan' as const,
    }),
    // Kiro's agent service sends these three only to a client that announced
    // the matching `_meta.kiro` flag (`ACP_ANNOUNCED_CLIENT_META_FLAGS`), and
    // the flag is announced only while the handler is registered. Each is
    // answered from what a person decided, never with a JSON-RPC error
    // (`acp-input-requests.ts`).
    Object.freeze({
      method: '_kiro/userInput',
      handler: 'kiro.user-input' as const,
      evidence:
        'kirocrew acp/types.py METHOD_KAS_USER_INPUT and acp/elicitation.py (reply always `answered`)',
    }),
    Object.freeze({
      method: '_kiro/mcp/elicitation',
      handler: 'kiro.mcp-elicitation' as const,
      evidence:
        'kirocrew test/fixtures/acp_frames/kas/mcp-elicitation.jsonl (fields nested under params.elicitation)',
    }),
    // Grok sends its model's question unasked; a -32601 fails the tool and
    // the model asks in plain text instead.
    Object.freeze({
      method: '_x.ai/ask_user_question',
      handler: 'grok.ask-user-question' as const,
      evidence:
        'grok 1.0.77 live (src-server/services/acp/__tests__/fixtures/grok-1.0.77-session-frames.jsonl, ask-user-question-*): answer `{outcome: accepted, answers: {<question>: [<label>]}}` or `{outcome: cancelled}`',
    }),
    Object.freeze({
      method: '_kiro/openExternalUrl',
      handler: 'kiro.open-external-url' as const,
      evidence:
        'kirocrew test/fixtures/acp_frames/kas/open-external-url-live.jsonl; answer `{success: true}`, refusal a -32000 error (acp/runtime_host_requests.py)',
    }),
    // `client.terminal-facts`: what Station's terminal bridge is. Kiro's agent
    // service asks `{sessionId}` during session/new and reads `{shellType}`
    // (a non-empty string) as the grammar for its shell-command policy; a
    // -32601 falls back to `unknown` (KAS 0.66.102 acp-server.js
    // `resolveShellTypeInfo`; live: v3-refuse-shell capture, kiro-cli 2.35).
    Object.freeze({
      method: '_kiro/terminal/shell_type',
      handler: 'client.terminal-facts' as const,
      evidence:
        'live kiro-cli `acp --agent-engine v3` session/new (2026-11-13); answer shape read from @kiro/agent 0.66.102 resolveShellTypeInfo',
    }),
  ]);

// --- Reviewed credential and secret bindings -------------------------------

/**
 * Every engine credential Station may issue. Extending this table is a
 * reviewed code change, and it is the protection: a responder can be
 * registered only for one of these objects.
 *
 * - `kiro.get-access-token`: Kiro's agent service asks for an access token
 *   on its connection when launched with `--auth=acp-callback` (the bundle
 *   route, where Station owns the Kiro sign-in). The kiro-cli relay route
 *   runs `--auth-method cli`, so kiro-cli keeps its own credential and never
 *   asks.
 * - `codex.chatgpt-auth-tokens-refresh`: Codex's app-server account refresh.
 *   Not an ACP method, so the ACP registry refuses it; it is listed so the
 *   Codex side reviews against the same table. No delegation argument is
 *   pinned, and {@link argvDelegatesTo} refuses an empty one, so no
 *   responder can be installed for it until one is.
 */
export const REVIEWED_ENGINE_CREDENTIAL_BINDINGS: readonly EngineCredentialBinding[] =
  Object.freeze([
    Object.freeze({
      id: 'kiro.get-access-token' as const,
      kind: 'kiro.oidc-access-token' as const,
      wire: Object.freeze({
        protocol: 'acp' as const,
        method: '_kiro/auth/getAccessToken' as const,
        scope: 'connection' as const,
      }),
      delegationArgv: Object.freeze(['--auth=acp-callback']),
      evidence:
        'kirocrew test/fixtures/acp_frames/kas/host-auth-callback-live.jsonl and kas/bundle-session-live.jsonl; answer shape acp/kas_host_auth.py',
    }),
    Object.freeze({
      id: 'codex.chatgpt-auth-tokens-refresh' as const,
      kind: 'openai.chatgpt-auth-tokens' as const,
      wire: Object.freeze({
        protocol: 'codex-app-server' as const,
        method: 'account/chatgptAuthTokens/refresh' as const,
        push: 'account/login/start' as const,
      }),
      delegationArgv: Object.freeze([] as string[]),
      evidence:
        'Named by the Kiro-parity design; wire shape not observed or pinned in this repository',
    }),
  ]);

/**
 * Every engine-held secret store Station may serve. Same rule as
 * {@link REVIEWED_ENGINE_CREDENTIAL_BINDINGS}: only these objects register.
 *
 * - `kiro.mcp-grant-storage`: Kiro's agent service keeps MCP OAuth state in
 *   a client store it calls on the connection (no session). Keys outside
 *   `kiro.mcp.<sha256>.<kind>` are refused; only `client` and `tokens`
 *   outlive the engine process.
 */
export const REVIEWED_ENGINE_SECRET_BINDINGS: readonly EngineSecretStorageBinding[] =
  Object.freeze([
    Object.freeze({
      id: 'kiro.mcp-grant-storage' as const,
      methods: Object.freeze({
        get: '_kiro/secret/get',
        store: '_kiro/secret/store',
        delete: '_kiro/secret/delete',
      }),
      announce: Object.freeze({ metaNamespace: 'kiro', flag: 'secretStorage' }),
      keyPattern:
        /^kiro\.mcp\.[0-9a-f]{64}\.(client|tokens|verifier|discovery)$/,
      persistedKinds: Object.freeze(['client', 'tokens'] as const),
      maxValueChars: 65_536,
      scope: 'connection-profile' as const,
      evidence:
        'kirocrew acp/kas_secret_storage.py (key policy, persisted kinds, value cap) and test/test_kas_mcp_secret_storage.py',
    }),
  ]);

/** Whether `binding` is one of the reviewed table's own objects. */
function isReviewedEngineCredentialBinding(
  binding: EngineCredentialBinding,
): boolean {
  return REVIEWED_ENGINE_CREDENTIAL_BINDINGS.includes(binding);
}

/** Whether `binding` is one of the reviewed table's own objects. */
function isReviewedEngineSecretBinding(
  binding: EngineSecretStorageBinding,
): boolean {
  return REVIEWED_ENGINE_SECRET_BINDINGS.includes(binding);
}

/**
 * The server side of a reviewed credential binding, implemented over the
 * engine host-auth vault. Its scope is fixed when it is built: the
 * connection and credential profile of the one process it answers.
 * Concurrency sharing, the hourly cap, policy and audit are the issuer's.
 */
export interface EngineCredentialIssuer {
  readonly scope: EngineCredentialScope;
  issue(binding: EngineCredentialBinding): Promise<EngineCredentialIssueResult>;
}

/**
 * The server side of a reviewed secret binding, scoped like the issuer.
 * Values never reach a log or an error message.
 */
export interface EngineSecretStore {
  readonly scope: EngineCredentialScope;
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** How the process that would be answered was launched. */
export interface AcpCredentialLaunchFacts {
  /** Launched from a built-in descriptor, not a user, custom or plugin command. */
  readonly builtinDescriptor: boolean;
  /** The arguments the process was actually launched with. */
  readonly argv: readonly string[];
}

/** Thrown when a responder registration is refused. */
export class AcpReviewedBindingRefusedError extends Error {
  constructor(
    readonly bindingId: string,
    reason: string,
  ) {
    super(`Refusing to register a responder for '${bindingId}': ${reason}.`);
    this.name = 'AcpReviewedBindingRefusedError';
  }
}

/** JSON-RPC code for a refused credential issue; its message carries no token. */
export const ENGINE_CREDENTIAL_REFUSED_CODE = -32000;

const CREDENTIAL_REFUSAL_TEXT: Record<EngineCredentialRefusal, string> = {
  'signed-out': 'Station has no signed-in credential for this engine',
  'refresh-rejected': 'The credential could not be refreshed; sign in again',
  'rate-limited': 'Too many credential requests; try again later',
  'policy-off': 'Host-issued engine credentials are off by policy',
  'scope-mismatch': 'This process is not scoped to that credential',
  unavailable: 'The credential is unavailable',
};

const SECRET_REFUSAL_TEXT: Record<EngineSecretRefusal, string> = {
  'unknown-method': 'Unknown secret method',
  malformed: 'Malformed secret request',
  'key-refused': 'Key outside the allowed namespace',
  'value-too-long': 'Value exceeds the size limit',
};

function credentialResponder(
  binding: EngineCredentialBinding,
  issuer: EngineCredentialIssuer,
): AcpInboundExtensionHandler {
  return async () => {
    let result: EngineCredentialIssueResult;
    try {
      result = await issuer.issue(binding);
    } catch {
      // The issuer's error text may name a path or a vendor response; none of
      // it goes on the engine's pipe.
      result = { kind: 'refused', reason: 'unavailable' };
    }
    if (result.kind === 'refused') {
      throw new RequestError(
        ENGINE_CREDENTIAL_REFUSED_CODE,
        CREDENTIAL_REFUSAL_TEXT[result.reason],
      );
    }
    const { accessToken, expiresAt, attributes } = result.issue;
    // Attributes first so a vendor value can never replace the token fields.
    return { ...attributes, accessToken, expiresAt };
  };
}

function secretResponder(
  binding: EngineSecretStorageBinding,
  store: EngineSecretStore,
): AcpInboundExtensionHandler {
  return async (method, params) => {
    const request = readEngineSecretRequest(binding, method, params);
    if ('refused' in request) {
      throw RequestError.invalidParams(
        undefined,
        SECRET_REFUSAL_TEXT[request.refused],
      );
    }
    switch (request.op) {
      case 'get': {
        const value = await store.get(request.key);
        return value === undefined ? {} : { value };
      }
      case 'store':
        await store.store(request.key, request.value);
        return {};
      case 'delete':
        await store.delete(request.key);
        return {};
    }
  };
}

/**
 * The only way an inbound agent→client extension request gets answered at
 * all. Empty by default; a caller registers entries from
 * {@link REVIEWED_INBOUND_EXTENSION_REQUESTS} through {@link register}, and
 * reviewed credential or secret bindings through their own methods.
 */
export class AcpInboundExtensionRegistry {
  private readonly handlers = new Map<string, AcpInboundExtensionHandler>();
  /** Filled only by the reviewed-binding methods below. */
  private readonly reviewedResponders = new Map<
    string,
    AcpInboundExtensionHandler
  >();

  /**
   * @throws {AcpCredentialBridgingRefusedError} if the method is
   * credential-shaped: those are answerable only through a reviewed binding.
   */
  register(method: string, handler: AcpInboundExtensionHandler): void {
    if (isCredentialShapedExtensionMethod(method)) {
      throw new AcpCredentialBridgingRefusedError(method);
    }
    this.handlers.set(method, handler);
  }

  /**
   * Answer a reviewed credential binding's ACP method from `issuer`.
   *
   * @throws {AcpReviewedBindingRefusedError} unless `binding` is one of
   * {@link REVIEWED_ENGINE_CREDENTIAL_BINDINGS}' own objects, its wire is
   * ACP, and `launch` is a built-in descriptor launch whose argv carries the
   * binding's delegation arguments.
   */
  registerCredentialResponder(
    binding: EngineCredentialBinding,
    issuer: EngineCredentialIssuer,
    launch: AcpCredentialLaunchFacts,
  ): void {
    const id = typeof binding?.id === 'string' ? binding.id : '(unknown)';
    if (!isReviewedEngineCredentialBinding(binding))
      throw new AcpReviewedBindingRefusedError(id, 'not a reviewed binding');
    if (binding.wire.protocol !== 'acp')
      throw new AcpReviewedBindingRefusedError(id, 'not an ACP binding');
    if (!launch.builtinDescriptor)
      throw new AcpReviewedBindingRefusedError(
        id,
        'the process was not launched from a built-in descriptor',
      );
    if (!argvDelegatesTo(launch.argv, binding.delegationArgv))
      throw new AcpReviewedBindingRefusedError(
        id,
        'the launch does not carry the delegation arguments',
      );
    this.reviewedResponders.set(
      binding.wire.method,
      credentialResponder(binding, issuer),
    );
  }

  /**
   * Answer a reviewed secret binding's methods from `store`.
   *
   * @throws {AcpReviewedBindingRefusedError} unless `binding` is one of
   * {@link REVIEWED_ENGINE_SECRET_BINDINGS}' own objects.
   */
  registerSecretResponder(
    binding: EngineSecretStorageBinding,
    store: EngineSecretStore,
  ): void {
    const id = typeof binding?.id === 'string' ? binding.id : '(unknown)';
    if (!isReviewedEngineSecretBinding(binding))
      throw new AcpReviewedBindingRefusedError(id, 'not a reviewed binding');
    const responder = secretResponder(binding, store);
    for (const method of Object.values(binding.methods))
      this.reviewedResponders.set(method, responder);
  }

  /** Remove every handler for `method`, reviewed or generic. */
  unregister(method: string): void {
    this.handlers.delete(method);
    this.reviewedResponders.delete(method);
  }

  /**
   * Exact match only. A near-miss (`_kiro/` vs `_kiro.dev/`, both live
   * simultaneously in one vendor's binary) resolves to nothing and is
   * refused, rather than fuzzy-matched onto a handler that meant the other
   * spelling.
   *
   * A credential-shaped method resolves only to a reviewed responder, so a
   * handler installed in the generic map by any route that bypassed
   * {@link register} still never runs.
   */
  resolve(method: string): AcpInboundExtensionHandler | undefined {
    const reviewed = this.reviewedResponders.get(method);
    if (reviewed) return reviewed;
    if (isCredentialShapedExtensionMethod(method)) return undefined;
    return this.handlers.get(method);
  }

  /** Whether {@link resolve} would answer `method`: what client announcements key on. */
  answers(method: string): boolean {
    return this.resolve(method) !== undefined;
  }

  get size(): number {
    return this.handlers.size + this.reviewedResponders.size;
  }
}

interface AcpInboundExtensionPolicyOptions {
  /** Defaults to a fresh empty registry — i.e. refuse everything. */
  registry?: AcpInboundExtensionRegistry;
  /**
   * Structured (pino-style) logger, matching the rest of the ACP substrate:
   * `warn(fields, message)`. Fields are filterable; an interpolated string
   * is not, and this log — not the OTel counter — is the channel a refusal
   * is actually discovered on.
   */
  logger?: {
    // Station's Logger convention: message first, context second. This was
    // pino's (fields, message) order, while every caller passes a Station
    // logger — so the fields object landed where the message belongs and
    // `sanitizeFreeText` threw out of a log statement (see acp-probe.ts).
    warn?: (message: string, context?: Record<string, unknown>) => void;
  };
  /** Connection id, for the log line only. Never reaches the metric. */
  connectionId?: string;
  /**
   * Test/inspection seam. Called for every refusal, synchronously, before
   * the error is thrown.
   */
  onRefused?: (
    method: string,
    reason: AcpInboundExtensionRefusalReason,
  ) => void;
}

/**
 * Build the `onExtMethod` callback for {@link createACPBridgeClient}.
 *
 * Refuses with `RequestError.methodNotFound(method)`, which the ACP SDK's
 * dispatcher turns into a real `-32601` JSON-RPC error response on the wire
 * (`jsonrpc.js` `errorToResult`: a thrown `RequestError` is emitted verbatim;
 * anything else would become `-32603`). Both refusal reasons emit the same
 * code deliberately — a probing agent learns nothing from the response about
 * whether Station recognised the method.
 */
export function createAcpInboundExtensionRequestHandler(
  options: AcpInboundExtensionPolicyOptions = {},
): AcpInboundExtensionHandler {
  const registry = options.registry ?? new AcpInboundExtensionRegistry();
  /** Methods already logged by THIS handler — see the dedupe note below. */
  const loggedMethods = new Set<string>();

  // `async` deliberately: a synchronously-throwing handler would still be
  // caught by the SDK's dispatcher, but it makes the refusal invisible to
  // every `.rejects`-shaped assertion and to any caller that only guards the
  // returned promise. Refusal must be a rejection, not a surprise.
  return async (method, params) => {
    const handler = registry.resolve(method);
    if (handler) {
      // Bounded attribute only. The method name is agent-controlled and
      // therefore unbounded cardinality; it goes to the log, never here.
      acpInboundExtensionRequests.add(1, { disposition: 'answered' });
      return handler(method, params);
    }

    const reason: AcpInboundExtensionRefusalReason =
      isCredentialShapedExtensionMethod(method)
        ? 'credential-shaped'
        : 'no-handler';

    acpInboundExtensionRequests.add(1, { disposition: `refused-${reason}` });

    // The log is the primary channel, not a secondary one. Station's OTel
    // instruments are no-ops unless OTEL_EXPORTER_OTLP_ENDPOINT is set
    // (`src-server/telemetry.ts`), so on a default install the counter above
    // discards every write. A new inbound dependency — the next
    // `_kiro/terminal/shell_type` — has to be visible without an OTLP
    // collector, or the refusal is silent exactly where most users run.
    //
    // Logged ONCE per method per handler. A refused method is a standing
    // condition, not an event: the availability probe re-runs every 60s
    // forever and a v3 connection refuses on every single run, so an
    // undeduped line is one warning per connection per minute, permanently,
    // for something that will never change. That is precisely the treatment
    // the transcript was deliberately spared; the log deserves it too.
    // (Each handler is one session or one ACPProbe instance — see the
    // "what actually protects this" note above on registry scoping.)
    if (!loggedMethods.has(method)) {
      loggedMethods.add(method);
      options.logger?.warn?.('refused inbound ACP extension request', {
        method,
        reason,
        code: -32601,
        connectionId: options.connectionId,
      });
    }

    options.onRefused?.(method, reason);

    throw RequestError.methodNotFound(method);
  };
}
