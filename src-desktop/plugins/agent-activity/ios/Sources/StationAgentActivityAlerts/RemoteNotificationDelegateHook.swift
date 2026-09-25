import Foundation
import ObjectiveC

/// Gives the app delegate the two remote-notification callbacks UIKit
/// reports the APNs device token through, forwarding them to a broker.
///
/// Tauri's iOS runtime (tao) declares its own `AppDelegate` class at run
/// time with only launch, URL, activity and lifecycle methods; it has no
/// `didRegisterForRemoteNotificationsWithDeviceToken`, and Tauri offers
/// plugins no hook for it. So the methods are added to the delegate's class
/// with the Objective-C runtime (the same technique push SDKs use). When the
/// class already answers them (a newer runtime, another plugin), the
/// original runs first and the broker is told after, so nothing is taken
/// from it. Foundation and the runtime only, so it is tested on macOS.
public enum RemoteNotificationDelegateHook {
  static let tokenSelector = NSSelectorFromString(
    "application:didRegisterForRemoteNotificationsWithDeviceToken:")
  static let failureSelector = NSSelectorFromString(
    "application:didFailToRegisterForRemoteNotificationsWithError:")

  private typealias TokenIMP = @convention(c) (AnyObject, Selector, AnyObject, NSData) -> Void
  private typealias FailureIMP = @convention(c) (AnyObject, Selector, AnyObject, NSError) -> Void

  private static let hooked = HookedClasses()

  /// Installs both callbacks on `delegateClass` once; later calls for the
  /// same class do nothing (a second wrap would report every token twice).
  /// Returns whether this call installed them.
  @discardableResult
  public static func install(on delegateClass: AnyClass, broker: ApnsDeviceTokenBroker) -> Bool {
    guard hooked.claim(delegateClass) else { return false }

    let originalToken = class_getInstanceMethod(delegateClass, tokenSelector).map(method_getImplementation)
    let tokenBlock: @convention(block) (AnyObject, AnyObject, NSData) -> Void = { this, application, token in
      if let originalToken {
        unsafeBitCast(originalToken, to: TokenIMP.self)(this, tokenSelector, application, token)
      }
      broker.record(deviceToken: token as Data)
    }
    replace(delegateClass, tokenSelector, imp_implementationWithBlock(tokenBlock))

    let originalFailure = class_getInstanceMethod(delegateClass, failureSelector).map(method_getImplementation)
    let failureBlock: @convention(block) (AnyObject, AnyObject, NSError) -> Void = { this, application, error in
      if let originalFailure {
        unsafeBitCast(originalFailure, to: FailureIMP.self)(this, failureSelector, application, error)
      }
      broker.record(failure: error)
    }
    replace(delegateClass, failureSelector, imp_implementationWithBlock(failureBlock))
    return true
  }

  /// Adds the method to the class itself (overriding an inherited one), or
  /// replaces the implementation the class already declares.
  private static func replace(_ cls: AnyClass, _ selector: Selector, _ imp: IMP) {
    // v@:@@ : void return, self, _cmd, two object arguments.
    if class_addMethod(cls, selector, imp, "v@:@@") { return }
    if let method = class_getInstanceMethod(cls, selector) {
      method_setImplementation(method, imp)
    }
  }
}

/// Classes already hooked. Read and written under `lock` only, hence the
/// unchecked Sendable.
private final class HookedClasses: @unchecked Sendable {
  private let lock = NSLock()
  private var classes = Set<ObjectIdentifier>()

  /// True for the first caller per class, false after.
  func claim(_ cls: AnyClass) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return classes.insert(ObjectIdentifier(cls)).inserted
  }
}
