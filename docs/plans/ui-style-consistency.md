# Station UI style audit

Source snapshot `7fde8d816baed39c182fa185b99d1fe974dcdb1e`, with the installed `@kontourai/ui` 1.20.1. This audit covers presentation in the web shell, SDK, Connect, Basis pane and Board pane. The follow-up work belongs with the [UI polish epic](https://github.com/kontourai/station/issues/1225) and the [whole-app journey campaign](whole-app-ux-campaign.md).

## Changes from the audit

1. **Give shared rows a predictable type hierarchy.** The default row description measured 12px in both density modes. Settings set the same description to 13px in Comfortable and 12.5px in Compact. `PageRow` now owns that density-sensitive description, its line height and the row padding. Settings retains its section and mobile control layout. Chromium renders of Feature previews and Project overview at 390px and 1440px showed matching description sizes in both densities and themes, including wrapped text. [Page layout](../../src-ui/src/views/page-layout.css) · [Settings overrides](../../src-ui/src/views/SettingsView.css) · [Settings row adapter](../../src-ui/src/views/settings/SettingsPageRow.tsx)
2. **Choose spacing by the relationship between elements.** The Device setup wizard’s legacy group and step gaps measured 6px and 4px despite 12px and 8px fallbacks. The wizard and tools drawer now use the kit scale directly, with 12px between groups, 8px within a section and 4px between closely related items. Browser checks covered the narrow overlay and the docked drawer. The drawer kept its 288px width, 44px controls and 16px touch input text. [Wizard](../../src-ui/src/workspace-panes/device/DeviceSetupWizard.css) · [Tools drawer](../../src-ui/src/workspace-panes/device/DeviceToolsDrawer.css) · [Station aliases](../../src-ui/src/tokens.css)
3. **Keep the parts that really differ.** Nearby discovery and device pairing share a package-local owner for their primary and secondary action styles. Discovery keeps the compact primary action and pairing keeps the standard action. Discovery’s static layout moved into the package stylesheet, with token fallbacks for standalone hosts. Browser renders covered the standalone package and both Station themes, including long candidate names, keyboard focus and pending/retry actions. [Discovery](../../packages/connect/src/react/ConnectionManagerDiscoverPanel.tsx) · [Shared pairing styles](../../packages/connect/src/react/connection-manager-modal/styles.ts) · [Package stylesheet](../../packages/connect/src/react/ConnectionManagerModal.css)
4. **Keep global CSS small in responsibility.** The global import comment now reflects kit token use throughout Station. The page frame owns the outer gutter, rows own their padding, and controls own their internal spacing. Feature selectors in the 9,548-line global entry at the source snapshot remain candidates to move beside their consumers as features change. Check lazy and standalone entry points when moving a rule. [Global entry](../../src-ui/src/index.css) · [Page frame](../../src-ui/src/components/page-frame/PageFrame.tsx) · [Layout recipes](../../src-ui/src/styles/layout-recipes.css)

## Where the one-off values are

| Tracked source | CSS files | Literal font sizes | Literal padding | Literal gaps |
| --- | ---: | ---: | ---: | ---: |
| Shell and public theme sheets | 341 | 505 | 924 | 827 |
| SDK | 8 | 36 | 28 | 21 |
| Connect | 3 | 51 | 29 | 34 |
| Basis pane | 1 | 0 | 2 | 5 |
| Board pane | 1 | 0 | 0 | 1 |
| **Total** | **354** | **592** | **983** | **888** |

The counts use the repo’s [CSS declaration reader](../../scripts/ui-css-slop.mjs). For each tracked stylesheet under `src-ui/{src,public}` and the four packages’ `src` directories, count a declaration once if its value contains a whitespace-delimited numeric `px`, `em` or `rem` length. The three families are `font-size`, `padding` including longhands, and `gap` including row/column gaps. Tests, fixtures and mocks are excluded. Expressions, custom properties and utility classes are outside the count. The largest concentrations are the global entry (335 declarations), Monitoring widgets (127), Plugin management (104) and Automations (84). These counts locate review work. A one-pixel optical adjustment and an ordinary content gutter deserve different treatment.

A TypeScript syntax pass over 1,042 TSX files in the same source roots found 526 JSX `style` attributes. Of those, 159 contain an object literal with a direct string or numeric literal for font size, padding or gap, including resets. Referenced style objects and dynamic values need separate inspection. Measured pane dimensions, drag coordinates, safe areas and 44px target floors have independent behavioral reasons to exist.

## What the gallery shows

The [November 17 nightly gallery](https://github.com/kontourai/station/actions/runs/44131811484) captured 301 of 301 expected images at `23d7d9898660ec87182beb7aafbd00888524509e`. All image hashes matched the capture manifest. Contact sheets covered every capture. Original-size inspection included mobile Settings, Project settings, Connections and the usage-sharing dialog.

At 390px, Settings places “Your account” above the panel and indents its rows inside. Project settings puts “Overview and notifications” inside the card, with another inset before the first field. On mobile Connections, the search field is inset while the empty-state border reaches the viewport edge. These are useful direct comparisons for deciding who owns a page gutter, a section inset and a row inset. Preserve an intentional full-width rail or touch surface when choosing the shared default.

The hosted DOM audit recorded 232 finding occurrences on 71 captures, including 132 hit-target, 98 axe and two overflow entries. Both overflow entries identify the same Settings metadata selector at 320px. Repeated states can report the same underlying condition. Verify the actual clickable label or obstructed text on the affected screen before changing its geometry. Gallery capture and thumbnail inspection establish neither complete interaction coverage nor physical-device behavior. The source snapshot is newer than the gallery.

## Prevent recurrence

Use the [UI agent instructions](../../src-ui/AGENTS.md) at authoring time. Find one shipped caller with the same job, use its component and its owning stylesheet, then inspect the declarations the change makes redundant. Before changing a shared role, render the affected consumers at 390 and 1440px in light and dark. For type changes, compare Comfortable and Compact. For spacing changes, include a narrow pane inside a wide window and a long label. Verify keyboard focus, wrapping and touch area on the real controls.

The existing `npm run lint:component-style` now advises on newly introduced literal font sizes, padding and gaps in CSS and direct JSX style objects, with file and line references. It compares the branch and working tree with their merge base. A repeated existing value on an unchanged declaration, a zero reset, a token fallback or measured geometry has a different meaning from a new literal. Keep this check advisory until actual changes establish which cases should block a PR. [Component check](../../scripts/component-style-hygiene.mjs) · [Advisory](../../scripts/lib/literal-style-advisory.mjs)

The existing [Design & States issue](https://github.com/kontourai/station/issues/4693) is a natural home for side-by-side rendered examples. The [font family and radius decision](https://github.com/kontourai/station/issues/4690) already has an owner. Both can proceed independently of consolidating Settings rows and Connect buttons.
