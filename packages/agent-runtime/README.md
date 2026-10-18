# Experimental agent runtime

`@kontourai/agent-runtime` retains model requests and completed native streams
for an authorized generation. The existing VoltAgent or Strands loop continues
to choose model calls. This private workspace package is experimental Tier 1;
it is not a released package or Station restart integration.

The root entry exports the twelve model commands, coordinator, staged memory
adapter, fixed policy and ordered outbox drain. `/sqlite` uses a host-supplied
Node 24 `DatabaseSync`. `/ai-sdk`, `/voltagent` and `/strands` bind the pinned
AI SDK v3 interface, VoltAgent 2.10.0 and Strands 1.19.0 VercelModel. Optional
framework dependencies are exact peers. The package imports no Station code.

The host supplies authorization/current implementation and writer-generation
closures, real owner liveness, and the already-authorized source cutoff.
`start` captures effective entry bytes before creating a frozen native Agent.
`restore` requires the full observed fence and proven-dead previous owner;
it returns the retained entry without consulting a new composer. Construct a
fresh consumer from that entry, use `control.run` around the native call and
stream consumption, then `finish('completed')`. Explicit `cancel` quiesces the
owned stream and records cancellation. A disconnected host transport does not
implicitly call it.

The first `begin.execute` COMMIT acknowledgment permits one provider dispatch.
An acknowledgment retry returns a receipt, never another dispatch grant.
Recovery can resend and incur model billing again. Every visible prefix part
commits before projection. The ordered suffix beginning with a tool-enabling
part or successful terminal remains held through EOF, strict tape validation,
durable body put and complete COMMIT acknowledgment. Empty-prefix completion
uses `lastPartialSequence: -1`; otherwise it is the last committed sequence.

Actual tools refuse before their registered body and block the run, even when
the framework catches the refusal. Client-tool responses exercise the model
commit barrier; they do not establish durable tools, results or approvals.
There are no tool/approval commands, tool replay declarations or new agent loop.

SQLite bodies are immutable, content-addressed BLOBs in the existing host
connection's `agent_runtime_` namespace. Opening requires WAL, FULL synchronous
mode and foreign keys; wrappers validate them and do not change host pragmas.
External/nested transactions, future/partial schema and unsupported writers
refuse. Body COMMIT precedes journal adoption; an orphan body grants nothing.
Journal, operation receipt and outbox commit in one real transaction. Closing
a wrapper does not close the host connection.

The SQLite projection sink retains raw partial audit and stable abort markers.
Its ready view requires a settled run and every required outbox disposition
applied and acknowledged. It returns only completed tapes in request order.
It is a response projection, with no editable conversation/history API. No
unresolved row is evicted. Defaults are 128 open runs, 1024 calls/run, 32 MiB
per body/request/response, 16 MiB committed partials/attempt, 7-day settled
replay and 30-day generation protection. Fixed bounds may be reduced at open.
There is no public GC/deletion API; retained generations never reopen by age.

The reduced codec supports text/reasoning and known finite native settings.
`providerOptions` must be absent or empty. Request-defined headers, files,
URLs/binary, raw/provider-executed parts, stateful continuation, Dispatch or
fallback, native Strands Bedrock, unsupported hooks and unknown codecs refuse
durable opt-in. `doGenerate` is unsupported. Debug request/response envelopes
and provider metadata are omitted on first delivery and replay; warnings are
sanitized identically, and timestamps round-trip as Date values. This is not
full provider fidelity or literal authenticated HTTP byte identity.

The pinned Zod 4.6.5 conversion's direct function-tool `inputSchema` may carry
one exact non-enumerable `~standard` sidecar. Only its admitted data-descriptor
shape is excluded; every enumerable schema value remains pinned. The codec
never calls its functions, and its vendor label proves no origin or authority.
Other hidden/accessor/symbol fields refuse, including at nested schema paths.

Package tests use genuine native framework construction with scripted transports,
the actual SQLite BLOB/journal/sink, the public generic Monument crash store,
and separate SIGKILL body controls. They do not qualify live provider behavior,
Station FileMemory, `/chat`, approvals, boot recovery, terminal custody,
capability profiles, performance or release. See [CONTEXT.md](CONTEXT.md) for
owners and [ADR 0005](../../docs/adr/0005-require-a-second-consumer-before-extraction.md)
for the package boundary.
