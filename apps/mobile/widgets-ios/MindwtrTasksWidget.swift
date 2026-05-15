import SwiftUI
import WidgetKit

private let mindwtrWidgetKind = "MindwtrTasksWidget"
private let mindwtrWidgetAppGroup = "group.tech.dongdongbh.mindwtr"
private let mindwtrWidgetPayloadKey = "mindwtr-ios-widget-payload"
private let mindwtrWidgetPayloadKeySmall = "mindwtr-ios-widget-payload-small"
private let mindwtrWidgetPayloadKeyMedium = "mindwtr-ios-widget-payload-medium"
private let mindwtrWidgetPayloadKeyLarge = "mindwtr-ios-widget-payload-large"
private let darkThemeModes: Set<String> = ["dark", "material3-dark", "nord", "oled"]
private let lightThemeModes: Set<String> = ["light", "material3-light", "eink", "sepia"]

private struct MindwtrWidgetTaskItem: Decodable {
    let id: String
    let title: String
    let statusLabel: String?
}

private struct MindwtrWidgetPalette: Decodable {
    let background: String
    let card: String
    let border: String
    let text: String
    let mutedText: String
    let accent: String
    let onAccent: String
}

private extension MindwtrWidgetPalette {
    static let light = MindwtrWidgetPalette(
        background: "#F8FAFC",
        card: "#FFFFFF",
        border: "#CBD5E1",
        text: "#0F172A",
        mutedText: "#475569",
        accent: "#2563EB",
        onAccent: "#FFFFFF"
    )

    static let dark = MindwtrWidgetPalette(
        background: "#111827",
        card: "#1F2937",
        border: "#374151",
        text: "#F9FAFB",
        mutedText: "#CBD5E1",
        accent: "#2563EB",
        onAccent: "#FFFFFF"
    )
}

private struct MindwtrTasksWidgetPayload: Decodable {
    let headerTitle: String
    let subtitle: String
    let items: [MindwtrWidgetTaskItem]
    let emptyMessage: String
    let captureLabel: String
    let focusUri: String
    let quickCaptureUri: String
    let themeMode: String?
    let palette: MindwtrWidgetPalette

    static var fallback: MindwtrTasksWidgetPayload {
        MindwtrTasksWidgetPayload(
            headerTitle: "Today",
            subtitle: "Inbox: 0",
            items: [],
            emptyMessage: "No tasks",
            captureLabel: "Quick capture",
            focusUri: "mindwtr:///focus",
            quickCaptureUri: "mindwtr:///capture-quick?mode=text",
            themeMode: "system",
            palette: .light
        )
    }
}

private struct MindwtrTasksWidgetEntry: TimelineEntry {
    let date: Date
    let payload: MindwtrTasksWidgetPayload
}

private struct MindwtrTasksWidgetProvider: TimelineProvider {
    func placeholder(in _: Context) -> MindwtrTasksWidgetEntry {
        MindwtrTasksWidgetEntry(date: Date(), payload: .fallback)
    }

    func getSnapshot(in context: Context, completion: @escaping (MindwtrTasksWidgetEntry) -> Void) {
        completion(MindwtrTasksWidgetEntry(date: Date(), payload: loadPayload(for: context.family)))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<MindwtrTasksWidgetEntry>) -> Void) {
        let now = Date()
        let entry = MindwtrTasksWidgetEntry(date: now, payload: loadPayload(for: context.family))
        let refresh = Calendar.current.date(byAdding: .minute, value: 30, to: now) ?? now.addingTimeInterval(1800)
        completion(Timeline(entries: [entry], policy: .after(refresh)))
    }

    private func loadPayload(for family: WidgetFamily) -> MindwtrTasksWidgetPayload {
        guard let defaults = UserDefaults(suiteName: mindwtrWidgetAppGroup) else {
            return .fallback
        }

        let payloadKeys = [payloadKey(for: family), mindwtrWidgetPayloadKey]
        for key in payloadKeys {
            guard
                let jsonString = defaults.string(forKey: key),
                let data = jsonString.data(using: .utf8)
            else {
                continue
            }

            do {
                return try JSONDecoder().decode(MindwtrTasksWidgetPayload.self, from: data)
            } catch {
                continue
            }
        }

        return .fallback
    }

    private func payloadKey(for family: WidgetFamily) -> String {
        switch family {
        case .systemSmall:
            return mindwtrWidgetPayloadKeySmall
        case .systemMedium:
            return mindwtrWidgetPayloadKeyMedium
        case .systemLarge:
            return mindwtrWidgetPayloadKeyLarge
        default:
            return mindwtrWidgetPayloadKey
        }
    }
}

