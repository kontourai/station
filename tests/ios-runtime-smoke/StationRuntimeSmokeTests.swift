import XCTest

final class StationRuntimeSmokeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCleanInstallLeavesStartupForActionableConnectionState() throws {
        let app = XCUIApplication(bundleIdentifier: "io.kontourai.station")
        addTeardownBlock {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "station-ios-final-state"
            attachment.lifetime = .keepAlways
            self.add(attachment)
            app.terminate()
        }
        app.launch()

        // A hosted failure observed the notification sheet arrive after this
        // bounded probe initially missed it but before the following activation
        // settled. Reacquire Station only after a sheet actually disappears.
        if dismissSystemAlertIfPresent() {
            app.activate()
        }

        let scan = app.buttons["Scan pairing QR code"]
        XCTAssertTrue(
            waitForElement(scan, budget: 90),
            "Station never exposed the fresh-phone QR welcome. Accessibility hierarchy:\n\(app.debugDescription)"
        )
        if dismissSystemAlertIfPresent() {
            app.activate()
        }
        XCTAssertTrue(scan.waitForExistence(timeout: 5))
        XCTAssertTrue(scan.isHittable)
        let appFrame = app.frame
        assertVisibleAction(scan, within: appFrame, label: "Scan pairing QR code")
        let manual = app.buttons["Enter a pairing code"]
        XCTAssertTrue(manual.isHittable)
        assertVisibleAction(manual, within: appFrame, label: "Enter a pairing code")
        XCTAssertFalse(app.buttons["Toggle menu"].exists,
                       "The protected workspace must not mount before a Station is configured.")

        manual.tap()
        let manualAddress = app.textFields["Station server address"]
        if !manualAddress.waitForExistence(timeout: 2) {
            if dismissSystemAlertIfPresent() {
                app.activate()
            }
        }
        XCTAssertTrue(
            tap(manual, until: manualAddress, budget: 20),
            "Manual pairing did not expose its Station address. Accessibility hierarchy:\n\(app.debugDescription)"
        )
        let code = app.textFields["Pairing code"]
        XCTAssertTrue(code.exists)
        let manualTitle = app.staticTexts["Enter a pairing code"]
        XCTAssertTrue(manualTitle.exists)
        assertContained(manualAddress.frame, within: appFrame, label: "manual Station address")
        assertContained(code.frame, within: appFrame, label: "Pairing code")
        let manualTitleFrame = manualTitle.frame
        manualAddress.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertTrue(manualAddress.isHittable)
        assertContained(manualTitle.frame, within: appFrame, label: "focused manual title")
        assertContained(manualAddress.frame, within: appFrame, label: "focused manual Station address")
        XCTAssertEqual(manualTitle.frame.origin.x, manualTitleFrame.origin.x, accuracy: 1)
        XCTAssertEqual(manualTitle.frame.width, manualTitleFrame.width, accuracy: 1)

        // No code or request is submitted. Closing returns to the same welcome;
        // address-based setup is a separate deliberate route through disclosure.
        let closeManager = app.buttons["Close Station manager"]
        XCTAssertTrue(closeManager.isHittable)
        XCTAssertTrue(
            dismissSurface(closeManager, untilGone: manualAddress),
            "Manual pairing did not close. Accessibility hierarchy:\n\(app.debugDescription)"
        )
        XCTAssertTrue(waitForElement(scan, budget: 10))
        XCTAssertTrue(scan.isHittable)
        let otherWays = app.buttons["Other ways to connect"].firstMatch
        let connect = app.buttons["Open connection manager"]
        XCTAssertTrue(
            tap(otherWays, until: connect, budget: 20),
            "Other ways to connect did not disclose the connection manager. Accessibility hierarchy:\n\(app.debugDescription)"
        )
        connect.tap()
        let connectStation = app.buttons["Connect a Station"]
        if !connectStation.waitForExistence(timeout: 2) {
            if dismissSystemAlertIfPresent() {
                app.activate()
            }
        }
        XCTAssertTrue(
            tap(connect, until: connectStation, budget: 20),
            "Station manager did not expose Connect a Station. Accessibility hierarchy:\n\(app.debugDescription)"
        )

        let address = app.textFields["Station address"]
        XCTAssertTrue(
            tap(connectStation, until: address, budget: 20),
            "Station setup address input did not appear. Accessibility hierarchy:\n\(app.debugDescription)"
        )
        XCTAssertTrue(address.exists)

        assertContained(
            address.frame,
            within: appFrame,
            label: "Station address"
        )

