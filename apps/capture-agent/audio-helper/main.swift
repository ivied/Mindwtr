// gtd-audio-capture
//
// Capture mic via AVAudioEngine. We call setVoiceProcessingEnabled(true)
// PURELY for its side effect of switching the input bus into the device's
// native multi-channel raw mode (MBP built-in mic = 7-9 beam-forming
// taps). We do NOT attach the silent-player → mainMixer → output
// scaffolding that VPIO uses for echo cancellation — that's what grabs
// the system output device and makes macOS duck Zoom/notifications.
//
// What we lose: Apple's hardware AGC. Compensated by software gain.
// What we keep: multi-channel raw, downmixed to mono manually = crude
// beam-form-like aggregation that's still much cleaner than ffmpeg's
// single-channel raw avfoundation pull.
//
// Output: 16 kHz / mono / Int16 little-endian PCM to stdout.

import AVFoundation
import Darwin

// ---------- args ----------
var duration: Double = 30.0
var gain: Float = 10.0
var enableVP = true
let args = CommandLine.arguments
var argIdx = 1
while argIdx < args.count {
    switch args[argIdx] {
    case "--duration":
        if argIdx + 1 < args.count, let d = Double(args[argIdx + 1]) { duration = d }
        argIdx += 2
    case "--gain":
        if argIdx + 1 < args.count, let g = Float(args[argIdx + 1]) { gain = g }
        argIdx += 2
    case "--no-vp":
        enableVP = false
        argIdx += 1
    case "--help", "-h":
        print("Usage: gtd-audio-capture --duration <seconds> [--gain <multiplier>] [--no-vp]")
        exit(0)
    default:
        argIdx += 1
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
        try input.setVoiceProcessingEnabled(true)
    } catch {
        eprint("warning: setVoiceProcessingEnabled failed: \(error.localizedDescription)")
    }
}
eprint("input format: \(input.outputFormat(forBus: 0)), gain=\(gain), vp=\(enableVP)")

guard
    let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true
    )
else {
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

    // Manual downmix N → 1 with software gain applied. Clip to ±1.0
    // before downstream Int16 conversion to avoid wrap-around distortion.
    let invChans = 1.0 / Float(nChans)
    var monoSamples = [Float](repeating: 0, count: nFrames)
    for i in 0..<nFrames {
        var s: Float = 0
        for ch in 0..<nChans {
            s += channels[ch][i]
        }
        let v = (s * invChans) * gain
        monoSamples[i] = max(-1.0, min(1.0, v))
    }

    if monoSourceFormat == nil {
        monoSourceFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: bufFormat.sampleRate, channels: 1,
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
            pcmFormat: monoSourceFormat!, frameCapacity: AVAudioFrameCount(nFrames)
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
writeQueue.sync { }
