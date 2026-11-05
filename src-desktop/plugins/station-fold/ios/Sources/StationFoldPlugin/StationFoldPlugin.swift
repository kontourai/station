import Foundation
import ObjectiveC
import StationFoldCore
import SwiftRs
import Tauri
import UIKit
import WebKit

/// Hinge geometry for the WebView, from the two iOS 27.1 seams that carry it:
///
/// - `UIView.reservedRegionsOfKind(divisionRegionKind)`: where the display
///   divides into two regions (the crease), in the queried view's coordinates;
/// - `UIHingeInteraction`: the hinge's status and angle, and the only callback
///   that fires when the posture changes without the WebView changing size
///   (Book to Open flat keeps the same bounds).
///
/// Both are reached through the Objective-C runtime rather than by name. The
/// hosted iOS builds use an Xcode whose SDK predates them, and a typed
/// reference would not compile there; looked up at run time, they work where
/// the OS has them and are simply absent elsewhere (`supported: false`).
///
/// The WebView reads `state` and treats the `change` event as a nudge to read
/// it again (`src-ui/src/platform/fold/foldSources.ts`). Coordinates are
/// the WebView's points, which are CSS pixels at the default zoom; `viewport`
/// is sent beside them so the page can scale if they differ.
// The snapshot types and what to answer when live in StationFoldCore, which
// the host `swift test` run covers; this file supplies only UIKit readings.

/// Reports layout passes of the WebView it is pinned inside: rotation, a move
/// between the cover and inner displays, and window resizes all reach here.
private final class FoldProbeView: UIView {
  var onLayout: (() -> Void)?

  override func layoutSubviews() {
    super.layoutSubviews()
    onLayout?()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    onLayout?()
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    onLayout?()
  }
}

private enum Runtime {
  static let hingeInteractionClass = NSClassFromString("UIHingeInteraction")
  static let regionKindClass = NSClassFromString("UIViewReservedRegionKind")
  static let reservedRegionsSelector = NSSelectorFromString("reservedRegionsOfKind:")

  static var supported: Bool {
    regionKindClass != nil
      && UIView.instancesRespond(to: reservedRegionsSelector)
  }

  /// `[UIViewReservedRegionKind divisionRegionKind]`.
  static func divisionKind() -> AnyObject? {
    guard let kindClass = regionKindClass as AnyObject?,
      kindClass.responds(to: NSSelectorFromString("divisionRegionKind"))
    else { return nil }
    return kindClass.perform(NSSelectorFromString("divisionRegionKind"))?.takeUnretainedValue()
  }

  /// Active division regions of `view`, in its own coordinates.
  static func divisionRegions(in view: UIView) -> [FoldRegion] {
    guard supported, let kind = divisionKind(),
      let regions = view.perform(reservedRegionsSelector, with: kind)?.takeUnretainedValue()
        as? [NSObject]
    else { return [] }
    return regions.prefix(4).compactMap { region in
      guard (region.value(forKey: "active") as? Bool) ?? false,
        let frame = (region.value(forKey: "frame") as? NSValue)?.cgRectValue,
        frame.width.isFinite, frame.height.isFinite, frame.width >= 0, frame.height >= 0
      else { return nil }
      return FoldRegion(
        x: Double(frame.minX), y: Double(frame.minY),
        width: Double(frame.width), height: Double(frame.height))
    }
  }

  static func hinge(fromUpdate update: AnyObject?) -> FoldHinge? {
    guard let update = update as? NSObject,
      let hinge = update.value(forKey: "hinge") as? NSObject
    else { return nil }
    let status: String
    switch (hinge.value(forKey: "status") as? Int) ?? 0 {
    case 1: status = "closed"
    case 2: status = "partially-open"
    case 3: status = "fully-open"
    default: status = "unknown"
    }
    let radians = (hinge.value(forKey: "angle") as? Double) ?? 0
    let degrees = radians.isFinite ? (radians * 180 / .pi * 10).rounded() / 10 : 0
    return FoldHinge(status: status, angle: degrees)
  }

