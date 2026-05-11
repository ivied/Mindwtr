// gtd-audio-capture
//
// Capture microphone audio through AVAudioEngine and emit 16 kHz / mono /
// Int16 little-endian PCM to stdout. The bun recorder wraps it in a WAV
// header and ships to Whisper.
//
// Why not ffmpeg? Raw ffmpeg → avfoundation grabs a single channel of the
// MacBook's multi-mic array (typically 7-9 channels with beam-forming) and
// produces noisy unusable audio. AVAudioEngine here:
//   1. Pulls all channels (deinterleaved Float32).
//   2. Manually averages them to mono — a simple beam-forming-lite that
//      already cleans up MBP mic noticeably.
//   3. Resamples to 16 kHz mono Int16 via AVAudioConverter (1ch→1ch only;
//      the converter silently zeroes out when asked to reduce channels
//      from a deinterleaved multi-channel source).
//
// We also enable AVAudio's VoiceProcessingIO (Apple's neural noise
// suppression / AGC / echo cancellation). VP only fully engages on signed
// binaries with the audio-input entitlement — without that, macOS reports
// it as "enabled" but the input still arrives raw multi-channel. The
// manual downmix above already gives us a usable signal regardless; if we
// later codesign the binary, VP turns on transparently.
//
// Usage:
//   gtd-audio-capture --duration 30.0 [--no-vp]

import AVFoundation
import Darwin

// ---------- args ----------
var duration: Double = 30.0
var enableVP = true
let args = CommandLine.arguments
var i = 1
while i < args.count {
    switch args[i] {
    case "--duration":
        if i + 1 < args.count, let d = Double(args[i + 1]) { duration = d }
        i += 2
    case "--no-vp":
        enableVP = false
        i += 1
    case "--help", "-h":
        print("Usage: gtd-audio-capture --duration <seconds> [--no-vp]")
        exit(0)
    default:
        i += 1
    }
}

func eprint(_ s: String) {
    if let data = (s + "\n").data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

// ---------- engine ----------
let engine = AVAudioEngine()
let input = engine.inputNode

if enableVP {
    do {
        // VPIO needs a complete graph (something feeding the output node)
        // before start() will succeed. Attach a silent player → mainMixer
        // → output route purely as scaffolding; speakers stay quiet.
        let silentPlayer = AVAudioPlayerNode()
        engine.attach(silentPlayer)
        let outFormat = engine.outputNode.inputFormat(forBus: 0)
        engine.connect(silentPlayer, to: engine.mainMixerNode, format: outFormat)
        engine.mainMixerNode.outputVolume = 0
        try input.setVoiceProcessingEnabled(true)
    } catch {
        eprint("warning: setVoiceProcessingEnabled failed: \(error.localizedDescription)")
    }
}

guard let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: 16_000,
    channels: 1,
    interleaved: true
) else {
    eprint("error: failed to create target format")
    exit(1)
}

let stdoutHandle = FileHandle.standardOutput
let writeQueue = DispatchQueue(label: "stdout-writer")

var converter: AVAudioConverter?
var monoSourceFormat: AVAudioFormat?

// ---------- tap ----------
input.installTap(onBus: 0, bufferSize: 4_096, format: nil) { buffer, _ in
    let bufFormat = buffer.format
    let nFrames = Int(buffer.frameLength)
    let nChans = Int(bufFormat.channelCount)
    guard nFrames > 0, let channels = buffer.floatChannelData else { return }

    // Manual downmix to mono Float32. AVAudioConverter on macOS produces
    // silence when reducing channels from a deinterleaved multi-channel
    // mic, so we average channels ourselves.
    var monoSamples = [Float](repeating: 0, count: nFrames)
    let invChans = 1.0 / Float(nChans)
    for i in 0..<nFrames {
        var s: Float = 0
        for ch in 0..<nChans {
            s += channels[ch][i]
        }
        monoSamples[i] = s * invChans
    }

    if monoSourceFormat == nil {
        monoSourceFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: bufFormat.sampleRate,
            channels: 1,
            interleaved: false
        )
        converter = AVAudioConverter(from: monoSourceFormat!, to: targetFormat)
        if converter == nil {
            eprint("error: converter init failed")
            return
        }
    }

    guard
        let inMono = AVAudioPCMBuffer(
            pcmFormat: monoSourceFormat!,
            frameCapacity: AVAudioFrameCount(nFrames)
        )
    else { return }
    inMono.frameLength = AVAudioFrameCount(nFrames)
    if let dst = inMono.floatChannelData?[0] {
        monoSamples.withUnsafeBufferPointer { src in
            dst.update(from: src.baseAddress!, count: nFrames)
        }
    }

    let ratio = targetFormat.sampleRate / bufFormat.sampleRate
    let capacity = AVAudioFrameCount((Double(nFrames) * ratio).rounded(.up)) + 64
    guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
        return
    }
    var error: NSError?
    var provided = false
    let status = converter!.convert(to: outBuffer, error: &error) { _, outStatus in
        if provided {
            outStatus.pointee = .noDataNow
            return nil
        }
        provided = true
        outStatus.pointee = .haveData
        return inMono
    }
    if status == .error {
        eprint("convert error: \(error?.localizedDescription ?? "unknown")")
        return
    }
    guard let chan = outBuffer.int16ChannelData?[0], outBuffer.frameLength > 0 else { return }
    let byteCount = Int(outBuffer.frameLength) * 2
    let data = Data(bytes: chan, count: byteCount)
    writeQueue.async {
        stdoutHandle.write(data)
    }
}

// ---------- run ----------
do {
    try engine.start()
} catch {
    eprint("error: engine.start() failed: \(error.localizedDescription)")
    exit(2)
}

var stopRequested = false
signal(SIGINT) { _ in stopRequested = true }
signal(SIGTERM) { _ in stopRequested = true }

let deadline = Date().addingTimeInterval(duration)
while Date() < deadline && !stopRequested {
    Thread.sleep(forTimeInterval: 0.05)
}

engine.stop()
input.removeTap(onBus: 0)

// Drain any pending stdout writes before exit.
writeQueue.sync { }
