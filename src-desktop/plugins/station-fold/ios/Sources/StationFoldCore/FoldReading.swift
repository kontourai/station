import Foundation

// Foundation only: the plugin target supplies the UIKit readings, and the
// host `swift test` run (STATION_FOLD_HOST_TESTS=1, see Package.swift)
// exercises this half on macOS.

public struct FoldRegion: Encodable, Equatable {
  public let x: Double
  public let y: Double
  public let width: Double
  public let height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }
}

public struct FoldHinge: Encodable, Equatable {
  /// `unknown`, `closed`, `partially-open` or `fully-open` (UIHinge.Status).
  public let status: String
  /// Degrees, rounded to one place: the page snaps layout, it does not animate the angle.
  public let angle: Double

  public init(status: String, angle: Double) {
    self.status = status
    self.angle = angle
  }
}

public struct FoldViewport: Encodable, Equatable {
  public let width: Double
  public let height: Double

  public init(width: Double, height: Double) {
    self.width = width
    self.height = height
  }
}

/// One reading of the display, before it is given a revision.
public struct FoldReading: Equatable {
  public let supported: Bool
  public let hinge: FoldHinge?
  public let regions: [FoldRegion]
  public let viewport: FoldViewport

  public init(supported: Bool, hinge: FoldHinge?, regions: [FoldRegion], viewport: FoldViewport) {
    self.supported = supported
    self.hinge = hinge
    self.regions = regions
    self.viewport = viewport
  }
}

/// What `state` answers and the `change` event carries
/// (`src-ui/src/platform/fold/foldGeometry.ts` parses it). JSONEncoder omits a
/// nil `hinge`, so the page sees the key absent, not null.
public struct FoldSnapshot: Encodable, Equatable {
  public let revision: Int
  public let supported: Bool
  public let hinge: FoldHinge?
  public let regions: [FoldRegion]
  public let viewport: FoldViewport

  public var reading: FoldReading {
    FoldReading(supported: supported, hinge: hinge, regions: regions, viewport: viewport)
  }
}

/// Revisions for readings, and the decision of when a reading has moved.
///
/// The plugin must never answer from what it last saw. A cold launch on a
/// device already in Book records a first reading before UIKit's first hinge
/// update and before the scene has division regions; if `state` answered that
/// cached reading, a page that asked in between would be told "no crease" with
/// nothing left to change its mind. So every answer is a fresh reading passed
/// through `answer(_:)`, which also tells the caller whether to emit `change`.
public struct FoldReadingLedger {
  public private(set) var current: FoldSnapshot?

  public init() {}

  /// The reply to `state`: a fresh reading, recorded with a new revision when
  /// it differs from the last one (`moved`: emit `change` too), otherwise the
  /// unchanged current snapshot.
  public mutating func answer(_ fresh: FoldReading) -> (reply: FoldSnapshot, moved: Bool) {
    if let current, current.reading == fresh { return (current, false) }
    let next = FoldSnapshot(
      revision: (current?.revision ?? 0) + 1,
      supported: fresh.supported,
      hinge: fresh.hinge,
      regions: fresh.regions,
      viewport: fresh.viewport)
    current = next
    return (next, true)
  }

  /// Records a reading taken on a layout, hinge or activation callback;
  /// returns the snapshot to emit when it moved, nil when nothing changed.
  public mutating func record(_ reading: FoldReading) -> FoldSnapshot? {
    let (reply, moved) = answer(reading)
    return moved ? reply : nil
  }
}

/// Everything the plugin does with readings, minus UIKit: answering `state`,
/// emitting `change`, and the follow-up re-reads after install. The plugin
/// supplies how to read the display, how to emit, and how to schedule; its
/// `state` command is `responder.state()` and nothing else.
public final class FoldStateResponder {
  /// Seconds after `start` at which the display is read again whether or not
  /// UIKit called back. On a cold launch into Book the division region can
  /// appear with no layout pass, hinge update or trait change to announce it,
  /// so the plugin looks again itself. Bounded: three reads over three seconds.
  public static let followUpReadsSeconds: [Double] = [0.25, 1, 3]

  private var ledger = FoldReadingLedger()
  private let read: () -> FoldReading
  private let emit: (FoldSnapshot) -> Void

  public init(read: @escaping () -> FoldReading, emit: @escaping (FoldSnapshot) -> Void) {
    self.read = read
    self.emit = emit
  }

  public var current: FoldSnapshot? { ledger.current }

  /// The reply to the `state` command: always a fresh reading.
  public func state() -> FoldSnapshot {
    let (reply, moved) = ledger.answer(read())
    if moved { emit(reply) }
    return reply
  }

  /// A UIKit callback (layout, hinge update, scene activation, trait change)
  /// or a follow-up: read, and emit `change` if the reading moved.
  public func observe() {
    if let moved = ledger.record(read()) { emit(moved) }
  }

  /// The first reading, plus the follow-up re-reads.
  public func start(schedule: (Double, @escaping () -> Void) -> Void) {
    observe()
    for delay in Self.followUpReadsSeconds {
      schedule(delay) { [weak self] in self?.observe() }
    }
  }
}
