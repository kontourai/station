# Browser and Device UX pass

Status: **incomplete audit checkpoint**. This is a source inspection of the
starting branch, not a rendered inventory or an implemented design.

## Starting observations

The Browser live toolbar exposes address, back, forward, reload, driver,
float, console, recording, network, and a more menu. The menu also exposes
screenshot, recording, annotation, screenshot to chat, zoom, appearance,
viewport, rotation, reload without cache, stop, sessions, agent access,
local servers, and close session. Some entries depend on feature previews,
operator authority, or a live session.

The Device live toolbar exposes Home, Android Back and Recents or iOS Rotate,
Tools, screenshot, recording, float, power, end, and close. The Tools drawer
contains app controls, logs, action history, appearance, accessibility, push,
location, and permissions. Availability depends on platform and authority.

These observations are not an exhaustive inventory of states, copy, usage
frequency, shortcuts, or agent-tool parity. Those remain to be audited.

## Target

Keep navigation and the driver in Browser chrome; move capture, view, inspect,
and session actions into a grouped menu. Keep the Device screen, Home, Android
Back, Rotate, and a more menu in its default chrome. Put other controls in that
menu and move host and agent configuration to Advanced settings. Preserve all
authorization, leases, redaction, and existing capabilities.

## Evidence and remaining work

The isolated Station built and started, but the browser snapshot timed out.
No screenshots or simulator journey have been captured. The requested before
and after states, 390/1440-pixel theme renders, complete control inventory,
agent and shortcut reachability, implementation, tests, guide edits, and
diff-scoped deslop remain **NOT VERIFIED**. Do not treat this checkpoint as a
completed design or release qualification.
