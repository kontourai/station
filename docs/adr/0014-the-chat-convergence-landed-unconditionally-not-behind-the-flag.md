# ADR 0014 — The chat convergence landed unconditionally, not behind the flag

**Status:** Accepted. Supersedes ADR-0010's *cutover mechanism* clause only. ADR-0010's Option A decision, its privacy constraint, and its no-migration decision all stand.

## Context

ADR-0010 chose to route managed chat through orchestration behind `STATION_FEATURES=managed-chat-orchestration`, default off, with the flag flip as the staged, reversible cutover. station#1255 then planned the sequence: reach parity, flip the flag default-on as "the single irreversible act", then retire the direct-path duplication.

**That is not what happened.** On 2026-08-01/02 the station#1418 / station#1415 execution-target slices cut every interactive caller over to `POST /api/orchestration/chat` → `executeForegroundMessage` **unconditionally**, and deleted the direct-path send from both clients:

- `5cee51ae` cli: unify execution targeting
- `5f91641c` ui: route chat through Agent targets (−359 from the send hook, −969 from its test)
- `172beca2` cli: remove raw provider session dispatch
- `74b5cf63` execution: remove public provider bypass
- `dcdb7645` cli: remove retired execution clients (−706 from `session-client.ts`)

The flag was never touched. #1418's own body records that it "integrates with #982 and #1255"; it and its parent epic #1415 are closed.

## Decision

Record the cutover as having landed unconditionally. `managed-chat-orchestration` is **inert** and is not the mechanism by which anything switched.

Concretely, on `main` today:

- The flag is parsed (`station-features.ts`), hung off the runtime getter, and injected into `GET /config/app` (`config.ts`) — and **no client consumer reads it**. The branches it once gated were deleted by the #1418 rewrite. It switches nothing.
- The single interactive seam is `POST /api/orchestration/chat` → `executeForegroundMessage` → provider adapter.
- `POST /api/agents/:slug/chat` remains the Station-engine **execution engine**, reached by the `station-agent` adapter over an internal loopback. That is ADR-0010's design and it is unchanged and still correct: the whole `/chat` choke point — feedback/behaviour-guideline injection, RAG, conversation-title generation, per-turn dedup, the FileMemory transcript — still runs for every Station-engine chat.

## Consequences

**The parity validation never ran as a gate.** ADR-0010's staged rollout existed so parity could be established before the direct path was retired. Landing the cutover unconditionally skipped that step, and two regressions shipped unnoticed as a result:

- Attachments to Station agents are refused — the UI offers the affordance on *model* capability while the orchestration seam gates on *provider* capability, and the `station-agent` adapter declares neither `image-input` nor `file-input` (station#1885).
- `station chat --title` is hard-rejected while the CLI synopsis still advertised it. ADR-0010 predicted this exact gap and called it follow-up work.

Both are consequences of the mechanism change recorded here, not of the destination, which remains the right one.

**Three E2E specs still mock `**/api/agents/*/chat`**, a URL the UI no longer calls — possibly-vacuous coverage of the send path, pending an E2E run to settle.

**The flag's plumbing is now dead code** and should be retired. One caveat worth keeping: the `settings-registry.ts` entry is what strips a stale `managedChatOrchestration` key out of a polluted `config/app.json` on a GET→PUT round trip. Removing the registry entry lets an old file resurface the key, so it should outlive the rest of the plumbing.

**Correction (station#3237):** the deletion above was incomplete. The UI's `conversations-store.ts`/`ConversationsContext`/`useConversationActions().sendMessage` chain still called the SDK's `streamConversationTurn`, which still posted to `/api/agents/:slug/chat` — fully wired, with no production caller (every live send already went through `useSendMessage`, orchestration-only). Removed with no other consumers found. The SDK's `streamConversationTurn` export itself is untouched; it is a deliberately public plugin primitive (`packages/sdk/src/__tests__/publicBarrel.test.ts`), independent of what Station's own UI calls.

**What this ADR does not decide.** `POST /api/agents/:slug/chat` is currently a publicly reachable, pairing-scoped route, so a paired peer can drive a Station agent through the non-orchestration path and produce a chat with no run, no event-store row, and no approvals vocabulary. Demoting it to internal-only is the real "retire the direct path" act and is one-way and owner-gated. It is tracked on station#1255, not decided here.

## References

station#1255, station#1418, station#1415, station#1885, station#1888, ADR-0010.
