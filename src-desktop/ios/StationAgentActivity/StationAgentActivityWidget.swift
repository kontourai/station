import ActivityKit
import SwiftUI
import WidgetKit

// The shared sources (plugins/agent-activity/ios/Sources/
// StationAgentActivityShared) are compiled into this target directly, so
// their types are in this module; the app plugin declares the same
// conformance in its own module. ActivityKit matches the two by type name.
extension StationAgentActivityAttributes: ActivityAttributes {}

@main
struct StationAgentActivityBundle: WidgetBundle {
  var body: some Widget {
    StationAgentActivityWidget()
  }
}

/// What one content update renders as, after every check has run.
struct ResolvedCard {
  let card: AgentActivityCard
  let stale: Bool

  init(_ context: ActivityViewContext<StationAgentActivityAttributes>) {
    card = AgentActivityCardResolver.resolve(
      state: context.state,
      attributesRid: context.attributes.rid,
      registration: RegistrationKeychain(accessGroup: nil).load)
    stale = context.isStale
  }

  var model: ActivityModel? {
    if case .card(let model) = card { return model }
    return nil
  }
}

struct StationAgentActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: StationAgentActivityAttributes.self) { context in
      LockScreenView(resolved: ResolvedCard(context))
        .activityBackgroundTint(Color.black.opacity(0.75))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      let resolved = ResolvedCard(context)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          AppIcon(size: 28)
        }
        DynamicIslandExpandedRegion(.trailing) {
          ChipLabel(resolved: resolved)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(headline(resolved)).font(.headline).lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          ExpandedDetail(resolved: resolved)
        }
      } compactLeading: {
        // Whose activity this is; the trailing label carries the phase.
        AppIcon(size: 20)
      } compactTrailing: {
        Text(compactLabel(resolved)).font(.caption2.weight(.semibold)).lineLimit(1)
          .foregroundStyle(phaseTint(resolved))
      } minimal: {
        MinimalView(resolved: resolved)
      }
      .keylineTint(phaseTint(resolved))
    }
  }
}

private let placeholderText = "Agent activity — open Station"
private let staleText = "Waiting for Station"

private func headline(_ resolved: ResolvedCard) -> String {
  guard let model = resolved.model else { return placeholderText }
  return resolved.stale ? staleText : model.summary
}

private func compactLabel(_ resolved: ResolvedCard) -> String {
  guard let model = resolved.model else { return "Station" }
  return resolved.stale ? "Waiting" : model.chip
}

private func phaseTint(_ resolved: ResolvedCard) -> Color {
  guard let model = resolved.model, !resolved.stale else { return .gray }
  switch model.phase {
  case .approval?, .input?: return .orange
  case .failed?: return .red
  case .completed?: return .green
  default: return model.active ? .cyan : .gray
  }
}

private func symbolName(_ resolved: ResolvedCard) -> String {
  guard let model = resolved.model else { return "square.stack.3d.up" }
  if resolved.stale { return "pause.circle" }
  switch model.phase {
  case .approval?: return "hand.raised.fill"
  case .input?: return "questionmark.bubble.fill"
  case .failed?: return "xmark.octagon.fill"
  case .completed?: return "checkmark.circle.fill"
  case .stale?: return "pause.circle"
  default: return "sparkles"
  }
}

/// The Station app icon (the brand artwork the app's AppIcon is built from),
/// full colour, with the platform's rounded-rect mask.
struct AppIcon: View {
  let size: CGFloat
  var body: some View {
    Image("StationAppIcon")
      .resizable()
      .interpolation(.high)
      .frame(width: size, height: size)
      .clipShape(RoundedRectangle(cornerRadius: size * 0.225, style: .continuous))
      .accessibilityLabel("Station")
  }
}

/// The minimal slot is all that shows while another app's activity shares
/// the island, so it is the one place a phase must win over identity: an
/// agent waiting on the person (or a failure) shows its phase symbol, and
/// anything else shows the app icon.
struct MinimalView: View {
  let resolved: ResolvedCard
  var body: some View {
    if let phase = resolved.model?.phase, !resolved.stale,
      phase.needsUser || phase == .failed
    {
      PhaseSymbol(resolved: resolved)
    } else {
      AppIcon(size: 20)
    }
  }
}

struct PhaseSymbol: View {
  let resolved: ResolvedCard
  var body: some View {
    Image(systemName: symbolName(resolved)).foregroundStyle(phaseTint(resolved))
  }
}

struct ChipLabel: View {
  let resolved: ResolvedCard
  var body: some View {
    Text(compactLabel(resolved))
      .font(.caption.weight(.semibold))
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(Capsule().fill(phaseTint(resolved).opacity(0.25)))
      .foregroundStyle(phaseTint(resolved))
      .lineLimit(1)
  }
}

struct RowLine: View {
  let row: ActivityRow
  var body: some View {
    HStack(spacing: 6) {
      Text(row.status).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
        .frame(width: 64, alignment: .leading)
      Text(row.title).font(.caption).lineLimit(1)
      Spacer(minLength: 4)
      Text(row.project).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
    }
  }
}

struct ExpandedDetail: View {
  let resolved: ResolvedCard
  var body: some View {
    if let model = resolved.model {
      VStack(alignment: .leading, spacing: 2) {
        ForEach(Array(model.rows.prefix(3).enumerated()), id: \.offset) { _, row in
          RowLine(row: row)
        }
        if let action = model.action, !resolved.stale {
          Text("\(action) in Station").font(.caption2).foregroundStyle(.secondary)
        }
      }
      .opacity(resolved.stale ? 0.5 : 1)
    } else {
      Text("Open Station to see what your agents are doing.").font(.caption)
        .foregroundStyle(.secondary)
    }
  }
}

struct LockScreenView: View {
  let resolved: ResolvedCard

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 10) {
        PhaseSymbol(resolved: resolved).font(.title3)
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 5) {
            AppIcon(size: 16)
            Text("Station").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
          }
          Text(headline(resolved)).font(.headline).lineLimit(1)
          if let hero = resolved.model?.hero, resolved.model?.rows.count == 1 {
            Text(hero.project).font(.caption).foregroundStyle(.secondary).lineLimit(1)
          }
        }
        Spacer(minLength: 6)
        if resolved.model != nil { ChipLabel(resolved: resolved) }
      }
      if let model = resolved.model, model.rows.count > 1 {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(Array(model.rows.prefix(4).enumerated()), id: \.offset) { _, row in
            RowLine(row: row)
          }
        }
      }
    }
    .padding(14)
    .foregroundStyle(.white)
    .opacity(resolved.stale ? 0.5 : 1)
  }
}
