# AI↔UI bridge expansion — scoping

*Drafted 2026-06-17. Scopes the roadmap backlog item "AI↔UI bridge expansion (UIBlock form/chart/code, `render_component`, UI-state capture)" (Phase S2 follow-on). This is a **plan**, not an implementation — it names the seams, the design decisions, the phasing, and the calls that are yours.*

---

## 1. Two rendering lanes (and why this is the safe one)

Station has **two** ways an agent can put structured UI in front of a user. They are different mechanisms with different threat models, and this expansion is deliberately the *second* one:

| | **Lane A — MCP-UI host** (shipped) | **Lane B — chat-native UIBlocks** (this expansion) |
|---|---|---|
| Content | Arbitrary HTML/JS from an MCP server | A fixed, declarative block vocabulary (data only) |
| Rendering | Sandboxed `<iframe>` (opaque or dedicated origin) | Host-rendered React components (`UIBlockRenderer`) |
| Trust model | Fortress sandbox, CSP deny-by-default, postMessage validation | **Safe by construction** — no HTML injection; the agent supplies *data*, Station owns the markup |
| Source | External MCP servers (Surface, Survey, third-party) | Station's own tools / the agent directly |
| Vocabulary | Unbounded | `card`, `table` today → `form`, `chart`, `code` next |
| Doc | [`mcp-ui-host.md`](./mcp-ui-host.md) | this doc |

The expansion lives entirely in Lane B. Its security posture is **data validation**, not sandboxing: because rendering is fixed React over a typed contract, the worst a hostile/buggy block can do is render wrong — never execute. That is the whole reason Lane B exists alongside the iframe host: it is the *cheap, safe* path for the common case (show me a form, a chart, a snippet), reserving the sandbox for genuinely arbitrary UI.

## 2. What exists today (the foundation is real)

The card/table pipeline is complete and e2e-tested (`tests/ui-blocks.spec.ts`). The flow, end to end:

1. **Contract** — `packages/contracts/src/ui-block.ts`: `UIBlockBase` + `UICardBlock` + `UITableBlock`, union `UIBlock`.
2. **Emission** — any tool whose result output carries a `uiBlock` / `uiBlocks` field. No special tool required; it already works.
3. **Extraction** — `src-ui/src/utils/uiBlocks.ts` `extractUIBlocks(output)` finds + normalizes + validates blocks against the contract.
4. **Ingestion** — `src-ui/src/hooks/orchestration/streamHandlers.ts` `handleToolCompletedEvent` → `upsertToolResultBlocks` keys blocks by `toolCallId` and splices them into the message parts after the tool part (`messageParts.ts`).
5. **Render** — `src-ui/src/components/chat/UIBlockRenderer.tsx` dispatches by `type`; `StreamingMessage.tsx` (live) and `message-bubble/MessageContent.tsx` (persisted) both mount it for `ui-block` parts. Unknown types render `null` — the clean extension point.

So the expansion is **additive at four files** for each new block type, with one genuinely new capability (state capture) that needs a new seam.

## 3. The three additions

### 3a. `form` / `chart` / `code` block types

Extend the contract union and the renderer. Proposed contract shapes (final field names TBD in implementation):

```ts
interface UIFormBlock  extends UIBlockBase { type: 'form'; fields: UIFormField[]; submitLabel?: string; }
interface UIChartBlock extends UIBlockBase { type: 'chart'; chartType: 'bar'|'line'|'pie'; series: …; }
interface UICodeBlock  extends UIBlockBase { type: 'code'; language: string; code: string; }
```

- **`code`** is nearly free — `HighlightedCodeBlock` already exists (shiki). Pure render, no new state, no new deps. *Do this first as the warm-up.*
- **`form`** is the high-value one — it is the only block that needs **state capture** (§3c), and it is what trust workflows actually want (approve/annotate/correct a finding inline). The first real tenant.
- **`chart`** is the lowest-urgency and the only one with a **dependency decision** (see open decisions). Trust panels lean card/table/form, not charts. *Do this last.*

### 3b. `render_component` — the agent-facing affordance

Today UIBlocks render only when a *domain tool* happens to emit them. `render_component` is a thin **builtin tool** that lets the agent emit a block directly — "draw this form / chart / card" — without a domain tool in the loop. It is a small but real affordance: it gives the agent a first-class, validated contract for producing UI, and it is the natural thing to expose to managed agents as a capability.

Recommendation: keep it **minimal** — the tool validates its args against the `UIBlock` contract and returns `{ uiBlock }`. No new rendering path (it reuses the whole Lane B pipeline). It is read-only/no-side-effect, so it needs no new approval layer. This is ~one builtin tool definition, not a subsystem.

**Producer-seam investigation (2026-06-17) — settled.** The open question was *which* seam delivers a tool's `{ uiBlock }` to `event.output` so the renderer sees it. Verified against the real runtime:

- **MCP tools were not selected for this builtin.** At the time of this
  decision, Station delegated MCP ownership to VoltAgent and lost
  `structuredContent`. Station now owns the official MCP client and preserves
  full results, so that historical limitation is gone; `render_component`
  remains a builtin because its native-tool path and trust boundary are already
  proven and do not require a server integration.
- **Builtin "vended" tools can, and the seam already exists.** `createBuiltinVendedTool` (`src-server/runtime/tools/vended-tool-compat.ts`) builds Station-controlled voltagent `Tool`s whose `execute` return is a **plain object** surfaced verbatim as the tool-result output (voltagent `index.js`: `output = part.output`), which flows `chunk.output` → `emitToolResult` → SSE `event.output` → `extractUIBlocks`. The existing `http_request` tool returning `{ status, headers, body }` renders through this exact path in production today.

