# Responsive UI contracts

Station treats phone support as a shared layout contract, not a set of
route-specific patches. New surfaces should reuse the smallest owner below.

## Shared UI authority and Station adoption

Kontour UI owns the public explorer and its generated manifest, the consumer
guide, `--k-*` tokens, product-theme boundary, and primitive accessibility
contract. Consult the [consumer guide](https://github.com/kontourai/ui/blob/main/docs/consumer-guide.md)
and [explorer manifest](https://github.com/kontourai/ui/blob/main/docs/explorer-manifest.json)
instead of copying those contracts into Station.

Station owns only adopter behavior: which Station surfaces need responsive
composition, its runtime navigation and data semantics, and the local
responsive-surface registry and tests named below. A Station consumer may
compose the public primitives and tokens, but must not fork shared tokens,
theme classes, or accessibility behavior. Its focused proof covers the
Station-only keyboard, safe-area, route, and viewport interactions that remain
after that shared contract is adopted.

## Dialogs and sheets

Use `ResponsiveDialogSurface` for Station-owned dialogs. It owns:

- Visual Viewport height and offset updates while the software keyboard opens;
- safe mobile focus policy (`panel` by default, or `desktop` for search-first
  desktop flows);
- Escape, backdrop dismissal, focus containment, and trigger focus restoration;
- the `responsive-surface-overlay` and `responsive-surface-panel` contracts.

Wrap dialog footer controls in `ResponsiveSurfaceActions`. Feature classes
still own desktop alignment and color; the shared marker owns phone wrapping,
44px minimum targets, and bottom safe-area reachability. This keeps action-row
behavior consistent without forcing every dialog into one visual layout.

The named layer scale is `sticky` < `popover` < `notice` < `dialog` < `system`.
The shared overlay owns `--layer-dialog`; passive banners and reconnect notices
must remain below it so they cannot intercept an active dialog. A blocking
system surface must opt into `layer="system"` and, when it cannot safely close,
`dismissible={false}`. Do not introduce feature-local five-digit z-indexes.

Feature components still own their labels, content, and desktop geometry. Do
not add another document-level Escape listener, backdrop click handler, focus
trap, or mount-time input focus inside a consumer. An input should only receive
automatic focus on a phone when opening the surface was itself an explicit
request to type.

Package-owned surfaces such as Station Connect should keep their package
boundary. They must meet the same behavior tests before code is moved into a
cross-package UI dependency.

## Full-height workspaces

Apply `useMobileVisualViewport` once at the outer workspace boundary and size
descendants from `--responsive-visual-viewport-height`. Nested panels should
use flex or grid with `min-width: 0` and `min-height: 0`; they should not each
subscribe to `window.visualViewport` or calculate keyboard offsets.

Terminal and editor surfaces must keep their controls in one non-wrapping,
horizontally scrollable row on phones. Hidden text inputs used by terminal
libraries and visible command inputs use a 16px phone font size to prevent
Safari input zoom.

## Controls and enforcement

- Apply `tap-target` to compact interactive controls; the minimum target is
  44 by 44 CSS pixels.
- Use safe-area environment values at the surface boundary, not on every child.
- Keep one bounded scroll owner per region and use `overscroll-behavior` where
  a sheet should not move the page behind it.
- Add every modal-like surface to `docs/ui/responsive-surfaces.json` and every
  action surface to `docs/ui/responsive-action-surfaces.txt`.
- Station-owned modal exceptions are not allowed. A newly discovered dialog
  must adopt `ResponsiveDialogSurface`; package-owned exceptions require an
  explicit package-boundary rationale and their own behavior proof.
- Add a contract test for keyboard-sized Visual Viewport geometry, initial
  focus, reachable controls, dismissal, and focus return. The responsive
  ratchet rejects unclassified surfaces in `verify:static`.
- Reuse `tests/helpers/visual-viewport.ts` in Playwright instead of installing
  a route-local `window.visualViewport` shim. This keeps keyboard simulations
  and viewport event timing identical across mobile journeys.
