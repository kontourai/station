import Foundation

// The card model shared by the iOS plugin and the Live Activity widget. It
// reads the same payload as the Android plugin's AgentActivityModel.kt and
// must say the same things; AgentActivityModelTests mirrors the Android tests
// so a divergence shows up on both sides. The payload fields are documented
// in docs/design/notification-delivery.md.

/// One agent thread as the card lists it, from an `activity_line_N` row.
public struct ActivityRow: Equatable {
  public let status: String
  public let title: String
  public let project: String
}

/// Where an agent thread is. The raw value is the `activity_phase` wire value.
public enum ActivityPhase: String, CaseIterable, Equatable {
  case starting = "starting"
  case running = "running"
  case approval = "waiting_for_approval"
  case input = "waiting_for_input"
  case stale = "stale"
  case completed = "completed"
  case failed = "failed"

  public var wire: String { rawValue }

  /// The label the sender writes at the front of an `activity_line_N` row.
  public var status: String {
    switch self {
    case .starting: return "Connecting"
    case .running: return "Working"
    case .approval: return "Approval"
    case .input: return "Input"
    case .stale: return "Waiting"
    case .completed: return "Done"
    case .failed: return "Failed"
    }
  }

  /// One short word for the Dynamic Island's compact and minimal slots.
  public var chip: String {
    switch self {
    case .starting, .running: return "Working"
    case .approval: return "Approve"
    case .input: return "Answer"
    case .stale, .completed, .failed: return status
    }
  }

  /// The card's button: the verb the user is asked for, else Open.
  public var action: String {
    switch self {
    case .approval: return "Approve"
    case .input: return "Answer"
    case .starting, .running, .stale, .completed, .failed: return "Open"
    }
  }

  public var needsUser: Bool { [.approval, .input].contains(self) }
  public var finished: Bool { [.completed, .failed].contains(self) }

  private static let byStatus: [String: ActivityPhase] = Dictionary(
    uniqueKeysWithValues: allCases.map { ($0.status, $0) })

  public static func forStatus(_ status: String) -> ActivityPhase? { byStatus[status] }

  public static func forWire(_ wire: String) -> ActivityPhase? { ActivityPhase(rawValue: wire) }
}

/// Row slots the sender may fill; later slots are ignored.
public let maxActivityRows = 5

private let statusCharacters = 40
private let textCharacters = 120

private extension String {
  var isBlank: Bool { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

/// The card's rows, in the sender's order (the card never re-sorts). A slot
/// that is missing, lacks three tab-separated fields, or has a blank title is
/// skipped; overlong fields are cut.
public func activityRows(_ data: [String: String]) -> [ActivityRow] {
  var rows: [ActivityRow] = []
  for slot in 0..<maxActivityRows {
    guard let line = data["activity_line_\(slot)"] else { continue }
    let fields = line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
    guard fields.count == 3 else { continue }
    let title = String(fields[1])
    if title.isBlank { continue }
    rows.append(
      ActivityRow(
        status: String(fields[0].prefix(statusCharacters)),
        title: String(title.prefix(textCharacters)),
        project: String(fields[2].prefix(textCharacters))))
  }
  return rows
}

/// `activity_phase` when it names a known phase, otherwise whatever the first
/// row's status label maps to.
public func activityPhase(_ data: [String: String], rows: [ActivityRow]) -> ActivityPhase? {
  let declared = data["activity_phase"] ?? ""
  if !declared.isBlank, let phase = ActivityPhase.forWire(declared) { return phase }
  guard let lead = rows.first else { return nil }
  return ActivityPhase.forStatus(lead.status)
}

private func total(_ data: [String: String], _ key: String) -> Int? {
  guard let raw = data[key], let value = Int(raw) else { return nil }
  return max(0, value)
}

/// Everything the card shows, worked out from the opened payload alone.
public struct ActivityModel: Equatable {
  public let active: Bool
  public let rows: [ActivityRow]
  public let phase: ActivityPhase?
  /// The sender's totals win: they count threads beyond the five rows.
  public let activeCount: Int
  public let attentionCount: Int
  public let failedCount: Int

  public init(data: [String: String], active: Bool) {
    let rows = activityRows(data)
    let rowPhases = rows.map { ActivityPhase.forStatus($0.status) }
    let finished = rowPhases.reduce(0) { $0 + ($1?.finished == true ? 1 : 0) }
    let waiting = rowPhases.reduce(0) { $0 + ($1?.needsUser == true ? 1 : 0) }
    self.active = active
    self.rows = rows
    self.phase = activityPhase(data, rows: rows)
    self.activeCount = total(data, "activity_active_count") ?? (rows.count - finished)
    self.attentionCount = total(data, "activity_attention_count") ?? waiting
    self.failedCount = rows.reduce(0) { $0 + ($1.status == ActivityPhase.failed.status ? 1 : 0) }
  }

  public var hero: ActivityRow? { rows.first }

  /// The thread itself when there is one, else a count of what matters most.
  public var summary: String {
    guard let only = hero else { return "Agent activity" }
    if rows.count == 1 { return only.title }
    if attentionCount > 0 { return attentionCount == 1 ? "1 needs you" : "\(attentionCount) need you" }
    if failedCount > 0 { return activeCount > 0 ? "\(failedCount) failed" : "Finished, \(failedCount) failed" }
    return activeCount > 0 ? "\(activeCount) working" : "All finished"
  }

  /// The compact Dynamic Island label. Unlike Android's chip it always has a
  /// value: a finished card with no phase reads "Done".
  public var chip: String {
    guard let current = phase else { return active ? "Active" : "Done" }
    guard active, current == .running, activeCount > 1 else { return current.chip }
    return activeCount > 9 ? "9+ live" : "\(activeCount) live"
  }

  /// Nil once finished: the card then only opens the app.
  public var action: String? {
    guard active else { return nil }
    return phase?.action ?? "Open"
  }
}
