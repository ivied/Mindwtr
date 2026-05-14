// gtd-audio-enroll
//
// One-time voice enrollment for the GTD capture agent. Reads a WAV file
// of the user speaking, runs it through FluidAudio's speaker embedder,
// and writes a 256-d voice profile to JSON. The profile is later loaded
// by gtd-audio-diarize so we can identify which segments of an arbitrary
// audio capture belong to this enrolled speaker.
//
// Usage:
//   gtd-audio-enroll --input enroll.wav --output profile.json [--name "Sergey"]

import AVFoundation
import FluidAudio
import Foundation

func eprint(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8) ?? Data())
}

func parseArgs() -> (input: String, output: String, name: String) {
    var input: String?
    var output: String?
    var name = "user"
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
        case "--name":
            if i + 1 < args.count { name = args[i + 1] }
            i += 2
        case "--help", "-h":
            print("Usage: gtd-audio-enroll --input <wav> --output <json> [--name <speaker>]")
            exit(0)
        default:
            i += 1
        }
    }
    guard let input, let output else {
        eprint("error: --input and --output required")
        exit(1)
    }
    return (input, output, name)
}

func readWavAsMono16kFloat(path: String) throws -> [Float] {
    let url = URL(fileURLWithPath: path)
    let file = try AVAudioFile(forReading: url)
    let inFormat = file.processingFormat
    eprint(
        "input: \(inFormat.channelCount) ch @ \(inFormat.sampleRate) Hz, \(file.length) frames"
    )

    guard
        let target = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false
        )
    else {
        throw NSError(domain: "enroll", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad target format"])
    }
    guard let converter = AVAudioConverter(from: inFormat, to: target) else {
        throw NSError(
            domain: "enroll", code: 2, userInfo: [NSLocalizedDescriptionKey: "no converter"]
        )
    }

    let inBuffer = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(file.length))
    guard let inBuffer else {
        throw NSError(
            domain: "enroll", code: 3, userInfo: [NSLocalizedDescriptionKey: "alloc inBuffer failed"]
        )
    }
    try file.read(into: inBuffer)

    let ratio = target.sampleRate / inFormat.sampleRate
    let outCapacity = AVAudioFrameCount(Double(inBuffer.frameLength) * ratio * 1.1) + 1024
    guard let outBuffer = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: outCapacity) else {
        throw NSError(
            domain: "enroll", code: 4, userInfo: [NSLocalizedDescriptionKey: "alloc outBuffer failed"]
        )
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
    if status == .error {
        throw error
            ?? NSError(
                domain: "enroll", code: 5,
                userInfo: [NSLocalizedDescriptionKey: "convert failed"]
            )
    }

    let n = Int(outBuffer.frameLength)
    guard let p = outBuffer.floatChannelData?[0] else { return [] }
    return Array(UnsafeBufferPointer(start: p, count: n))
}

@main
struct Enroll {
    static func main() async throws {
        let (inputPath, outputPath, name) = parseArgs()

        let samples = try readWavAsMono16kFloat(path: inputPath)
        eprint("samples: \(samples.count) (\(Double(samples.count) / 16_000) s mono 16 kHz)")
        guard samples.count >= 16_000 else {
            eprint("error: need at least 1 s of audio; got \(samples.count) samples")
            exit(2)
        }

        eprint("downloading models (one-time, ~150 MB)…")
        let models = try await DiarizerModels.downloadIfNeeded()
        let manager = DiarizerManager()
        manager.initialize(models: models)

        eprint("extracting speaker embedding…")
        let embedding = try manager.extractSpeakerEmbedding(from: samples)
        eprint("embedding: \(embedding.count) dims")

        guard !embedding.isEmpty, embedding.contains(where: { $0 != 0 }) else {
            eprint("error: extracted embedding is empty/zero — enrollment audio likely silent")
            exit(3)
        }

        let profile: [String: Any] = [
            "schema": 1,
            "name": name,
            "embedding": embedding,
            "duration_s": Double(samples.count) / 16_000.0,
            "created_at": ISO8601DateFormatter().string(from: Date()),
        ]
        let data = try JSONSerialization.data(
            withJSONObject: profile, options: [.prettyPrinted, .sortedKeys]
        )
        try data.write(to: URL(fileURLWithPath: outputPath))
        eprint("✅ profile written to \(outputPath)")
        print(outputPath)
    }
}
