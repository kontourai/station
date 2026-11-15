# Custom appearance

Station's **Appearance** page (`/appearance`, in Customize and the command
palette) sets the mode, a color theme, the accent, density and motion. Its
**Custom** section adds your own look on top: a palette and CSS that belong to
you on this Station. Other people on the same Station never get yours.

## Ask an agent

An agent can propose a custom appearance, for example "make the sidebar
quieter and round the buttons". It cannot apply one. The proposal appears
under **Proposed** on the Appearance page:

1. Choose **Preview**. The proposal applies in this tab only, and a bar at the
   bottom counts down from 20 seconds.
2. Choose **Keep** to use it, or **Discard** to drop the proposal. **Esc**, or
   letting the countdown finish, puts your appearance back and leaves the
   proposal for later.

If a preview hides or covers part of the page, **Keep** is turned off and the
bar says why. Discard it or let it revert.

When you preview a proposal, Station tells the agent what it saw: which parts
of the page its CSS matched, any colors that became hard to read, and any CSS
Station removed. The agent cannot see your screen otherwise.

## Edit it yourself

Choose **Create** (or **Edit**) to set colors for dark and light mode and to
write CSS. Leave a color empty to keep your theme's. **Preview** tries it the
same way; **Save** uses it at once.

Station refuses CSS that loads anything from elsewhere: `@import`, fonts,
remote images and `url()` other than `data:` and `#` links. It also refuses
text colors that are hard to read on their backgrounds. Use the hook
selectors, such as `[data-surface="sidebar"]` or `[data-slot="button"]`;
other class names change without notice.

## Approvals always look like Station

While an approval or consent prompt is on screen (a tool or permission
approval, a plugin install, a device pairing, a sharing change), your custom
CSS is switched off so nothing can disguise the buttons. Your palette stays.

## Turn it off

**Turn off custom appearance** on the Appearance page removes it. If your CSS
makes Station hard to use, open Station with `?appearance=safe` at the end of
the address (for example `/appearance?appearance=safe`). Custom appearance is
then off in that tab until you turn it back on from the Appearance page.
