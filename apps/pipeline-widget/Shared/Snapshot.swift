import Foundation

/// Mirrors the JSON written by capture-agent/src/status/publisher.ts.
/// Keep field names in sync with PipelineSnapshot in TypeScript.
struct PipelineSnapshot: Decodable {
    let updatedAt: Date
    let agent: AgentBlock
    let screen: ScreenBlock?
    let audio: AudioBlock?

    struct AgentBlock: Decodable {
        let pid: Int
        let startedAt: Date
        let lastScreenSkip: String?
    }

    struct ScreenBlock: Decodable {
        let lastCaptureAt: Date
        let app: String
        let title: String
        let sentToInbox: Bool
        let ocrLength: Int
        let displayIndex: Int?
        let isActiveDisplay: Bool?
    }

    struct AudioBlock: Decodable {
        let lastChunkAt: Date
        let rms: Double
        let transcript: String
        let durationMs: Int
        let speakerCount: Int?
        let userSeen: Bool?
        let likelyMixedSpeakers: Bool?
    }
}

enum SnapshotLoader {
    /// JSON lives at a known absolute path. We can't use
    /// `FileManager.homeDirectoryForCurrentUser` from a sandboxed widget
    /// extension — that returns the container's home, not the real ~/. The
    /// Widget.entitlements file grants read-only access to this exact path.
    static func defaultPath() -> URL {
        URL(fileURLWithPath: "/Users/sergeykurdyuk/.gtd-pipeline-status.json")
    }

    static func load(from url: URL = defaultPath()) -> PipelineSnapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(PipelineSnapshot.self, from: data)
    }
}

// MARK: - LLM verdicts (written by ai-service via docker mount)

struct LlmSnapshot: Decodable {
    let updatedAt: Date
    let verdicts: [LlmVerdict]
}

struct LlmVerdict: Decodable {
    let ts: Date
    let channel: String   // "screen" | "audio" | "telegram" | "enricher" | "unknown"
    let kind: String      // "created" | "duplicate" | "not-actionable" | …
    let title: String
    let confidence: Double?
    let category: String?
    let reasoning: String?
    let diff: String?
}

enum LlmSnapshotLoader {
    static func defaultPath() -> URL {
        URL(fileURLWithPath: "/Users/sergeykurdyuk/.gtd-pipeline-llm.json")
    }

    static func load(from url: URL = defaultPath()) -> LlmSnapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(LlmSnapshot.self, from: data)
    }
}

enum Freshness {
    case fresh   // < 2× expected interval
    case stale   // 2–10× interval
    case dead    // > 10× interval, or missing

    static func of(_ date: Date?, expectedIntervalSec: TimeInterval) -> Freshness {
        guard let date = date else { return .dead }
        let age = Date().timeIntervalSince(date)
        if age < expectedIntervalSec * 2 { return .fresh }
        if age < expectedIntervalSec * 10 { return .stale }
        return .dead
    }

    var color: String {
        switch self {
        case .fresh: return "green"
        case .stale: return "orange"
        case .dead:  return "red"
        }
    }
}

func relativeAge(_ date: Date?) -> String {
    guard let date = date else { return "—" }
    let s = Int(Date().timeIntervalSince(date))
    if s < 60 { return "\(s)s ago" }
    if s < 3600 { return "\(s / 60)m ago" }
    return "\(s / 3600)h ago"
}
