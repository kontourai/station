---
'@kontourai/station-cli': patch
'@kontourai/station-shared': patch
---

Reset Full telemetry acknowledgements because the earlier disclosure wording overstated anonymity. Full telemetry is pseudonymous, with a monthly installation hash. Disclosure wording revision 2 participates in the Full acknowledgement hash independently of the data inventory revision used by batches and probes, so existing receipts are stale and saved operator Full choices require acknowledgement of the accurate disclosure before sending resumes.

Under DO_NOT_TRACK, the disclosure offers Off, Lite, and Full operator choices without acknowledging. Nothing is sent while DNT is active; saving Full leaves it pending and requires confirmation after DNT is removed. Correct the legacy telemetryEnabled schema description and restrict operator Full migration guidance to the operator CLI status line.
