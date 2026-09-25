import Foundation
import StationAgentActivityShared
import XCTest

@testable import StationAgentActivityAlerts

/// Stands in for tao's AppDelegate: a class with none of the callbacks.
@objc private final class BareDelegate: NSObject {}

/// A delegate that already answers the token callback: it must keep working.
@objc private final class ExistingDelegate: NSObject {
  static var seen: [Data] = []
  @objc func application(_ application: AnyObject, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
    Self.seen.append(token)
  }
}

@objc private class ParentDelegate: NSObject {
  static var seen = 0
  @objc func application(_ application: AnyObject, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
    Self.seen += 1
  }
}
@objc private final class ChildDelegate: ParentDelegate {}

/// Stands in for UIApplication: records every delegate assignment, and
/// whether the delegate already answered the token callback at that moment.
private final class FakeApplication: ApplicationDelegateHolder {
  var assignments: [(object: AnyObject?, answeredToken: Bool)] = []
  private var stored: AnyObject?
  init(_ delegate: AnyObject) { stored = delegate }
  var hookableDelegate: AnyObject? {
    get { stored }
    set {
      stored = newValue
      assignments.append(
        (newValue, newValue?.responds(to: RemoteNotificationDelegateHook.tokenSelector) ?? false))
    }
  }
}

@objc private final class LaunchDelegate: NSObject {}

private struct Refused: LocalizedError {
  var errorDescription: String? { "no valid aps-environment entitlement" }
}

private let token32 = Data((0..<32).map { UInt8($0) })
private let hex32 = (0..<32).map { String(format: "%02x", $0) }.joined()

final class ApnsDeviceTokenTests: XCTestCase {
  func testHexIsLowercaseAndBoundedLikeTheStation() {
    XCTAssertEqual(apnsDeviceTokenHex(token32), hex32)
    XCTAssertEqual(apnsDeviceTokenHex(Data(repeating: 0xAB, count: 32)), String(repeating: "ab", count: 32))
    XCTAssertNotNil(apnsDeviceTokenHex(Data(repeating: 1, count: 100)))
    XCTAssertNil(apnsDeviceTokenHex(Data(repeating: 1, count: 31)))
    XCTAssertNil(apnsDeviceTokenHex(Data(repeating: 1, count: 101)))
    XCTAssertNil(apnsDeviceTokenHex(Data()))
  }

  func testAWaiterGetsTheTokenEvenIfItArrivedFirst() async {
    let broker = ApnsDeviceTokenBroker()
    broker.record(deviceToken: token32)
    let first = await firstValue(timeout: 2) { broker.updates() }
    XCTAssertEqual(first, .token(hex32))
  }

  func testAWaiterGetsATokenThatArrivesLater() async {
    let broker = ApnsDeviceTokenBroker()
    Task {
      try? await Task.sleep(nanoseconds: 50_000_000)
      broker.record(deviceToken: token32)
    }
    let first = await firstValue(timeout: 5) { broker.updates() }
    XCTAssertEqual(first, .token(hex32))
  }

  func testResetForgetsAStaleAnswerAndNoAnswerTimesOut() async {
    let broker = ApnsDeviceTokenBroker()
    broker.record(failure: Refused())
    broker.reset()
    let first = await firstValue(timeout: 0.2) { broker.updates() }
    XCTAssertNil(first)
  }

  func testAFailureAndAnUnusableTokenAreFailures() async {
    let broker = ApnsDeviceTokenBroker()
    broker.record(failure: Refused())
    let failed = await firstValue(timeout: 2) { broker.updates() }
    XCTAssertEqual(failed, .failed("no valid aps-environment entitlement"))
    broker.record(deviceToken: Data(repeating: 1, count: 8))
    let short = await firstValue(timeout: 2) { broker.updates() }
    XCTAssertEqual(short, .failed("APNs returned a device token of 8 bytes"))
  }

