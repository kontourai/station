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

        let connect = app.buttons["Connect to a Station"]
        XCTAssertTrue(
            waitForStartupShell(connect, budget: 90),
            "Station never left its startup surface for an actionable no-connection shell. Accessibility hierarchy:\n\(app.debugDescription)"
        )

        // The notification sheet can arrive after the WKWebView has already
        // exposed its first actionable control. In that ordering the early
        // launch-time dismissal sees no alert, while XCTest can still report
        // the covered WebView button as hittable. Dismiss again only after the
        // shell exists, then reacquire Station before delivering the tap.
        if dismissSystemAlertIfPresent() {
            app.activate()
        }
        XCTAssertTrue(
            connect.waitForExistence(timeout: 5),
            "Connect to a Station disappeared after dismissing the notification sheet. Accessibility hierarchy:\n\(app.debugDescription)"
        )
        XCTAssertTrue(connect.isHittable)
        XCTAssertTrue(app.buttons["Open settings"].isHittable)
        XCTAssertFalse(app.staticTexts["That doesn't look like a Station address."].exists)

        connect.tap()

        let addAddress = app.buttons["Add a Station address"]
        if !addAddress.waitForExistence(timeout: 2) {
            // The notification sheet can still win the final race between the
            // post-shell dismissal and the first WebView tap. Recover once,
            // then let the existing bounded manager assertion decide the run.
            if dismissSystemAlertIfPresent() {
                app.activate()
            }
            XCTAssertTrue(
                connect.waitForExistence(timeout: 5),
                "Connect to a Station disappeared while recovering from a post-tap notification sheet. Accessibility hierarchy:\n\(app.debugDescription)"
            )
            XCTAssertTrue(connect.isHittable)
            connect.tap()
        }
        XCTAssertTrue(
            addAddress.waitForExistence(timeout: 10),
            "Station manager did not expose Add a Station address. Accessibility hierarchy:\n\(app.debugDescription)"
        )
        addAddress.tap()

        let name = app.textFields["Name (optional)"]
        let address = app.textFields["Station address"]
        XCTAssertTrue(
            name.waitForExistence(timeout: 10),
            "Add Station name input did not appear. Accessibility hierarchy:\n\(app.debugDescription)"
        )
        XCTAssertTrue(address.exists)

        let appFrame = app.frame
        assertContained(name.frame, within: appFrame, label: "Name (optional)")
        assertContained(
            address.frame,
            within: appFrame,
            label: "Station address"
        )

        let title = app.staticTexts["Add Station"]
        XCTAssertTrue(title.exists)
        let titleFrameBeforeAddressFocus = title.frame
        address.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))

        assertContained(name.frame, within: appFrame, label: "focused Name (optional)")
        assertContained(
            address.frame,
            within: appFrame,
            label: "focused Station address"
        )
        XCTAssertEqual(
            title.frame.origin.x,
            titleFrameBeforeAddressFocus.origin.x,
            accuracy: 1,
            "Focusing the address field shifted the Add Station surface horizontally."
        )
        XCTAssertEqual(
            title.frame.width,
            titleFrameBeforeAddressFocus.width,
            accuracy: 1,
            "Focusing the address field changed the Add Station surface scale."
        )
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
    private func waitForStartupShell(_ element: XCUIElement, budget: TimeInterval) -> Bool {
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
