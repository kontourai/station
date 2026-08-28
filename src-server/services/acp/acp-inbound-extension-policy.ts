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
 * ## Part 2 — the no-credential-bridging invariant
 *
 * Standing invariant: **Station never answers an agent's token or credential
 * request.** Not today, and not after some later slice teaches Station to
 * answer other extension methods.
 *
 * The invariant is structural rather than a comment, in two independent
 * places, because a comment is exactly what the next lazy handler ignores:
 *
 * 1. {@link AcpInboundExtensionRegistry.register} *throws* for a
 *    credential-shaped method name. There is no code path by which such a
 *    method acquires a handler.
 * 2. {@link createAcpInboundExtensionRequestHandler} re-checks at dispatch,
 *    so even a registry mutated by some other route refuses rather than
 *    answers.
 *
 * ### What Station would have handed over, if it had answered
 *
 * Station holds no credential belonging to any engine, and acquiring one is
 * not the fix: **Station does not become a Kiro auth host.** Holding and
 * refreshing a third-party engine's credentials is a product decision the
 * owner has not made, and it points the opposite way from this invariant.
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
 * 1. **The allowlist is empty, and filling it requires a reviewed code
 *    change.** This is the protection, and it is the same one that held
 *    before. Nothing is answerable out of the box.
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
 * costs nothing today, because the allowlist is empty and every unlisted
 * method is refused anyway. It is a tripwire on the obvious vocabulary, not
 * a proof of completeness. Known misses, so nobody mistakes it for one:
 * `_vendor/session/refresh` (no credential word), `_vendor/getAPIToken` (the
 * camelCase splitter breaks at `t|A`, so `getAPIKey` matches but
 * `getAPIToken` does not), any non-English method name, and
 * `_x/session/bootstrap` — which could return a credential without naming
 * one. The protection is (1) and (2) above; this is a tripwire on top.
 *
 * ### Why this module exists at all, given the SDK
 *
 * The SDK already answers `-32601` for a method with no handler
 * (`jsonrpc.js` responds `methodNotFound` when no handler claims a request,
 * and `acp.js` only registers the catch-all `if (implementation.extMethod)`).
 * So *simply not supplying `onExtMethod`* would produce the identical wire
 * code with no new code at all.
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
import { RequestError } from '@agentclientprotocol/sdk';
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
 * The only way an inbound agent→client extension request gets answered at
 * all. Empty by default and empty today: no method in the live ecosystem has
 * a reviewed Station handler.
 */
export class AcpInboundExtensionRegistry {
  private readonly handlers = new Map<string, AcpInboundExtensionHandler>();

  /**
   * @throws {AcpCredentialBridgingRefusedError} if the method is
   * credential-shaped — the structural half of the no-bridging invariant.
   */
  register(method: string, handler: AcpInboundExtensionHandler): void {
    if (isCredentialShapedExtensionMethod(method)) {
      throw new AcpCredentialBridgingRefusedError(method);
    }
    this.handlers.set(method, handler);
  }

  /**
   * Exact match only. A near-miss (`_kiro/` vs `_kiro.dev/`, both live
   * simultaneously in one vendor's binary) resolves to nothing and is
   * refused, rather than fuzzy-matched onto a handler that meant the other
   * spelling.
   *
   * Re-checks the credential shape, so a handler installed by any route that
   * bypassed {@link register} still never runs.
   */
  resolve(method: string): AcpInboundExtensionHandler | undefined {
    if (isCredentialShapedExtensionMethod(method)) return undefined;
    return this.handlers.get(method);
  }

  get size(): number {
    return this.handlers.size;
  }
}

export interface AcpInboundExtensionPolicyOptions {
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