        let title = app.staticTexts["Connect a Station"]
        XCTAssertTrue(title.exists)
        assertContained(title.frame, within: appFrame, label: "Connect a Station")
        let titleFrameBeforeAddressFocus = title.frame
        address.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))

        assertContained(title.frame, within: appFrame, label: "focused Connect a Station")
        assertContained(
            address.frame,
            within: appFrame,
            label: "focused Station address"
        )
        XCTAssertEqual(
            title.frame.origin.x,
            titleFrameBeforeAddressFocus.origin.x,
            accuracy: 1,
            "Focusing the address field shifted the Station setup surface horizontally."
        )
        XCTAssertEqual(
            title.frame.width,
            titleFrameBeforeAddressFocus.width,
            accuracy: 1,
            "Focusing the address field changed the Station setup surface scale."
        )
    }

    // A native tap acknowledgement is not a WebView dismissal receipt.
    // Preserve the exact disappearance outcome with at most two hittable taps.
    private func dismissSurface(_ close: XCUIElement, untilGone target: XCUIElement) -> Bool {
        for attempt in 1...2 {
            if !target.exists { return true }
            guard close.exists && close.isHittable else { return !target.exists }
            XCTContext.runActivity(named: "Surface close attempt \(attempt)") { _ in
                close.tap()
            }
            if target.waitForNonExistence(timeout: 5) { return true }
        }
        return !target.exists
    }

    /// A native tap can be acknowledged without the intended WebView transition.
    /// Accessibility hittability is not a receipt that a DOM handler committed.
    /// A single `waitForExistence` afterwards can only observe the absence —
    /// it cannot separate "the handler was not ready" from "this surface never
    /// opens", and both read as a failing assertion. #1174 recorded that twice
    /// on changes causally unrelated to the surface under test (a merge plus a
    /// removed import; an `@ai-sdk/provider-utils` bump), each going green on
    /// a same-commit re-run.
    ///
    /// Re-tapping only while the target is still absent preserves what the
    /// assertion proves: the caller still fails if the surface genuinely never
    /// opens, because the final answer is the same existence check. The wait
    /// between taps is sliced for the reason `waitForElement` documents.
    ///
    /// The source is re-tapped at most `maxTaps` times, and only while it is
    /// still hittable — once the surface has advanced past it, the target alone
    /// decides. That bounds this to a recovery rather than a tap loop.
    private func tap(
        _ source: XCUIElement,
        until target: XCUIElement,
        budget: TimeInterval,
        maxTaps: Int = 2
    ) -> Bool {
        let deadline = Date().addingTimeInterval(budget)
        var taps = 0
        while true {
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 {
                return target.exists
            }
            if target.waitForExistence(timeout: min(5, remaining)) {
                return true
            }
            guard taps < maxTaps, source.isHittable else {
                return target.exists
            }
            source.tap()
            taps += 1
        }
    }

    /// One `waitForExistence(timeout: 30)` is not a 30-second wait on a slow
    /// hosted simulator: each poll is a full accessibility snapshot of the
    /// WKWebView, and a single snapshot has been observed to stall for 25 s,
    /// so the wait overruns its own timeout inside a handful of polls and then
    /// reports false while the very next snapshot (the failure dump) shows the
    /// button present. Waiting in short slices re-queries the element each
    /// time, so a stalled poll expires and a fresh snapshot decides.
    ///
    /// `budget` bounds when the last slice may START, not the wall clock: a
    /// slice can still overrun its own timeout by one stalled snapshot, so
    /// the worst case is `budget` plus one stall. No query runs after the
    /// deadline, and an app that never exposes the control still fails here.
    ///
    /// Not startup-specific. The stall is a property of snapshotting this
    /// WKWebView, so every bounded wait in this test is exposed to it — #1174
    /// recorded the Add-Station name field's ten-second wait reporting false
    /// after the preceding taps had all succeeded, which is that shape one
    /// surface later.
    private func waitForElement(_ element: XCUIElement, budget: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(budget)
        while true {
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 {
                return false
            }
            if element.waitForExistence(timeout: min(10, remaining)) {
                return true
            }
        }
    }

    /// Uses one two-second budget for both discovery and dismissal so probing
    /// for a late sheet cannot extend the surrounding smoke-test timeout.
    private func dismissSystemAlertIfPresent() -> Bool {
        let deadline = Date().addingTimeInterval(2)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts.firstMatch
        guard alert.waitForExistence(timeout: deadline.timeIntervalSinceNow) else {
            return false
        }

        var dismissalButton: XCUIElement?
        for label in ["Don’t Allow", "Don't Allow"] {
            let deny = alert.buttons[label]
            if deny.exists {
                dismissalButton = deny
                break
            }
        }
        if dismissalButton == nil, alert.buttons.firstMatch.exists {
            dismissalButton = alert.buttons.firstMatch
        }
        guard let dismissalButton else {
            return false
        }

        dismissalButton.tap()
        let remaining = deadline.timeIntervalSinceNow
        if remaining <= 0 {
            return !alert.exists
        }
        return alert.waitForNonExistence(timeout: remaining)
    }

    private func assertVisibleAction(_ element: XCUIElement, within container: CGRect, label: String) {
        assertContained(element.frame, within: container, label: label)
        XCTAssertGreaterThanOrEqual(element.frame.height, 44, "\(label) is below the mobile touch-target floor.")
        XCTAssertGreaterThanOrEqual(element.frame.minY, container.minY)
        XCTAssertLessThanOrEqual(element.frame.maxY, container.maxY)
    }

    private func assertContained(_ frame: CGRect, within container: CGRect, label: String) {
        XCTAssertGreaterThanOrEqual(
            frame.minX,
            container.minX - 1,
            "\(label) moved left of the app viewport after iOS focus zoom."
        )
        XCTAssertLessThanOrEqual(
            frame.maxX,
            container.maxX + 1,
            "\(label) moved right of the app viewport after iOS focus zoom."
        )
    }
}