  /// `[[UIHingeInteraction alloc] initWithUpdateHandler:]`, without naming the class.
  static func makeHingeInteraction(
    _ handler: @escaping (AnyObject?) -> Void
  ) -> (NSObject & UIInteraction)? {
    guard let interactionClass = hingeInteractionClass else { return nil }
    let initSelector = NSSelectorFromString("initWithUpdateHandler:")
    guard interactionClass.instancesRespond(to: initSelector),
      let metaclass = object_getClass(interactionClass),
      let allocImp = class_getMethodImplementation(metaclass, NSSelectorFromString("alloc")),
      let initImp = class_getMethodImplementation(interactionClass, initSelector)
    else { return nil }
    typealias Alloc = @convention(c) (AnyClass, Selector) -> Unmanaged<NSObject>
    typealias Initialize = @convention(c) (NSObject, Selector, AnyObject) -> Unmanaged<NSObject>?
    let block: @convention(block) (AnyObject, AnyObject) -> Void = { _, update in handler(update) }
    let allocated = unsafeBitCast(allocImp, to: Alloc.self)(
      interactionClass, NSSelectorFromString("alloc"))
    // `init` consumes the +1 from `alloc` and returns its own +1, taken here.
    guard
      let interaction = unsafeBitCast(initImp, to: Initialize.self)(
        allocated.takeUnretainedValue(), initSelector, block as AnyObject)?
        .takeRetainedValue()
    else { return nil }
    return interaction as? NSObject & UIInteraction
  }
}

class StationFoldPlugin: Plugin {
  private weak var webview: WKWebView?
  private var probe: FoldProbeView?
  private var interaction: (NSObject & UIInteraction)?
  private var hinge: FoldHinge?
  private var observers: [NSObjectProtocol] = []
  private var refreshQueued = false
  private lazy var responder = FoldStateResponder(
    read: { [weak self] in self?.reading() ?? Self.emptyReading },
    emit: { [weak self] snapshot in self?.emit(snapshot) })

  private static let emptyReading = FoldReading(
    supported: false, hinge: nil, regions: [], viewport: FoldViewport(width: 0, height: 0))

  override func load(webview: WKWebView) {
    self.webview = webview
    DispatchQueue.main.async { self.install() }
  }

  private func install() {
    guard let webview, probe == nil else { return }
    let probe = FoldProbeView(frame: webview.bounds)
    probe.isUserInteractionEnabled = false
    probe.isHidden = true
    probe.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    probe.onLayout = { [weak self] in self?.scheduleRefresh() }
    webview.addSubview(probe)
    self.probe = probe
    if let interaction = Runtime.makeHingeInteraction({ [weak self] update in
      guard let self else { return }
      self.hinge = Runtime.hinge(fromUpdate: update)
      self.scheduleRefresh()
    }) {
      webview.addInteraction(interaction)
      self.interaction = interaction
    }
    // A scene that becomes active (cold launch, a return from the background,
    // a move between displays) can carry division regions no layout announced.
    let center = NotificationCenter.default
    for name in [UIScene.didActivateNotification, UIApplication.didBecomeActiveNotification] {
      observers.append(
        center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
          self?.scheduleRefresh()
        })
    }
    responder.start { delay, work in
      DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
  }

  deinit {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
  }

  private func reading() -> FoldReading {
    let bounds = webview?.bounds ?? .zero
    return FoldReading(
      supported: Runtime.supported,
      hinge: hinge,
      regions: webview.map { Runtime.divisionRegions(in: $0) } ?? [],
      viewport: FoldViewport(width: Double(bounds.width), height: Double(bounds.height)))
  }

  private func emit(_ snapshot: FoldSnapshot) {
    #if DEBUG
      // Geometry only (no identifiers), for device verification with
      // `log stream --predicate 'eventMessage CONTAINS "[station-fold]"'`.
      if let json = try? JSONEncoder().encode(snapshot), let text = String(data: json, encoding: .utf8) {
        NSLog("[station-fold] %@", text)
      }
    #endif
    try? trigger("change", data: snapshot)
  }

  /// Coalesces a burst (rotation lays out several times) into one read after
  /// UIKit has settled the new geometry.
  private func scheduleRefresh() {
    guard !refreshQueued else { return }
    refreshQueued = true
    DispatchQueue.main.async {
      self.refreshQueued = false
      self.responder.observe()
    }
  }

  @objc public func state(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let reply = self.responder.state()
      #if DEBUG
        NSLog("[station-fold] state reply revision=%d regions=%d", reply.revision, reply.regions.count)
      #endif
      invoke.resolve(reply)
    }
  }
}

@_cdecl("init_plugin_station_fold")
func initPlugin() -> Plugin { StationFoldPlugin() }
