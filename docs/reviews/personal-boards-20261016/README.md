# Personal Board authoring review

Captured from source checkout `11c41c337a39afb72c3cf21716d187878b560fef`
with the managed `personal-board-review-20261016` development instance and an
isolated temporary Station home. Production source matches `d77a3f49368`;
subsequent commits at capture time contain test captures and review records.
These are actual rendered screens, not mockups or Gallery reference updates.

## Before composing a Board

The empty Board offers templates and the chat handoff. This is the new setup
state before composing, not a screenshot of the prior implementation.

![An empty Personal Board with starting templates.](setup.jpg)

## After saving a dashboard

The dashboard was selected from Daily brief, edited through the UI, previewed
and saved. Its Task was created through the real API in the isolated home.
The attention item reports that the built-in Agent needs setup; no Agent or
external provider was dispatched. The header's reconnecting observation is
preserved rather than replaced with a healthy connection claim.

![A saved Personal Board dashboard with live sections and a note.](dashboard.jpg)

## Phone layout

At 390 pixels the same saved sections stack in one column.

![The saved dashboard at phone width.](mobile.jpg)

## Verification scope

Controlled product browser journeys passed at 1280 and 390 pixels, including
preview-before-save, reload persistence, a real Task row, a separately arriving
proposal, explicit Apply and projectless chat picker. A third journey preserves
legacy tab selection when entering authoring and switching Boards.

Route tests cover ownership, schemas, stale revisions, reserved fields, rename,
promotion and retry recovery. A disabled save precondition produced the intended
409/200 failure; exact restoration passed 42 tests. Independent verification
removed the strong publication guard and observed the intended 403/200 failure,
then restored exact bytes and passed 42 tests. Authenticated internal callers
without an agent-origin marker are refused for both Apply and dismissal.

The screenshot-only cold-build run at `7c40cda25c8` reached its startup budget
before browser execution; it is not counted as a product-test pass. These
screenshots came from the separately started source-development runtime.
Physical devices, cross-process coordination, a model-generated proposal and
release-channel availability are not established by this packet.