**Decision: implement `render_component` as a builtin vended tool** (a new `station_render_component` registry entry). No new runtime seam, no voltagent fork — it reuses the proven native-tool path and returns `{ uiBlock }` validated against the contract. Verification on build: the first server-side "real native tool → `event.output.uiBlock`" test, plus a live smoke (agent calls `render_component` → block renders in chat).

### 3c. UI-state capture (the one genuinely new seam)

When a user fills in a rendered `form` and submits, that data must re-enter the conversation. **The key design fact:** by the time the user interacts, the agent's run has almost always *ended* — so we cannot resolve it as a pending tool-result continuation tied to the original `toolCallId`. The interaction is asynchronous.

**Recommended model: a structured follow-up turn.** Form submit emits a new user turn carrying both a human-readable summary ("Submitted the review form") and the structured payload (JSON), tagged so the agent recognizes it as a response to the block it rendered (carry the originating `blockId` / `toolCallId` for correlation). This is conversation-native, works with the existing turn model, needs no long-lived pending-call state, and mirrors how the MCP-UI host already proxies iframe-initiated tool calls — but for the chat-native lane.

New seam required:
- **Client:** a form-specific component captures controlled-input state and, on submit, emits a new event (`ui.form-submitted` with `{ blockId, toolCallId, formData }`).
- **Transport:** handler in `streamHandlers.ts` → a new server endpoint (`POST /orchestration/:sessionId/ui-state` or fold into the existing command path).
- **Server:** injects the submission as the next user turn (or a structured message part) into the session, so the agent's next turn sees it.

## 4. Files to touch (per addition)

| Addition | Contract | Extract/normalize | Render | New seam |
|----------|----------|-------------------|--------|----------|
| `code` | `ui-block.ts` (+type) | `uiBlocks.ts` | `UIBlockRenderer.tsx` (reuse `HighlightedCodeBlock`) | — |
| `form` | `ui-block.ts` (+type, field schema) | `uiBlocks.ts` (per-field validation) | `UIBlockRenderer.tsx` (controlled inputs + submit) | **state capture (§3c)** |
| `chart` | `ui-block.ts` (+type, series schema) | `uiBlocks.ts` | `UIBlockRenderer.tsx` (+chart dep) | — |
| `render_component` | — | — | — | one builtin tool returning `{ uiBlock }` |
| state capture | event type | — | form component emits | `streamHandlers.ts` handler + `POST .../ui-state` route + server re-injection |

Plus, per project rules: OTel instrumentation for the new operations (e.g. `station.ui_block.rendered`, `station.ui_block.submitted`), an `e2e-manifest.mjs` bucket assignment for any new Playwright spec, and extending `tests/ui-blocks.spec.ts` to cover the new types.

## 5. Recommended phasing

1. **Phase 1 — `code` block + `render_component`.** ✅ **Shipped** (#36, #38). Cheapest win; proved the agent-facing affordance end to end with zero new deps. `render_component` rides the builtin vended-tool seam (see §3b investigation).
2. **Phase 2 — `form` block + UI-state capture.** ✅ **Shipped.** The interactive phase: a host-rendered `form` block with required-field validation, and the state-capture seam — on submit the values re-enter the conversation as a **new user turn** carrying a human-readable summary + a tagged `__stationFormSubmission` JSON payload (the `formatFormSubmission` helper). Re-entry reuses the existing chat send path (`useSendMessage` → `POST /api/agents/:slug/chat`) via a `UIBlockActionsContext` provided at `ChatMessageList` — **no new server endpoint**. `render_component` was extended to emit `form` blocks too. Covered by unit tests + a live e2e (render → required-guard → submit → tagged turn sent → form locks).
3. **Phase 3 — `chart` block.** Last, gated on the charting-dependency decision. Defer until a tenant actually needs a chart; trust panels mostly don't.

## 6. Open decisions (yours)

1. **Charting dependency.** `recharts` (heavy, batteries-included) vs hand-rolled SVG for bar/line/pie (zero-dep, limited) vs deferring `chart` indefinitely until a real tenant asks. Recommendation: **defer** — ship `code` + `form` first; revisit `chart` when a panel needs it, and prefer zero-dep SVG for the basic three if so.
2. **`render_component` exposure.** Expose it to *all* agents, or only *managed* agents as a declared capability (per the entity-hierarchy contract, UI-emission is arguably a managed-agent capability like skills/tools)? Recommendation: **managed-agent capability**, consistent with the connected/managed boundary.
3. **State-capture re-entry shape.** ✅ **Decided: synthetic structured turn** (Phase 2). On submit the form sends a new user turn (human summary + tagged `__stationFormSubmission` JSON) via the existing chat path — no new agent-runtime concept, no new endpoint.
4. **Scope of "form".** ✅ **Decided: minimal** (Phase 2) — `text` / `textarea` / `select` / `checkbox` + required-field validation + submit. Matches the approve/annotate/correct trust-workflow use case. Richer validation/multi-step deferred until a tenant needs it.

## 7. Relationship to the rest of the system

- **First tenant:** the trust/readiness panels (the roadmap names them). They render as cards/tables today; the `form` block is what turns them from read-only into *actionable* (approve a gate, annotate a finding) without leaving chat.
- **Not a Lane A replacement:** products with genuinely custom UI (Surface, Survey) keep shipping MCP-UI servers (Lane A). Lane B is for the agent's own structured output and Station-native panels.
- **Extraction watch (S5):** if Lane B's block vocabulary ever grows a second non-Station consumer (another Kontour product rendering the same `UIBlock` contract), the contract package is already the clean seam — but that is an S5 promotion question, not this expansion's to force.
