# Evidence Governance Context

This area connects execution records to reviews, configured gates, and
repository readiness. Ordinary chat is not automatically a gated Flow run.

## Language

**Receipt**:
The durable connection between a claim, evidence, and a verdict. Receipts are Station's answer to "why was this allowed?"
_Avoid_: summary

**Evidence**:
An artifact used to support or refute a claim. Evidence can be command output, readiness records, files, human attestations, hosted-panel tool calls, or trust artifacts.
_Avoid_: proof before evaluation

**Flow run**:
The evidence-gated process record for work. It owns gates, verdicts, route-back, exceptions, and reports.
_Avoid_: task status

**Gate**:
A condition in a Flow run that must be satisfied by evidence or explicitly routed, blocked, or excepted.
_Avoid_: approval if computed from evidence

**Gate verdict**:
The outcome of evaluating a gate or Flow run: pass, wait, route-back, block, or exception path.
_Avoid_: done unless receipt-backed

**Route-back**:
A verdict that sends work back to a recovery step while preserving the process path.
_Avoid_: failure when retry is expected

**Exception**:
A human-accepted override of missing or failing evidence. Exceptions are explicit receipt debt.
_Avoid_: skip

**Readiness evidence**:
Evidence derived from Veritas readiness and attached to Flow as a
Station-asserted `governance.merge-readiness` claim. The bridge uses `assumed`
for a ready result; it does not relabel a Station assertion as independently
verified evidence.
_Avoid_: Veritas MCP evidence

**Trust bundle**:
A Surface artifact containing claims, evidence, policies, and events.
_Avoid_: readiness record

**Trust report**:
A readable Surface projection of a trust bundle, including claim status and transparency gaps.
_Avoid_: source evidence

**Transparency gap**:
A missing, stale, conflicting, or insufficient evidence condition exposed in trust state.
_Avoid_: warning if it affects trust

**Merge readiness**:
The Veritas-derived state of whether a repository change satisfies configured standards and evidence requirements.
_Avoid_: CI status when governance is included

**Repo standard**:
A Veritas-governed expectation about a repository. Protected standards require attestation when changed.
_Avoid_: lint rule if policy is broader

**Policy class**:
A Flow Agents enforcement category such as workflow steering, quality gate, stop-goal-fit, or config protection.
_Avoid_: hook when discussing product behavior

**Governance surface**:
The Veritas artifacts, standards, evidence, and checks Station uses to govern itself.
_Avoid_: compliance folder

## Relationships

- A Flow run evaluates gates against evidence and writes reports.
- Veritas produces merge readiness records; Station maps those records into readiness evidence.
- Surface owns trust bundle and trust report semantics; Station renders them.
- Flow Agents policy classes shape process discipline before, during, and after agent work.
- Veritas shadow is the working-tree governance readiness check for Station itself.

## Implementation route

- [Flow completion](../../../src-server/services/flow/orchestration-flow-gate.ts)
  connects a Session to an available workspace definition and evaluates its gates.
- [Readiness bridge](../../../src-server/services/flow/flow-readiness-bridge.ts)
  attaches the Veritas record using the claim semantics above.
- [Readiness service](../../../src-server/services/evidence/veritas-readiness-service.ts)
  runs or reads the configured CLI evidence.
- [Command evidence](../../../src-server/services/flow/flow-command-evidence-bridge.ts)
  and [review attachment](../../../src-server/services/evidence/flow-review-evidence-attachment.ts)
  have separate input and attribution rules.

The [module map](../../architecture/module-map.md) links behavior tests. Read
the actual receipt and its source revision before interpreting a summary badge.

## Flagged Ambiguities

**Approval / review / gate**:
Approval allows an action. Review decides on output. A gate evaluates evidence.

**Done**:
Use pass verdict, explicit exception, or NOT_VERIFIED. Do not use done as a substitute for receipts.
