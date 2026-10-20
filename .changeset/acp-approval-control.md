---
'@kontourai/station-contracts': minor
---

Say who decides which of an ACP engine's actions ask before they run (#3290).
`engine-capability-matrix` adds `AcpApprovalControl` (`station` or `engine`),
`acpStationApprovalEngine`, which names the ACP engine whose approval rules
Station sets at launch (OpenCode, matched on the command's executable name),
and `acpApprovalControl`. Station launches such an engine asking before every
action that is not a read and answers its requests by the chat's approval
mode; any other ACP engine decides for itself, and its approval control says
so instead of offering a mode. `PROVIDER_MODEL_OPTION_SUPPORT` is unchanged:
`approvalMode` stays unsupported for the `acp` provider as a whole, and the
server admits it only for an ACP connection whose control is `station`.

`provider` adds `ACP_APPROVAL_TAKEOVER_FAILED_CODE`, the `runtime.warning`
code an ACP adapter publishes when it could not move the engine onto the
launch rules a picked approval mode needs and the session kept what it ran
before.

`provider` also adds `ACP_APPROVAL_GOVERNANCE_REFUSED_CODE`, the code on a
start or send refused because Station cannot apply its approval mode to the
ACP engine (its resolved rules override Station's, or the chat runs an agent
Station does not govern). It is not retryable until that changes.
