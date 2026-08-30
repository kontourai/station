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
    }
}
