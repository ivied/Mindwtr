// gtd-audio-diarize
//
// Diarize a WAV file with optional known-speaker matching. Loads a
// speaker profile (from gtd-audio-enroll), registers it as a known
// speaker in FluidAudio, runs full diarization, and emits JSON with
// each segment labelled by speaker plus an `is_user` flag for the
// enrolled speaker.
//
// Usage:
//   gtd-audio-diarize --input chunk.wav --profile profile.json --output segments.json
//   gtd-audio-diarize --input chunk.wav --output segments.json  # no profile = anonymous

import AVFoundation
import FluidAudio
import Foundation

func eprint(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8) ?? Data())
}

struct DiarizeArgs {
    var input: String
    var output: String
    var profile: String?
    /// FluidAudio clustering threshold (cosine distance for splitting/merging
    /// anonymous speakers during diarization). Default 0.7. Lower = more
    /// likely to split similar-sounding speakers.
    var clusteringThreshold: Float = 0.7
    /// Our own post-process gate for is_user. Cosine SIMILARITY between
    /// segment embedding and enrolled profile must be ≥ this to label a
    /// segment as the user. Default 0.55. Higher = stricter user match.
    var userMatchThreshold: Float = 0.55
    /// Emit raw 256-d embeddings per segment (large payload — debug only).
    var includeEmbeddings: Bool = false
}

func parseArgs() -> DiarizeArgs {
    var input: String?
    var output: String?
    var args = DiarizeArgs(input: "", output: "")
    let argv = CommandLine.arguments
    var i = 1
    while i < argv.count {
        switch argv[i] {
        case "--input":
            if i + 1 < argv.count { input = argv[i + 1] }
            i += 2
        case "--output":
            if i + 1 < argv.count { output = argv[i + 1] }
            i += 2
        case "--profile":
            if i + 1 < argv.count { args.profile = argv[i + 1] }
            i += 2
        case "--clustering-threshold":
            if i + 1 < argv.count, let f = Float(argv[i + 1]) { args.clusteringThreshold = f }
            i += 2
        case "--user-match-threshold":
            if i + 1 < argv.count, let f = Float(argv[i + 1]) { args.userMatchThreshold = f }
            i += 2
        case "--include-embeddings":
            args.includeEmbeddings = true
            i += 1
        case "--help", "-h":
            print(
                """
                Usage: gtd-audio-diarize --input <wav> --output <json> [opts]
                  --profile <profile.json>            enable user identification
                  --clustering-threshold <0..1>       FluidAudio split threshold (default 0.7)
                  --user-match-threshold <0..1>       cosine similarity gate for is_user (default 0.55)
                  --include-embeddings                emit raw 256-d embeddings per segment
                """
            )
            exit(0)
        default:
            i += 1
        }
    }
    guard let input, let output else {
        eprint("error: --input and --output required")
        exit(1)
    }
    args.input = input
    args.output = output
    return args
}

/// Cosine similarity between two L2-normalised embeddings ∈ [-1, 1].
/// FluidAudio embeddings are not pre-normalised so we normalise here.
func cosineSimilarity(_ a: [Float], _ b: [Float]) -> Float {
    guard a.count == b.count, !a.isEmpty else { return 0 }
    var dot: Float = 0
    var na: Float = 0
    var nb: Float = 0
    for i in 0..<a.count {
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
    }
    let denom = (na.squareRoot()) * (nb.squareRoot())
    return denom > 0 ? dot / denom : 0
}

func readWavAsMono16kFloat(path: String) throws -> [Float] {
    let url = URL(fileURLWithPath: path)
    let file = try AVAudioFile(forReading: url)
    let inFormat = file.processingFormat
    guard
        let target = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false
        )
    else {
        throw NSError(domain: "diarize", code: 1)
    }
    guard let converter = AVAudioConverter(from: inFormat, to: target) else {
        throw NSError(domain: "diarize", code: 2)
    }
    guard
        let inBuffer = AVAudioPCMBuffer(
            pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(file.length)
        )
    else { throw NSError(domain: "diarize", code: 3) }
    try file.read(into: inBuffer)

    let ratio = target.sampleRate / inFormat.sampleRate
    let outCapacity = AVAudioFrameCount(Double(inBuffer.frameLength) * ratio * 1.1) + 1024
    guard let outBuffer = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: outCapacity) else {
        throw NSError(domain: "diarize", code: 4)
    }
    var error: NSError?
    var provided = false
    let status = converter.convert(to: outBuffer, error: &error) { _, outStatus in
        if provided {
            outStatus.pointee = .noDataNow
            return nil
        }
        provided = true
        outStatus.pointee = .haveData
        return inBuffer
    }
    if status == .error { throw error ?? NSError(domain: "diarize", code: 5) }

    let n = Int(outBuffer.frameLength)
    guard let p = outBuffer.floatChannelData?[0] else { return [] }
    return Array(UnsafeBufferPointer(start: p, count: n))
}

