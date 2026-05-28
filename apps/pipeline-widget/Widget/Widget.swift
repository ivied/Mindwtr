import SwiftUI
import WidgetKit

@main
struct GTDPipelineStatusWidgetBundle: WidgetBundle {
    var body: some Widget {
        PipelineWidget()
    }
}

struct PipelineWidget: Widget {
    let kind: String = "PipelineWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: PipelineTimelineProvider()) { entry in
            PipelineWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("GTD Pipeline")
        .description("Live status of screen + audio capture, transcript, and inbox.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct PipelineEntry: TimelineEntry {
    let date: Date
    let snapshot: PipelineSnapshot?
    let llm: LlmSnapshot?
}

struct PipelineTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> PipelineEntry {
        PipelineEntry(date: Date(), snapshot: nil, llm: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (PipelineEntry) -> Void) {
        completion(PipelineEntry(
            date: Date(),
            snapshot: SnapshotLoader.load(),
            llm: LlmSnapshotLoader.load()
        ))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<PipelineEntry>) -> Void) {
        // Single fresh entry per refresh — loading 15 entries at once just
        // freezes the same snapshot for 15 minutes. macOS will call us back
        // per the .after policy, and we also push WidgetCenter.reload from
        // capture-agent after every tick for near-real-time updates.
        let now = Date()
        let entry = PipelineEntry(
            date: now,
            snapshot: SnapshotLoader.load(),
            llm: LlmSnapshotLoader.load()
        )
        completion(Timeline(entries: [entry], policy: .after(now.addingTimeInterval(15))))
    }
}

struct PipelineWidgetView: View {
    let entry: PipelineEntry
    @Environment(\.widgetFamily) var family

    var body: some View {
        switch family {
        case .systemSmall: SmallView(snapshot: entry.snapshot)
        case .systemMedium: MediumView(snapshot: entry.snapshot, llm: entry.llm)
        default: LargeView(snapshot: entry.snapshot, llm: entry.llm)
        }
    }
}

// MARK: - Small
private struct SmallView: View {
    let snapshot: PipelineSnapshot?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text(overallDot(snapshot)).font(.system(size: 9))
                Text("GTD")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            if let s = snapshot {
                Text(s.audio?.transcript ?? "no audio yet")
                    .font(.system(size: 10))
                    .lineLimit(3)
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
                HStack(spacing: 8) {
                    Label(relativeAge(s.screen?.lastCaptureAt), systemImage: "camera")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                    Label(relativeAge(s.audio?.lastChunkAt), systemImage: "mic")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("No snapshot").foregroundStyle(.secondary).font(.system(size: 11))
            }
        }
    }
}

