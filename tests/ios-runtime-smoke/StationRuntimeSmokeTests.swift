import XCTest

final class StationRuntimeSmokeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testCleanInstallLeavesStartupForActionableConnectionState() throws {
        let app = XCUIApplication(bundleIdentifier: "io.kontourai.station")
        app.launch()

        addTeardownBlock {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "station-ios-final-state"
            attachment.lifetime = .keepAlways
            self.add(attachment)
            app.terminate()
        }

        let connect = app.buttons["Connect to a Station"]
        XCTAssertTrue(
            connect.waitForExistence(timeout: 30),
            "Station never left its startup surface for an actionable no-connection shell. Accessibility hierarchy:\n\(app.debugDescription)"
        )
        XCTAssertTrue(connect.isHittable)
        XCTAssertTrue(app.buttons["Open settings"].isHittable)
        XCTAssertFalse(app.staticTexts["That doesn't look like a Station address."].exists)

        dismissSystemAlertIfPresent()
        connect.tap()

        let addAddress = app.buttons["Add a Station address"]
        XCTAssertTrue(
            addAddress.waitForExistence(timeout: 10),
            "Station manager did not expose Add a Station address. Accessibility hierarchy:\n\(app.debugDescription)"
        )
        addAddress.tap()

        let name = app.textFields["Name (optional)"]
        let address = app.textFields["https://station.example.ts.net"]
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
            label: "https://station.example.ts.net"
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
            label: "focused https://station.example.ts.net"
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

    private func dismissSystemAlertIfPresent() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts.firstMatch
        guard alert.waitForExistence(timeout: 2) else { return }
        let deny = alert.buttons["Don’t Allow"]
        if deny.exists {
            deny.tap()
        } else if alert.buttons.firstMatch.exists {
            alert.buttons.firstMatch.tap()
        }
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
