---
"@kontourai/station-contracts": patch
"@kontourai/station-sdk": patch
---

Expose typed input-conflict and unsupported-input refusals for existing keyed orchestration sends. The server compares versioned submission digests before replay or reclaim; legacy records without original proof remain unknown. This bounded slice does not require keys on every route or record durable turn intent.

Preserve the existing queue receipt in a typed ForegroundMessageQueuedError when ordinary execution callers retry an already queued message.