private struct MindwtrTasksWidgetView: View {
    let entry: MindwtrTasksWidgetEntry
    @Environment(\.widgetFamily) private var widgetFamily
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let payload = entry.payload
        let palette = resolvePalette(payload)
        GeometryReader { geometry in
            let visibleTaskLimit = resolveTaskLimit(itemCount: payload.items.count, availableHeight: geometry.size.height)
            VStack(alignment: .leading, spacing: 6) {
                Link(destination: URL(string: payload.focusUri) ?? URL(fileURLWithPath: "/")) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(payload.headerTitle)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(hexColor(palette.text))
                            .lineLimit(1)
                        Text(payload.subtitle)
                            .font(.system(size: 11))
                            .foregroundColor(hexColor(palette.mutedText))
                            .lineLimit(1)
                    }
                }

                if payload.items.isEmpty {
                    TaskLineView(
                        title: payload.emptyMessage,
                        textColor: palette.mutedText,
                        focusUri: payload.focusUri
                    )
                } else {
                    ForEach(payload.items.prefix(visibleTaskLimit), id: \.id) { item in
                        TaskLineView(
                            title: "• \(item.title)",
                            textColor: palette.text,
                            focusUri: payload.focusUri
                        )
                    }
                }

                Spacer(minLength: 0)

                Link(destination: URL(string: payload.quickCaptureUri) ?? URL(fileURLWithPath: "/")) {
                    Text(payload.captureLabel)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(hexColor(palette.onAccent))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(hexColor(palette.accent))
                        .clipShape(Capsule())
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .mindwtrWidgetBackground(hexColor(palette.background))
        }
    }

    private var familyTaskCap: Int {
        switch widgetFamily {
        case .systemLarge:
            return 8
        case .systemMedium:
            return 5
        default:
            return 3
        }
    }

    private func resolveTaskLimit(itemCount: Int, availableHeight: CGFloat) -> Int {
        guard itemCount > 0 else { return 0 }
        let minimumRows = min(3, itemCount)
        let reservedHeight: CGFloat = 110
        let rowHeight: CGFloat = 16
        let fitRows = max(0, Int(floor((availableHeight - reservedHeight) / rowHeight)))
        if fitRows >= minimumRows {
            return min(itemCount, min(familyTaskCap, fitRows))
        }
        return min(itemCount, max(1, fitRows))
    }

    private func resolvePalette(_ payload: MindwtrTasksWidgetPayload) -> MindwtrWidgetPalette {
        let mode = (payload.themeMode ?? "system")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        if darkThemeModes.contains(mode) {
            return .dark
        }
        if lightThemeModes.contains(mode) {
            return .light
        }
        if mode.isEmpty || mode == "system" {
            return colorScheme == .dark ? .dark : .light
        }

        return payload.palette
    }
}

private struct TaskLineView: View {
    let title: String
    let textColor: String
    let focusUri: String

    var body: some View {
        Link(destination: URL(string: focusUri) ?? URL(fileURLWithPath: "/")) {
            Text(title)
                .font(.system(size: 12))
                .foregroundColor(hexColor(textColor))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 1)
        }
    }
}

private extension View {
    @ViewBuilder
    func mindwtrWidgetBackground(_ color: Color) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            self.containerBackground(for: .widget) { color }
        } else {
            self.background(color)
        }
    }
}

private func hexColor(_ hex: String) -> Color {
    let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    var int: UInt64 = 0
    Scanner(string: cleaned).scanHexInt64(&int)

    let r: UInt64
    let g: UInt64
    let b: UInt64
    let a: UInt64

    switch cleaned.count {
    case 3:
        (r, g, b, a) = ((int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17, 255)
    case 4:
        (r, g, b, a) = ((int >> 12) * 17, (int >> 8 & 0xF) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
    case 6:
        (r, g, b, a) = (int >> 16, int >> 8 & 0xFF, int & 0xFF, 255)
    case 8:
        // Supports CSS-style #RRGGBBAA payload values.
        (r, g, b, a) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
    default:
        (r, g, b, a) = (15, 23, 42, 255)
    }

    return Color(
        .sRGB,
        red: Double(r) / 255,
        green: Double(g) / 255,
        blue: Double(b) / 255,
        opacity: Double(a) / 255
    )
}

struct MindwtrTasksWidget: Widget {
    let kind: String = mindwtrWidgetKind

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: MindwtrTasksWidgetProvider()) { entry in
            MindwtrTasksWidgetView(entry: entry)
        }
        .configurationDisplayName("Mindwtr")
        .description("Inbox, focus, and quick capture")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
