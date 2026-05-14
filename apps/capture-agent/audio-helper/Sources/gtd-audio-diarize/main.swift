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

func parseArgs() -> (input: String, output: String, profile: String?) {
    var input: String?
    var output: String?
    var profile: String?
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        switch args[i] {
        case "--input":
            if i + 1 < args.count { input = args[i + 1] }
            i += 2
        case "--output":
            if i + 1 < args.count { output = args[i + 1] }
            i += 2
        case "--profile":
            if i + 1 < args.count { profile = args[i + 1] }
            i += 2
        case "--help", "-h":
            print(
                "Usage: gtd-audio-diarize --input <wav> --output <json> [--profile <profile.json>]"
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
    return (input, output, profile)
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
        let (inputPath, outputPath, profilePath) = parseArgs()
        let samples = try readWavAsMono16kFloat(path: inputPath)
        eprint("samples: \(samples.count) (\(Double(samples.count) / 16_000) s)")

        let models = try await DiarizerModels.downloadIfNeeded()
        let manager = DiarizerManager()
        manager.initialize(models: models)

        var userSpeakerId: String?
        if let profilePath {
            let profile = try loadProfile(path: profilePath)
            let userSpeaker = Speaker(
                id: "user",
                name: profile.name,
                currentEmbedding: profile.embedding,
                duration: Float(profile.duration_s ?? 0),
                isPermanent: true
            )
            await manager.initializeKnownSpeakers([userSpeaker])
            userSpeakerId = userSpeaker.id
            eprint("known user speaker registered: id=\(userSpeaker.id) name=\(profile.name)")
        }

        let result = try await manager.performCompleteDiarization(samples, sampleRate: 16_000)
        eprint("segments: \(result.segments.count)")

        var seenSpeakers = Set<String>()
        var segmentsJson: [[String: Any]] = []
        for seg in result.segments {
            seenSpeakers.insert(seg.speakerId)
            segmentsJson.append([
                "speaker_id": seg.speakerId,
                "is_user": userSpeakerId != nil && seg.speakerId == userSpeakerId,
                "start_ms": Int((seg.startTimeSeconds * 1000).rounded()),
                "end_ms": Int((seg.endTimeSeconds * 1000).rounded()),
                "duration_ms": Int((seg.durationSeconds * 1000).rounded()),
                "quality_score": Double(seg.qualityScore),
            ])
        }

        let payload: [String: Any] = [
            "schema": 1,
            "input_path": inputPath,
            "user_speaker_id": userSpeakerId ?? "",
            "speakers_seen": Array(seenSpeakers).sorted(),
            "speaker_count": seenSpeakers.count,
            "segments": segmentsJson,
        ]

        let data = try JSONSerialization.data(
            withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]
        )
        try data.write(to: URL(fileURLWithPath: outputPath))
        eprint(
            "✅ wrote \(seenSpeakers.count) speakers, \(result.segments.count) segments → \(outputPath)"
        )
        print(outputPath)
    }
}