struct Profile: Decodable {
    let schema: Int?
    let name: String
    let embedding: [Float]
    let duration_s: Double?
}

func loadProfile(path: String) throws -> Profile {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let p = try JSONDecoder().decode(Profile.self, from: data)
    return p
}

@main
struct Diarize {
    static func main() async throws {
        let args = parseArgs()
        let samples = try readWavAsMono16kFloat(path: args.input)
        eprint("samples: \(samples.count) (\(Double(samples.count) / 16_000) s)")

        let models = try await DiarizerModels.downloadIfNeeded()
        var config = DiarizerConfig()
        config.clusteringThreshold = args.clusteringThreshold
        let manager = DiarizerManager(config: config)
        manager.initialize(models: models)

        var userSpeakerId: String?
        var profileEmbedding: [Float] = []
        if let profilePath = args.profile {
            let profile = try loadProfile(path: profilePath)
            profileEmbedding = profile.embedding
            let userSpeaker = Speaker(
                id: "user",
                name: profile.name,
                currentEmbedding: profile.embedding,
                duration: Float(profile.duration_s ?? 0),
                isPermanent: true
            )
            await manager.initializeKnownSpeakers([userSpeaker])
            userSpeakerId = userSpeaker.id
            eprint(
                "user registered: id=\(userSpeaker.id) name=\(profile.name), "
                    + "clustering_threshold=\(args.clusteringThreshold) "
                    + "user_match_threshold=\(args.userMatchThreshold)"
            )
        }

        let result = try await manager.performCompleteDiarization(samples, sampleRate: 16_000)
        eprint("segments: \(result.segments.count)")

        // Post-process: re-evaluate is_user with OUR own threshold using cosine
        // similarity between each segment's embedding and the enrolled profile.
        // FluidAudio's internal speakerThreshold is hard to reach via the public
        // API; doing the check ourselves lets us tune precision without touching
        // FluidAudio internals.
        var seenSpeakers = Set<String>()
        var segmentsJson: [[String: Any]] = []
        for seg in result.segments {
            seenSpeakers.insert(seg.speakerId)
            var isUser = false
            var similarity: Float = 0
            if !profileEmbedding.isEmpty && !seg.embedding.isEmpty {
                similarity = cosineSimilarity(seg.embedding, profileEmbedding)
                isUser = similarity >= args.userMatchThreshold
            } else if let userSpeakerId, seg.speakerId == userSpeakerId {
                isUser = true
            }
            var entry: [String: Any] = [
                "speaker_id": seg.speakerId,
                "is_user": isUser,
                "user_similarity": Double(similarity),
                "fluidaudio_label_is_user": userSpeakerId != nil && seg.speakerId == userSpeakerId,
                "start_ms": Int((seg.startTimeSeconds * 1000).rounded()),
                "end_ms": Int((seg.endTimeSeconds * 1000).rounded()),
                "duration_ms": Int((seg.durationSeconds * 1000).rounded()),
                "quality_score": Double(seg.qualityScore),
            ]
            if args.includeEmbeddings {
                entry["embedding"] = seg.embedding.map { Double($0) }
            }
            segmentsJson.append(entry)
        }

        let payload: [String: Any] = [
            "schema": 2,
            "input_path": args.input,
            "user_speaker_id": userSpeakerId ?? "",
            "clustering_threshold": Double(args.clusteringThreshold),
            "user_match_threshold": Double(args.userMatchThreshold),
            "speakers_seen": Array(seenSpeakers).sorted(),
            "speaker_count": seenSpeakers.count,
            "segments": segmentsJson,
        ]

        let data = try JSONSerialization.data(
            withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]
        )
        try data.write(to: URL(fileURLWithPath: args.output))
        eprint(
            "✅ wrote \(seenSpeakers.count) speakers, \(result.segments.count) segments → \(args.output)"
        )
        print(args.output)
    }
}
