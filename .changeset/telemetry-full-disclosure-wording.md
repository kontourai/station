---
'@kontourai/station-cli': patch
'@kontourai/station-shared': patch
---

Reset Full telemetry acknowledgements because the earlier disclosure wording overstated anonymity. Full telemetry is pseudonymous, with a monthly installation hash. Disclosure wording revision 2 now participates in the Full inventory hash, so existing receipts are stale and saved operator Full choices require acknowledgement of the accurate disclosure before sending resumes.

Under DO_NOT_TRACK, the disclosure explicitly labels actions as saving an operator choice and explains that they replace the saved choice while effective telemetry remains Off. Correct the legacy telemetryEnabled schema description and restrict operator Full migration guidance to the operator CLI status line.
