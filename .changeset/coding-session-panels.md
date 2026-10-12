---
"@kontourai/station-contracts": patch
---

Device settings gain `codingPanels`, the Coding layout's per-session panels
(the tool beside Chat and its width, the Terminal's open state and height,
the inbox as the reader left it beside a tool), with `CodingSessionPanels`,
`CodingSessionPanelsRecord`, `CODING_PANELS_SESSION_BOUND` and
`DEFAULT_CODING_PANELS_RECORD`. Additive: the registry gains one
direct-manipulation key and no existing field changes.
