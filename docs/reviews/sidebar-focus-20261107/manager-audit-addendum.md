# Stations manager follow-up evidence (publication draft)

This is a bounded follow-up to the sidebar packet. It records the manager repairs for #4665 and does not qualify shared execution or an exhaustive product audit.

The actual integrated runtime source was `cfc2b1c8fc1b2fd855caf4f7228726f74f21815b`. The manager, row editor, header and sidebar product blobs match candidate `ee32e85d364e31f151c4f24436a280dbb81f1935`; the candidate's only later change types the event-observation test. The accompanying manifest records those blobs.

## Captured views

| CSS viewport | Dark | Light |
| --- | --- | --- |
| 1440 by 900 | manager-dark-1440x900.png | manager-light-1440x900.png |
| 390 by 844 | manager-dark-390x844.png | manager-light-390x844.png |

`row-editor-dark-390x844.png` shows the visible editor portion; the bottom of the longer panel continues beyond this viewport. It is not a complete-content or all-target reachability claim.

Chrome used Desktop/fine-pointer emulation, DPR 2 and 50% device-preview scale. Fullframe PNGs are 3600 by 2260 pixels; these are exact rectangular dialog crops, without resizing, repainting or redaction. Crop coordinates, hashes, CSS viewports and actual pixel dimensions are separate manifest fields. Fullframes contain private host/DevTools context and stay private. The crops show only the generic saved Station and its disposable loopback address.

## Actual browser observations

The fresh Sol auditor used native keyboard/pointer interaction plus actual document.activeElement reads. Manager opening put Close inside the dialog before the app background became inert. First Escape in the Station actions menu closed only that menu and restored More actions; the next Escape closed the manager and restored the real header trigger. Direct narrow opening and desktop-open followed by 390px close both restored that trigger. Tab and Shift+Tab wrapped between the list's last control and Close; a subsequent Tab remained inside, with no late restoration observed. Row Edit focused the input named Station name; Cancel and unchanged Save restored the remounted View details control.

These observed outcomes close the specifically reproduced focus failures from the preceding `9d4b456c` audit. Source owner regressions separately cover modified-name Save, isolation order and StrictMode replay; those are not substituted for actual browser observations. The previous bounded Task/sidebar audit retains its own source, touch/offline/draft and navigation limits. This follow-up did not repeat its full adjacent Task matrix or physical/touch/native/provider/two-person journeys. Screenshots establish rendered states, not focus ordering or permission.

## Custody and retirement

The runtime used an isolated temporary home and explicit environment allowlist without inherited provider credentials. No inference was invoked. The original custodian verified exact instance/home/ports/registry ownership, then normally stopped only `cfc2-ui-audit`: exec 90028, exit0 at 2026-11-07T06:29:01.876858Z. Its separate 06:29:25Z settlement found both recorded processes absent, four owned ports closed and instance records cleared. Owned Incognito and blank preview surfaces were subsequently closed and browser preferences restored. Source remained clean at cfc2b1c8. WIP, transcripts, captures and recovery data were preserved. This establishes only the temporary runtime's settlement; it says nothing about historical unrelated PIDs or global host idleness.

The private retirement-stop-receipt.json and retirement-settlement.json retain those observations. No credential-bearing start log, raw Home capture, private host label or local filesystem path belongs in the public packet.