  func testTheHookAddsBothCallbacksToABareDelegate() async {
    let broker = ApnsDeviceTokenBroker()
    let delegate = BareDelegate()
    XCTAssertFalse(delegate.responds(to: RemoteNotificationDelegateHook.tokenSelector))
    XCTAssertTrue(RemoteNotificationDelegateHook.install(on: BareDelegate.self, broker: broker))
    XCTAssertTrue(delegate.responds(to: RemoteNotificationDelegateHook.tokenSelector))
    XCTAssertTrue(delegate.responds(to: RemoteNotificationDelegateHook.failureSelector))
    // UIKit's call, as the Objective-C runtime delivers it.
    _ = delegate.perform(RemoteNotificationDelegateHook.tokenSelector, with: NSObject(), with: token32 as NSData)
    let first = await firstValue(timeout: 2) { broker.updates() }
    XCTAssertEqual(first, .token(hex32))
    _ = delegate.perform(
      RemoteNotificationDelegateHook.failureSelector, with: NSObject(),
      with: NSError(domain: "test", code: 3, userInfo: [NSLocalizedDescriptionKey: "denied"]))
    let failed = await firstValue(timeout: 2) { broker.updates() }
    XCTAssertEqual(failed, .failed("denied"))
    // Installing again does not wrap twice.
    XCTAssertFalse(RemoteNotificationDelegateHook.install(on: BareDelegate.self, broker: broker))
  }

  func testAnExistingCallbackStillRunsBeforeTheBrokerIsTold() async {
    let broker = ApnsDeviceTokenBroker()
    ExistingDelegate.seen = []
    RemoteNotificationDelegateHook.install(on: ExistingDelegate.self, broker: broker)
    _ = ExistingDelegate().perform(
      RemoteNotificationDelegateHook.tokenSelector, with: NSObject(), with: token32 as NSData)
    XCTAssertEqual(ExistingDelegate.seen, [token32])
    let first = await firstValue(timeout: 2) { broker.updates() }
    XCTAssertEqual(first, .token(hex32))
  }

  func testAnInheritedCallbackStillRunsAndTheParentIsNotChanged() async {
    let broker = ApnsDeviceTokenBroker()
    ParentDelegate.seen = 0
    RemoteNotificationDelegateHook.install(on: ChildDelegate.self, broker: broker)
    _ = ChildDelegate().perform(
      RemoteNotificationDelegateHook.tokenSelector, with: NSObject(), with: token32 as NSData)
    XCTAssertEqual(ParentDelegate.seen, 1)
    let first = await firstValue(timeout: 2) { broker.updates() }
    XCTAssertEqual(first, .token(hex32))
    // The parent class itself was left alone: calling the parent reaches
    // only its own method, never the child's broker.
    broker.reset()
    _ = ParentDelegate().perform(
      RemoteNotificationDelegateHook.tokenSelector, with: NSObject(), with: token32 as NSData)
    XCTAssertEqual(ParentDelegate.seen, 2)
    let none = await firstValue(timeout: 0.2) { broker.updates() }
    XCTAssertNil(none)
  }

  func testInstallingOnTheApplicationReassignsTheSameDelegateAfterHooking() {
    let delegate = LaunchDelegate()
    let application = FakeApplication(delegate)
    XCTAssertTrue(RemoteNotificationDelegateHook.install(in: application, broker: ApnsDeviceTokenBroker()))
    // Set again, to the very same object, once it already has the callbacks.
    XCTAssertEqual(application.assignments.count, 1)
    XCTAssertTrue(application.assignments.first?.object === delegate)
    XCTAssertEqual(application.assignments.first?.answeredToken, true)
    // A second install (the command after load) assigns nothing more.
    XCTAssertFalse(RemoteNotificationDelegateHook.install(in: application, broker: ApnsDeviceTokenBroker()))
    XCTAssertEqual(application.assignments.count, 1)
  }
}
