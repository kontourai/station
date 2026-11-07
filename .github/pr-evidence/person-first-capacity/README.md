# First-start capacity status

Captured and opened on macOS/Chromium from source revision
`f9ea4205beadf8447e12480947f58bd6c5637b5a` with:

```sh
npm run test:e2e:product -- --spec=tests/mobile-chat-composer.spec.ts '--grep=engine-start capacity wait|first-start wait'
```

All three journeys passed (9.8 seconds of Playwright execution). Each fresh-chat
Stop journey begins at a fixed viewport, so resizing cannot replace its Stop
control between pointer events. The fixture renders the real composer and SSE
consumer; the separate `engine-start-wait.routes.test.ts` reaches the real
foreground route, execution composition, service producer, authorized stream
and UI status consumer. These are local tests with a controlled adapter, not
live-provider or physical-device evidence.

The **before** images show the same build before Station publishes a wait;
the **waiting** images show its received capacity status. They illustrate a
runtime state transition, not two released versions. Both themes were opened
and inspected at 390 and 1440 pixels. The journeys then press Stop, assert its
interrupt command, and require the badge to disappear.

| Width | Before wait publication | Waiting, light | Waiting, dark |
| --- | --- | --- | --- |
| 390 | [Before](engine-start-wait-new-chat-390-before-light.png) | [Light](engine-start-wait-new-chat-390-light.png) | [Dark](engine-start-wait-new-chat-390-dark.png) |
| 1440 | [Before](engine-start-wait-new-chat-1440-before-light.png) | [Light](engine-start-wait-new-chat-1440-light.png) | [Dark](engine-start-wait-new-chat-1440-dark.png) |
