## Design sketch (before code)

### Message row, desktop 1440 (hover or focus shows the action bar)
```
 (JB) Jonas Berg  2:02 PM                         ┌──────────────────────────────────┐
      Morning! The pricing copy is ready. edited  │ ☺ React  ↩ Reply  ✎ Edit  🗑 Delete │
      [👍 3] [🎉 1] [☺+]                          └──────────────────────────────────┘
        └ hover/focus tooltip: "Maya Chen (you), Priya Natarajan and Jonas Berg"
```
- Pills: emoji + count. Mine = accent tint + accent border, `aria-pressed="true"`. Tap toggles.
- `[☺+]` opens the picker from the pills; it appears only once a message has reactions.
- "edited" is a muted marker after the body; its title is the edit time.
- Edit and Delete show only on your own person messages. Agent messages never offer them.

### Quick picker (an anchored popover on desktop, a bottom sheet on a phone)
```
┌ React ─────────────────────── ✕ ┐
│ 🔍 Search emoji                  │
│ Recent                            │
│ 👍 ❤️ 😂 🎉 👀 ✅ 🙏 🔥            │   ← this viewer's recent picks, seeded
│ Smileys & people                  │
│ 😀 😃 😄 😁 …   (each 44px on phone) │
└──────────────────────────────────┘
```
Search filters by name and keywords ("thumbs", "party"). No match shows an empty line, not a blank panel.

### Phone 390: ⋯ opens the actions bar (44px targets)
```
 (JB) Jonas Berg 2:02 PM                       ⋯
      Morning! The pricing copy is ready.
      [👍 3] [🎉 1]
 ┌────────────────────────────────────────────┐
 │ ☺ React │ ↩ Reply │ ✎ Edit │ 🗑 Delete │ 👥 Who reacted │
 └────────────────────────────────────────────┘
```
A long press on a pill, or "Who reacted" in ⋯, opens a sheet that lists each emoji with names.

### Tombstone and edit mode
```
 (JB) Jonas Berg 2:02 PM
      ⊘ Message deleted                 ← muted italic; no actions or reactions
   ↳ (MC) Replying to Jonas Berg …      ← replies stay, and still name the author

 ┌ Editing message                       Cancel ┐   ← composer chip; Esc cancels
 │ Morning! The pricing copy is ready.          │
 └───────────────────────────────── [ ✓ Save ] ┘
```
↑ in an empty composer starts editing your last message. Delete asks first: "Delete this message? Everyone sees 'Message deleted' instead." [Cancel] [Delete]

### Project-channel attachments
The shared composer accepts drop, paste and 📎. Sent images render as thumbnails under the body (the Task-room look). Files render as name chips that are at least 44px tall on a phone.
