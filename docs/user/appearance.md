# Custom appearance

Station's **Appearance** page (`/appearance`, in Customize and the command
palette) sets the mode, a color theme, the accent, density and motion. Its
**Custom** section adds your own look on top: a palette and CSS that belong to
you on this Station. Other people on the same Station never get yours.

## Ask an agent

An agent can propose a custom appearance, for example "make the sidebar
quieter and round the buttons". It cannot apply one. The proposal appears
under **Proposed** on the Appearance page. With the **Appearance studio**
Feature Preview enabled, the proposing tool also shows a card in the chat.
Choose **Preview** there to try it without leaving the conversation. The card
is tied to that exact proposal and Session; replaced or settled proposals
lose their actions. Relayed and other-Station conversations require switching
to the Station that owns the appearance.

On either surface:

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
remote images and `url()` other than `data:` (and `#id` links in filters,
masks, clip paths and markers). In a `data:` SVG inside `url()`, use single quotes,
or write double quotes as `%22`. It also refuses
text colors that are hard to read on their backgrounds. Use the hook
selectors, such as `[data-surface="sidebar"]` or `[data-slot="button"]`;
other class names change without notice. When your CSS sets a background, set its text color too: Station checks the palette's colors, not your CSS.

## Approvals always look like Station

While an approval or consent prompt is on screen (a tool or permission
approval, a plugin install, a device pairing, a sharing change), your custom
CSS is switched off so nothing can disguise the buttons. Your palette stays.

## Turn it off

**Turn off custom appearance** on the Appearance page removes it. If your CSS
makes Station hard to use, open Station with `?appearance=safe` at the end of
the address (for example `/appearance?appearance=safe`). Custom appearance is
then off in that tab until you turn it back on from the Appearance page.

## Appearance studio

Turn on **Appearance studio** in Settings → Advanced → Feature previews to use
visual controls, a saved theme library and portable theme files. It is off by
default. Turning it off hides these new actions; your accepted appearance
keeps rendering, and you can still turn custom appearance off.

In Appearance → Custom, choose **Create** or **Edit**. Visual controls set a
background image, Fill/Fit/Tile, its position and dimming, panel opacity,
corner rounding and text size. The Advanced CSS disclosure keeps the existing
CSS editor available. Preview uses the same 20-second Keep/Discard bar.

Choose or drop a PNG, JPEG or WebP background. The browser opens it, scales it
to at most 1,920 pixels on its longest side, and encodes a bounded image inside
the theme. No remote image link is needed. Accepted background files have at
most 1 MiB of raster bytes after base64 decoding, at most 4,096 pixels per
side and 16 million pixels. The server checks their signatures, structural
headers and dimensions; the browser must still decode their compressed pixels.
Background images and visual styling pause alongside custom CSS while an
approval or consent prompt is open.

### Save and share themes

**Save to library** keeps a named theme for later without applying it. Saved
cards show the image and colors. **Apply** starts a protected preview; **Keep**
accepts it. **Edit** changes a saved theme. The card's more-actions menu offers
Favorite, Duplicate, Export theme pack and Delete. Favorites can be filtered.
The library belongs to your signed-in person on this Station and survives reload.
It holds up to 24 themes within a 16 MiB total appearance-document limit; large
images can reach the byte limit first.

**Export theme pack** downloads one `.station-theme.json` file containing the
palette, CSS, visual settings and embedded image. It contains no person,
Session, proposal or revision data. To use another person's file, choose
**Import theme pack**. A valid file opens an unsaved draft. Preview it before
applying, or save it to your library. Import never applies a theme immediately.
An unsupported version, invalid image, remote background URL or file over the
1.5 MiB pack limit is refused with an error so you can choose another file.
