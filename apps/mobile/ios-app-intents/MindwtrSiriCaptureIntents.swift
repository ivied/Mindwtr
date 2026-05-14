import AppIntents
import UIKit

private enum MindwtrSiriCaptureLauncher {
    static func captureURL(task: String, note: String?) -> URL? {
        var components = URLComponents()
        components.scheme = "mindwtr"
        components.host = ""
        components.path = "/capture"

        var queryItems = [
            URLQueryItem(name: "title", value: task)
        ]
        if let note, !note.isEmpty {
            queryItems.append(URLQueryItem(name: "note", value: note))
        }
        components.queryItems = queryItems

        return components.url
    }

    @MainActor
    static func openCapture(task: String, note: String?) {
        guard let url = captureURL(task: task, note: note) else {
            return
        }

        // React Native may still be attaching its Linking listener on a cold Siri launch.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
    }
}

@available(iOS 16.0, *)
struct MindwtrSiriCaptureIntent: AppIntent {
    static var title: LocalizedStringResource = "Capture to Mindwtr"
    static var description = IntentDescription("Captures a task into the Mindwtr Inbox for later processing.")

#if compiler(>=6.0)
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

    static var parameterSummary: some ParameterSummary {
        Summary("Capture \(\.$task)") {
            \.$note
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmedTask = task.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedNote = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTask.isEmpty else {
            return .result(dialog: "Tell Mindwtr what to capture.")
        }

        MindwtrSiriCaptureLauncher.openCapture(
            task: trimmedTask,
            note: trimmedNote?.isEmpty == false ? trimmedNote : nil
        )
        return .result(dialog: "Review it in Mindwtr.")
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
                "Capture \(\.$task) in \(.applicationName)",
                "Add \(\.$task) to \(.applicationName)",
                "Create a task in \(.applicationName)"
            ],
            shortTitle: "Capture",
            systemImageName: "tray.and.arrow.down"
        )
    }
}