// MARK: - Medium
private struct MediumView: View {
    let snapshot: PipelineSnapshot?
    let llm: LlmSnapshot?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(overallDot(snapshot)).font(.system(size: 10))
                Text("GTD Pipeline").font(.system(size: 12, weight: .semibold))
                Spacer()
                if let s = snapshot {
                    Text(relativeAge(s.updatedAt))
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
            }
            if let s = snapshot {
                HStack(alignment: .top, spacing: 12) {
                    statusBlock(
                        icon: "camera",
                        title: "Screen",
                        line1: s.screen?.app ?? "—",
                        line2: relativeAge(s.screen?.lastCaptureAt),
                        color: Freshness.of(s.screen?.lastCaptureAt, expectedIntervalSec: 60).color
                    )
                    statusBlock(
                        icon: "mic",
                        title: "Audio",
                        line1: String(format: "rms %.3f · %d spk",
                                      s.audio?.rms ?? 0,
                                      s.audio?.speakerCount ?? 0),
                        line2: relativeAge(s.audio?.lastChunkAt),
                        color: Freshness.of(s.audio?.lastChunkAt, expectedIntervalSec: 30).color
                    )
                }
                if let t = s.audio?.transcript, !t.isEmpty {
                    Text("“\(t)”")
                        .font(.system(size: 10, design: .serif))
                        .italic()
                        .lineLimit(2)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("No snapshot at ~/.gtd-pipeline-status.json")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Large
private struct LargeView: View {
    let snapshot: PipelineSnapshot?
    let llm: LlmSnapshot?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(overallDot(snapshot)).font(.system(size: 11))
                Text("GTD Pipeline").font(.system(size: 14, weight: .semibold))
                Spacer()
                if let s = snapshot {
                    Text("pid \(s.agent.pid) · \(relativeAge(s.updatedAt))")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
            }
            if let s = snapshot {
                // Per-source state — explicit so a dead process is obvious
                // without the user having to interpret a colour.
                sourceRow(
                    icon: "camera",
                    title: "Screen",
                    state: stateLabel(s.screen?.lastCaptureAt, intervalSec: 60),
                    extra: s.screen.map { "\($0.app)\($0.sentToInbox ? "" : " · wiki-only")" } ?? "—"
                )
                sourceRow(
                    icon: "mic",
                    title: "Audio",
                    state: stateLabel(s.audio?.lastChunkAt, intervalSec: 30),
                    extra: String(format: "rms %.3f · %d spk",
                                  s.audio?.rms ?? 0,
                                  s.audio?.speakerCount ?? 0)
                )
                if let t = s.audio?.transcript, !t.isEmpty {
                    Text("“\(t)”")
                        .font(.system(size: 10, design: .serif))
                        .italic()
                        .lineLimit(3)
                        .foregroundStyle(.secondary)
                }
                Divider()
                llmBlock(llm)
                Spacer(minLength: 0)
                if let skip = s.agent.lastScreenSkip {
                    Text("last skip: \(skip)")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                }
            } else {
                Text("Capture agent not writing snapshot.\nPath: \(SnapshotLoader.defaultPath().path)")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

@ViewBuilder
private func llmBlock(_ llm: LlmSnapshot?) -> some View {
    VStack(alignment: .leading, spacing: 3) {
        HStack {
            Text("LLM verdicts")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            Spacer()
            if let l = llm {
                Text(relativeAge(l.updatedAt))
                    .font(.system(size: 9)).foregroundStyle(.tertiary)
            }
        }
        if let verdicts = llm?.verdicts, !verdicts.isEmpty {
            ForEach(Array(verdicts.prefix(3).enumerated()), id: \.offset) { _, v in
                verdictRow(v)
            }
        } else {
            Text("No LLM verdicts yet.")
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
        }
    }
}

@ViewBuilder
private func verdictRow(_ v: LlmVerdict) -> some View {
    HStack(alignment: .top, spacing: 4) {
        Text(channelEmoji(v.channel))
            .font(.system(size: 10))
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                // Emoji dot is immune to widget tinting on the desktop.
                Text("\(kindDot(v.kind)) \(kindLabel(v.kind))")
                    .font(.system(size: 9, weight: .bold))
                if let c = v.confidence {
                    Text(String(format: "%.2f", c))
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                if let cat = v.category {
                    Text(cat)
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(relativeAge(v.ts))
                    .font(.system(size: 8))
                    .foregroundStyle(.tertiary)
            }
            if !v.title.isEmpty {
                Text(v.title)
                    .font(.system(size: 10))
                    .lineLimit(1)
            } else if let r = v.reasoning, !r.isEmpty {
                Text(r)
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}

private func channelEmoji(_ c: String) -> String {
    switch c {
    case "screen": return "📸"
    case "audio": return "🎙"
    case "telegram": return "✈︎"
    case "enricher": return "✨"
    default: return "•"
    }
}

private func kindDot(_ k: String) -> String {
    switch k {
    case "created", "enriched-modify", "enriched-split": return "🟢"
    case "duplicate", "duplicate-of-existing", "enriched-noop": return "⚪"
    case "low-confidence", "wrong-role": return "🟠"
    case "not-actionable": return "🔵"
    case "error": return "🔴"
    default: return "⚪"
    }
}

private func kindLabel(_ k: String) -> String {
    switch k {
    case "created": return "CREATED"
    case "duplicate": return "DUP"
    case "duplicate-of-existing": return "DUP-EX"
    case "not-actionable": return "SKIP"
    case "low-confidence": return "LOW"
    case "wrong-role": return "ROLE"
    case "enriched-modify": return "ENRICH"
    case "enriched-split": return "SPLIT"
    case "enriched-noop": return "NOOP"
    case "error": return "ERR"
    default: return k.uppercased()
    }
}

@ViewBuilder
private func sourceRow(icon: String, title: String, state: (text: String, dot: String), extra: String) -> some View {
    // macOS desktop widgets ("accented" rendering mode) tint everything to
    // monochrome — coloured capsules render as plain white shapes. Emoji
    // colour squares are immune to that tint, so we use them as status
    // indicators instead.
    HStack(spacing: 6) {
        Image(systemName: icon).font(.system(size: 11)).frame(width: 14)
        Text(title).font(.system(size: 11, weight: .medium))
        Text("\(state.dot) \(state.text)").font(.system(size: 10, weight: .semibold))
        Spacer()
        Text(extra).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
    }
}

private func stateLabel(_ date: Date?, intervalSec: TimeInterval) -> (text: String, dot: String) {
    let f = Freshness.of(date, expectedIntervalSec: intervalSec)
    let age = relativeAge(date)
    switch f {
    case .fresh: return ("OK · \(age)", "🟢")
    case .stale: return ("STALE · \(age)", "🟠")
    case .dead:  return (date == nil ? "DEAD" : "DEAD · \(age)", "🔴")
    }
}

// MARK: - shared bits
@ViewBuilder
private func statusBlock(icon: String, title: String, line1: String, line2: String, color: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 4) {
            Image(systemName: icon).font(.system(size: 10))
            Text(title).font(.system(size: 10, weight: .medium))
            Text(dotForColorName(color)).font(.system(size: 8))
        }
        Text(line1).font(.system(size: 11)).lineLimit(1)
        Text(line2).font(.system(size: 9)).foregroundStyle(.secondary)
    }
}

private func dotForColorName(_ name: String) -> String {
    switch name {
    case "green": return "🟢"
    case "orange": return "🟠"
    case "red": return "🔴"
    default: return "⚪"
    }
}

private func swiftColor(_ name: String) -> Color {
    switch name {
    case "green": return .green
    case "orange": return .orange
    case "red": return .red
    default: return .gray
    }
}

private func overallColor(_ s: PipelineSnapshot?) -> Color {
    guard let s = s else { return .red }
    let screen = Freshness.of(s.screen?.lastCaptureAt, expectedIntervalSec: 60)
    let audio = Freshness.of(s.audio?.lastChunkAt, expectedIntervalSec: 30)
    let snap = Freshness.of(s.updatedAt, expectedIntervalSec: 60)
    let worst = [screen, audio, snap].max(by: severity)
    return swiftColor(worst?.color ?? "red")
}

private func overallDot(_ s: PipelineSnapshot?) -> String {
    guard let s = s else { return "🔴" }
    let screen = Freshness.of(s.screen?.lastCaptureAt, expectedIntervalSec: 60)
    let audio = Freshness.of(s.audio?.lastChunkAt, expectedIntervalSec: 30)
    let snap = Freshness.of(s.updatedAt, expectedIntervalSec: 60)
    let worst = [screen, audio, snap].max(by: severity) ?? .dead
    switch worst {
    case .fresh: return "🟢"
    case .stale: return "🟠"
    case .dead:  return "🔴"
    }
}

private func severity(_ a: Freshness, _ b: Freshness) -> Bool {
    func rank(_ f: Freshness) -> Int {
        switch f { case .fresh: return 0; case .stale: return 1; case .dead: return 2 }
    }
    return rank(a) < rank(b)
}
