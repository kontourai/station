---
'@kontourai/station-contracts': minor
'@kontourai/station-shared': minor
---

Add `ATTACHMENT_INPUT_UNSUPPORTED_CODE` for a send refused because the engine
cannot take its attachments, `ComposerImageSupport.caveat` for an attach-time
note when image support is unconfirmed (with the `modelSupportVaries` input),
and `TurnStartedEvent.steerInterruptedRun` for a steer delivered by stopping the
running step. The runtime event projection now splits a turn at a steer.
