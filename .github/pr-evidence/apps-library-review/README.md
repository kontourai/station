# Apps lifecycle review evidence

Retention: until 2027-02-03

Captured at `3da3d1e7c76c4726b76ea9e5acbe451cbdabbc83`, with an isolated
Station CLI `--watch` instance, temporary home, real personal Layout records,
and the normal single-use browser pairing flow. All eight source-development
PNGs were inspected at 390 and 1440 pixels in light and dark themes. The
instance and browser were stopped after capture.

![Apps library and metadata details in both widths and themes](after.png)

The [earlier integrated captures](https://github.com/kontourai/station/pull/4621)
remain in the PR description as the before views, with their recorded revisions
and fixture limits. They include a fixture plugin Layout; this capture uses two
real personal Boards and does not qualify plugin execution.

## Executed behavior

At source revision `ae966ffe2aafa0e483a23afa52d85a34984fe921`, the four
Apps product-browser journeys passed in 39.3 seconds. They exercise creation,
metadata save, viewport changes, reload, launch, return focus after visiting a
child dialog, and cancellation/discard before deleting a real dirty Board.
The final capture revision only adds documentation review notes.

The two new dialog regressions first failed on the reviewed implementation:
discard left the metadata editor mounted, and child-dialog dismissal returned
focus to the document body. After repair, all 59 focused owner tests passed.
The dirty-Board browser regression failed before its repair because GET returned
404 while the discard decision was open, rather than the required 200.

The standard screenshot runner separately failed its unchanged 120-second
startup deadline before browser capture. That failure remains recorded; the
source-development images do not turn it into a pass. Phone-sized Chromium
renders do not establish installed-shell or physical-device behavior.
