import AppIntents
import UIKit

private enum MindwtrSiriCaptureLauncher {
    static func appURL(path: String, queryItems: [URLQueryItem]) -> URL? {
        var components = URLComponents()
        components.scheme = "mindwtr"
        components.host = ""
        components.path = path
        components.queryItems = queryItems
        return components.url
    }

    static func trimmed(_ value: String?) -> String? {
        let trimmedValue = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmedValue.isEmpty ? nil : trimmedValue
    }

    static func normalizedCommaList(_ value: String?) -> String? {
        guard let value else { return nil }
        let items = value
            .split(separator: ",")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return items.isEmpty ? nil : items.joined(separator: ",")
    }

    static func captureURL(task: String, note: String?, tags: String?, project: String?) -> URL? {
        var queryItems = [
            URLQueryItem(name: "title", value: task),
            URLQueryItem(name: "requestId", value: UUID().uuidString)
        ]
        if let note = trimmed(note) {
            queryItems.append(URLQueryItem(name: "note", value: note))
        }
        if let tags = normalizedCommaList(tags) {
            queryItems.append(URLQueryItem(name: "tags", value: tags))
        }
        if let project = trimmed(project) {
            queryItems.append(URLQueryItem(name: "project", value: project))
        }

        return appURL(path: "/capture", queryItems: queryItems)
    }

    static func featureURL(feature: String) -> URL? {
        appURL(
            path: "/open-feature",
            queryItems: [URLQueryItem(name: "feature", value: feature)]
        )
    }

    @MainActor
    static func open(_ url: URL) {
        // React Native may still be attaching its Linking listener on a cold Siri launch.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
    }

    @MainActor
    static func openCapture(task: String, note: String?, tags: String?, project: String?) {
        guard let url = captureURL(task: task, note: note, tags: tags, project: project) else {
            return
        }
        open(url)
    }

    @MainActor
    static func openFeature(feature: String) {
        guard let url = featureURL(feature: feature) else {
            return
        }
        open(url)
    }
}

@available(iOS 16.0, *)
enum MindwtrShortcutList: String, AppEnum {
    case inbox
    case focus
    case waiting
    case someday
    case projects
    case review
    case calendar

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Mindwtr List")
    static var caseDisplayRepresentations: [MindwtrShortcutList: DisplayRepresentation] = [
        .inbox: "Inbox",
        .focus: "Focus",
        .waiting: "Waiting",
        .someday: "Someday",
        .projects: "Projects",
        .review: "Review",
        .calendar: "Calendar"
    ]

    var featureValue: String {
        switch self {
        case .inbox:
            return "inbox"
        case .focus:
            return "focus"
        case .waiting:
            return "waiting"
        case .someday:
            return "someday"
        case .projects:
            return "projects"
        case .review:
            return "review"
        case .calendar:
            return "calendar"
        }
    }

    var dialogTitle: String {
        switch self {
        case .inbox:
            return "Inbox"
        case .focus:
            return "Focus"
        case .waiting:
            return "Waiting"
        case .someday:
            return "Someday"
        case .projects:
            return "Projects"
        case .review:
            return "Review"
        case .calendar:
            return "Calendar"
        }
    }
}

@available(iOS 16.0, *)
struct MindwtrSiriCaptureIntent: AppIntent {
    static var title: LocalizedStringResource = "Capture to Mindwtr"
    static var description = IntentDescription("Captures a task into the Mindwtr Inbox for later processing.")

#if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes {
        .foreground(.immediate)
    }
#endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool {
        true
    }

    @Parameter(title: "Task")
    var task: String

    @Parameter(title: "Note")
    var note: String?

    @Parameter(title: "Tags")
    var tags: String?

    @Parameter(title: "Project")
    var project: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Capture \(\.$task)") {
            \.$note
            \.$tags
            \.$project
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmedTask = task.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedNote = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedTags = tags?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedProject = project?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTask.isEmpty else {
            return .result(dialog: "Tell Mindwtr what to capture.")
        }

        MindwtrSiriCaptureLauncher.openCapture(
            task: trimmedTask,
            note: trimmedNote?.isEmpty == false ? trimmedNote : nil,
            tags: trimmedTags?.isEmpty == false ? trimmedTags : nil,
            project: trimmedProject?.isEmpty == false ? trimmedProject : nil
        )
        return .result(dialog: "Review it in Mindwtr.")
    }
}

@available(iOS 16.0, *)
struct MindwtrOpenListIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Mindwtr List"
    static var description = IntentDescription("Opens a Mindwtr GTD list or workflow view.")

#if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes {
        .foreground(.immediate)
    }
#endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool {
        true
    }

    @Parameter(title: "List", default: MindwtrShortcutList.inbox)
    var list: MindwtrShortcutList

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$list)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        MindwtrSiriCaptureLauncher.openFeature(feature: list.featureValue)
        return .result(dialog: "Opening \(list.dialogTitle) in Mindwtr.")
    }
}

@available(iOS 16.0, *)
struct MindwtrSiriCaptureShortcuts: AppShortcutsProvider {
    static var shortcutTileColor: ShortcutTileColor {
        .blue
    }

    @AppShortcutsBuilder
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: MindwtrSiriCaptureIntent(),
            phrases: [
                "Capture in \(.applicationName)",
                "Add to \(.applicationName)",
                "Create a task in \(.applicationName)"
            ],
            shortTitle: "Capture Task",
            systemImageName: "tray.and.arrow.down"
        )
        AppShortcut(
            intent: MindwtrOpenListIntent(),
            phrases: [
                "Open \(.applicationName)",
                "Open a list in \(.applicationName)",
                "Show \(.applicationName)"
            ],
            shortTitle: "Open List",
            systemImageName: "list.bullet"
        )
    }
}
