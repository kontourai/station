# Room conversation (#4790, #4791, #4793)

Retention: retained as bounded before/after review evidence for #4790, #4791 and #4793. Replace only with superseding reviewed evidence.

Before: today's Project room and Task room components (origin/main `c493a11367da`) rendered through this PR's room gallery scenes and fixtures. After: the shared `RoomConversation` and `RoomComposer` at `c2b45a8c70c2`, merged with origin/main `e5b5bd24e1ae`. Both are local captures of the same 32 scenes on an isolated e2e Station; every PNG here was opened at 390 and 1440 in both themes. Times follow the capturing host's time zone.

These scenes are new, so there is no tracked baseline and no pixel comparison (`NOT_VERIFIED: 32 new / 0 comparisons`). They are visual receipts, not a full-gallery qualification, and they do not cover native shells or physical devices. Reactions have no scene: no room contract carries them yet.

[Design sketch](design-sketch.md) written before implementation.

| Scene | Shows | Before | After |
| --- | --- | --- | --- |
| room-empty-dark-desktop | Project room with no messages | [Before](before-room-empty-dark-desktop.png) | [After](after-room-empty-dark-desktop.png) |
| room-empty-dark-mobile | Project room with no messages | [Before](before-room-empty-dark-mobile.png) | [After](after-room-empty-dark-mobile.png) |
| room-empty-light-desktop | Project room with no messages | [Before](before-room-empty-light-desktop.png) | [After](after-room-empty-light-desktop.png) |
| room-empty-light-mobile | Project room with no messages | [Before](before-room-empty-light-mobile.png) | [After](after-room-empty-light-mobile.png) |
| room-short-dark-desktop | Short history: grouping, an agent answer with Markdown | [Before](before-room-short-dark-desktop.png) | [After](after-room-short-dark-desktop.png) |
| room-short-dark-mobile | Short history: grouping, an agent answer with Markdown | [Before](before-room-short-dark-mobile.png) | [After](after-room-short-dark-mobile.png) |
| room-short-light-desktop | Short history: grouping, an agent answer with Markdown | [Before](before-room-short-light-desktop.png) | [After](after-room-short-light-desktop.png) |
| room-short-light-mobile | Short history: grouping, an agent answer with Markdown | [Before](before-room-short-light-mobile.png) | [After](after-room-short-light-mobile.png) |
| room-long-dark-desktop | Long history: day divider, grouped runs, agent group, reply | [Before](before-room-long-dark-desktop.png) | [After](after-room-long-dark-desktop.png) |
| room-long-dark-mobile | Long history: day divider, grouped runs, agent group, reply | [Before](before-room-long-dark-mobile.png) | [After](after-room-long-dark-mobile.png) |
| room-long-light-desktop | Long history: day divider, grouped runs, agent group, reply | [Before](before-room-long-light-desktop.png) | [After](after-room-long-light-desktop.png) |
| room-long-light-mobile | Long history: day divider, grouped runs, agent group, reply | [Before](before-room-long-light-mobile.png) | [After](after-room-long-light-mobile.png) |
| room-new-messages-dark-desktop | Reader scrolled up while three messages arrive: New divider and count | [Before](before-room-new-messages-dark-desktop.png) | [After](after-room-new-messages-dark-desktop.png) |
| room-new-messages-dark-mobile | Reader scrolled up while three messages arrive: New divider and count | [Before](before-room-new-messages-dark-mobile.png) | [After](after-room-new-messages-dark-mobile.png) |
| room-new-messages-light-desktop | Reader scrolled up while three messages arrive: New divider and count | [Before](before-room-new-messages-light-desktop.png) | [After](after-room-new-messages-light-desktop.png) |
| room-new-messages-light-mobile | Reader scrolled up while three messages arrive: New divider and count | [Before](before-room-new-messages-light-mobile.png) | [After](after-room-new-messages-light-mobile.png) |
| room-failed-send-dark-desktop | A send that was not confirmed, with Retry and Discard | [Before](before-room-failed-send-dark-desktop.png) | [After](after-room-failed-send-dark-desktop.png) |
| room-failed-send-dark-mobile | A send that was not confirmed, with Retry and Discard | [Before](before-room-failed-send-dark-mobile.png) | [After](after-room-failed-send-dark-mobile.png) |
| room-failed-send-light-desktop | A send that was not confirmed, with Retry and Discard | [Before](before-room-failed-send-light-desktop.png) | [After](after-room-failed-send-light-desktop.png) |
| room-failed-send-light-mobile | A send that was not confirmed, with Retry and Discard | [Before](before-room-failed-send-light-mobile.png) | [After](after-room-failed-send-light-mobile.png) |
| room-mention-dark-desktop | The @ list with people and agents | [Before](before-room-mention-dark-desktop.png) | [After](after-room-mention-dark-desktop.png) |
| room-mention-dark-mobile | The @ list with people and agents | [Before](before-room-mention-dark-mobile.png) | [After](after-room-mention-dark-mobile.png) |
| room-mention-light-desktop | The @ list with people and agents | [Before](before-room-mention-light-desktop.png) | [After](after-room-mention-light-desktop.png) |
| room-mention-light-mobile | The @ list with people and agents | [Before](before-room-mention-light-mobile.png) | [After](after-room-mention-light-mobile.png) |
| room-task-thread-dark-desktop | Task room: image attachment, mention, agent answer with thread summary | [Before](before-room-task-thread-dark-desktop.png) | [After](after-room-task-thread-dark-desktop.png) |
| room-task-thread-dark-mobile | Task room: image attachment, mention, agent answer with thread summary | [Before](before-room-task-thread-dark-mobile.png) | [After](after-room-task-thread-dark-mobile.png) |
| room-task-thread-light-desktop | Task room: image attachment, mention, agent answer with thread summary | [Before](before-room-task-thread-light-desktop.png) | [After](after-room-task-thread-light-desktop.png) |
| room-task-thread-light-mobile | Task room: image attachment, mention, agent answer with thread summary | [Before](before-room-task-thread-light-mobile.png) | [After](after-room-task-thread-light-mobile.png) |
| room-task-working-dark-desktop | Task room: failed run with Retry/Open run, agent working with Watch/Stop | [Before](before-room-task-working-dark-desktop.png) | [After](after-room-task-working-dark-desktop.png) |
| room-task-working-dark-mobile | Task room: failed run with Retry/Open run, agent working with Watch/Stop | [Before](before-room-task-working-dark-mobile.png) | [After](after-room-task-working-dark-mobile.png) |
| room-task-working-light-desktop | Task room: failed run with Retry/Open run, agent working with Watch/Stop | [Before](before-room-task-working-light-desktop.png) | [After](after-room-task-working-light-desktop.png) |
| room-task-working-light-mobile | Task room: failed run with Retry/Open run, agent working with Watch/Stop | [Before](before-room-task-working-light-mobile.png) | [After](after-room-task-working-light-mobile.png) |
