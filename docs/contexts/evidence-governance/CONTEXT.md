# Evidence Governance Context

Evidence Governance covers how Station turns agent work into receipts, gate verdicts, readiness state, and governance outcomes.

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
Evidence derived from Veritas merge readiness and attached to Flow as a Station-asserted governance claim.
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

## Flagged Ambiguities

**Approval / review / gate**:
Approval allows an action. Review decides on output. A gate evaluates evidence.

**Done**:
Use pass verdict, explicit exception, or NOT_VERIFIED. Do not use done as a substitute for receipts.
