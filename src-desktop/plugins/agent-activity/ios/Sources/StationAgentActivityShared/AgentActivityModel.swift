// Ported from the Android plugin's AgentActivityModel.kt, itself adapted from
// T3 Code (https://github.com/pingdotgg/t3code,
// apps/mobile/modules/t3-agent-notifications), MIT License,
// Copyright (c) 2026 T3 Tools Inc.

import Foundation

/// One `activity_line_N` row: `status\ttitle\tproject`, ordered by the sender.
public struct ActivityRow: Equatable {
  public let status: String
  public let title: String
  public let project: String
}

public enum ActivityPhase: CaseIterable, Equatable {
  case starting, running, approval, input, stale, completed, failed

  public var wire: String {
    switch self {
    case .starting: return "starting"
    case .running: return "running"
    case .approval: return "waiting_for_approval"
    case .input: return "waiting_for_input"
    case .stale: return "stale"
    case .completed: return "completed"
    case .failed: return "failed"
    }
  }

  /// Row status label, as the sender writes it in `activity_line_N`.
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

  /// Short label for the Dynamic Island's compact and minimal slots.
  public var chip: String {
    switch self {
    case .starting, .running: return "Working"
    case .approval: return "Approve"
    case .input: return "Answer"
    case .stale: return "Waiting"
    case .completed: return "Done"
    case .failed: return "Failed"
    }
  }

  public var action: String {
    switch self {
    case .approval: return "Approve"
    case .input: return "Answer"
    default: return "Open"
    }
  }

  public var needsUser: Bool { self == .approval || self == .input }
  public var finished: Bool { self == .completed || self == .failed }

  public static func forStatus(_ status: String) -> ActivityPhase? {
    allCases.first { $0.status == status }
  }

  public static func forWire(_ wire: String) -> ActivityPhase? {
    allCases.first { $0.wire == wire }
  }
}

public let maxActivityRows = 5

private func isBlank(_ value: String) -> Bool {
  value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

/// The sender orders rows; the card never reorders them. Malformed rows are dropped.
public func activityRows(_ data: [String: String]) -> [ActivityRow] {
  (0..<maxActivityRows).compactMap { index in
    guard let line = data["activity_line_\(index)"] else { return nil }
    let parts = line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
    guard parts.count == 3, !isBlank(String(parts[1])) else { return nil }
    return ActivityRow(
      status: String(parts[0].prefix(40)),
      title: String(parts[1].prefix(120)),
      project: String(parts[2].prefix(120)))
  }
}

public func activityPhase(_ data: [String: String], rows: [ActivityRow]) -> ActivityPhase? {
  if let wire = data["activity_phase"], !isBlank(wire), let phase = ActivityPhase.forWire(wire) {
    return phase
  }
  return rows.first.flatMap { ActivityPhase.forStatus($0.status) }
}

/// What the card says, derived only from the opened payload.
public struct ActivityModel: Equatable {
  public let active: Bool
  public let rows: [ActivityRow]
  public let phase: ActivityPhase?
  public let activeCount: Int
  public let attentionCount: Int
  public let failedCount: Int

  public init(data: [String: String], active: Bool) {
    self.active = active
    let rows = activityRows(data)
    self.rows = rows
    self.phase = activityPhase(data, rows: rows)
    self.activeCount =
      data["activity_active_count"].flatMap { Int($0) }.map { max(0, $0) }
      ?? rows.filter { ActivityPhase.forStatus($0.status)?.finished != true }.count
    self.attentionCount =
      data["activity_attention_count"].flatMap { Int($0) }.map { max(0, $0) }
      ?? rows.filter { ActivityPhase.forStatus($0.status)?.needsUser == true }.count
    self.failedCount = rows.filter { $0.status == ActivityPhase.failed.status }.count
  }

  public var hero: ActivityRow? { rows.first }

  public var summary: String {
    guard let hero else { return "Agent activity" }
    if rows.count == 1 { return hero.title }
    if attentionCount == 1 { return "1 needs you" }
    if attentionCount > 1 { return "\(attentionCount) need you" }
    if activeCount > 0 && failedCount > 0 { return "\(failedCount) failed" }
    if activeCount > 0 { return "\(activeCount) working" }
    if failedCount > 0 { return "Finished, \(failedCount) failed" }
    return "All finished"
  }

  /// The compact Dynamic Island label; "Done"/"Failed" once finished.
  public var chip: String {
    guard let phase else { return active ? "Active" : "Done" }
    if active && phase == .running && activeCount > 1 {
      return "\(activeCount > 9 ? "9+" : String(activeCount)) live"
    }
    return phase.chip
  }

  /// Nil when finished: the card only opens the app.
  public var action: String? { active ? (phase?.action ?? "Open") : nil }
}
