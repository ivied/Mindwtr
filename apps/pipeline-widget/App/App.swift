import SwiftUI

@main
struct GTDPipelineStatusApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .frame(minWidth: 360, minHeight: 200)
        }
        .windowResizability(.contentSize)
    }
}

struct ContentView: View {
    @State private var snapshot: PipelineSnapshot? = SnapshotLoader.load()
    private let timer = Timer.publish(every: 5, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("GTD Pipeline Status")
                .font(.headline)

            if let s = snapshot {
                Text("updated: \(relativeAge(s.updatedAt))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let scr = s.screen {
                    Text("📸 screen — \(scr.app) · \(relativeAge(scr.lastCaptureAt))")
                }
                if let a = s.audio {
                    Text(String(format: "🎙 audio — rms %.3f · %@",
                                a.rms, relativeAge(a.lastChunkAt) as NSString))
                    if !a.transcript.isEmpty {
                        Text("“\(a.transcript)”").italic().lineLimit(3)
                    }
                }
            } else {
                Text("No snapshot at \(SnapshotLoader.defaultPath().path)")
                    .foregroundStyle(.secondary)
            }

            Divider()
            Text("Add the widget from Notification Center → Edit Widgets → search for “GTD Pipeline”.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .onReceive(timer) { _ in snapshot = SnapshotLoader.load() }
    }
}
