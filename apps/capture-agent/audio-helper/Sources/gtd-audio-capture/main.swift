// gtd-audio-capture
//
// Capture mic via AVCaptureSession (the framework used by camera apps,
// also works for audio). Unlike AVAudioEngine + VPIO, AVCaptureSession
// does NOT register us as a voice-chat session consumer, so it coexists
// with Zoom / Google Meet / Teams without any ducking or interference.
//
// We also set `preferredMicrophoneMode = .voiceIsolation` on the device,
// which asks macOS to apply system-level voice isolation (neural denoise,
// AGC) to OUR audio stream specifically — without grabbing the exclusive
// VPIO session that other apps need.
//
// Pattern lifted from ambient-voice
// (https://github.com/Marvinngg/ambient-voice), which uses the same
// approach for continuous background capture alongside meeting apps.
//
// Output: 16 kHz / mono / Int16 little-endian PCM to stdout.

import AVFoundation
import Darwin

// ---------- args ----------
var duration: Double = 30.0
var requestVoiceIsolation = true
// When set, write a self-contained WAV file at this path instead of streaming
// raw PCM to stdout. Needed when invoked via `open -W -a` (LaunchServices
// route): `open` does not pipe stdout, so the bun-side recorder reads back
// the WAV from disk after `open` returns. Stdout PCM is kept as fallback
// for direct-exec contexts (Terminal smoke tests).
var outputPath: String? = nil
let args = CommandLine.arguments
var argIdx = 1
while argIdx < args.count {
    switch args[argIdx] {
    case "--duration":
        if argIdx + 1 < args.count, let d = Double(args[argIdx + 1]) { duration = d }
        argIdx += 2
    case "--no-voice-isolation", "--no-vp":
        requestVoiceIsolation = false
        argIdx += 1
    case "--output":
        if argIdx + 1 < args.count { outputPath = args[argIdx + 1] }
        argIdx += 2
    case "--help", "-h":
        print(
            "Usage: gtd-audio-capture --duration <seconds> [--no-voice-isolation] [--output <path.wav>]"
        )
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

// ---------- locate device ----------
guard let device = AVCaptureDevice.default(for: .audio) else {
    eprint("error: no default audio capture device")
    exit(1)
}
eprint("device: \(device.localizedName)")

// `preferredMicrophoneMode` is get-only — macOS only lets the USER
// change the mic mode via Control Center → Microphone. We just log what
// the user currently has set so we can see whether voice isolation is
// in effect at runtime. AVCaptureSession itself already avoids the
// VPIO-session contention that breaks Zoom coexistence.
eprint("microphone mode (user-chosen): \(AVCaptureDevice.preferredMicrophoneMode)")

// ---------- target format ----------
guard
    let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true
    )
else {
    eprint("error: failed to create target format")
    exit(1)
}

// ---------- delegate ----------
final class StdoutCaptureDelegate: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    let targetFormat: AVAudioFormat
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?
    let stdoutHandle = FileHandle.standardOutput
    let writeQueue = DispatchQueue(label: "stdout-writer")
    // File sink (set when --output is passed). Writes a real WAV file
    // with a 44-byte header so consumers don't need to wrap it. The
    // header's data-size field is patched on close.
    var fileHandle: FileHandle? = nil
    var fileDataBytes: UInt32 = 0

    init(targetFormat: AVAudioFormat) {
        self.targetFormat = targetFormat
    }

    func openFileSink(at path: String) throws {
        FileManager.default.createFile(atPath: path, contents: nil)
        let h = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        // 44-byte placeholder header — patched in finishFileSink.
        h.write(Data(count: 44))
        fileHandle = h
        fileDataBytes = 0
    }

    func finishFileSink() {
        guard let h = fileHandle else { return }
        // Build a canonical WAV header for 16 kHz mono Int16.
        let sampleRate: UInt32 = 16_000
        let channels: UInt16 = 1
        let bits: UInt16 = 16
        let byteRate: UInt32 = sampleRate * UInt32(channels) * UInt32(bits) / 8
        let blockAlign: UInt16 = channels * bits / 8
        var header = Data()
        header.append("RIFF".data(using: .ascii)!)
        var fileSize: UInt32 = 36 + fileDataBytes
        withUnsafeBytes(of: &fileSize) { header.append(contentsOf: $0) }
        header.append("WAVE".data(using: .ascii)!)
        header.append("fmt ".data(using: .ascii)!)
        var fmtChunk: UInt32 = 16
        withUnsafeBytes(of: &fmtChunk) { header.append(contentsOf: $0) }
        var fmtTag: UInt16 = 1  // PCM
        withUnsafeBytes(of: &fmtTag) { header.append(contentsOf: $0) }
        var ch = channels
        withUnsafeBytes(of: &ch) { header.append(contentsOf: $0) }
        var sr = sampleRate
        withUnsafeBytes(of: &sr) { header.append(contentsOf: $0) }
        var br = byteRate
        withUnsafeBytes(of: &br) { header.append(contentsOf: $0) }
        var ba = blockAlign
        withUnsafeBytes(of: &ba) { header.append(contentsOf: $0) }
        var bps = bits
        withUnsafeBytes(of: &bps) { header.append(contentsOf: $0) }
        header.append("data".data(using: .ascii)!)
        var dataSize = fileDataBytes
        withUnsafeBytes(of: &dataSize) { header.append(contentsOf: $0) }
        try? h.seek(toOffset: 0)
        h.write(header)
        try? h.close()
        fileHandle = nil
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let pcm = pcmBuffer(from: sampleBuffer) else { return }
        let converted = convert(pcm) ?? pcm
        emit(converted)
    }

    private func pcmBuffer(from sb: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard
            let fmtDesc = CMSampleBufferGetFormatDescription(sb),
            let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc)?.pointee
        else { return nil }
        var asbdCopy = asbd
        guard let avFormat = AVAudioFormat(streamDescription: &asbdCopy) else { return nil }
        let nFrames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sb))
        guard
            let buf = AVAudioPCMBuffer(pcmFormat: avFormat, frameCapacity: nFrames)
        else { return nil }
        buf.frameLength = nFrames

        var blockBuffer: CMBlockBuffer?
        var audioBufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(mNumberChannels: avFormat.channelCount, mDataByteSize: 0, mData: nil)
        )
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        guard status == noErr,
              let src = audioBufferList.mBuffers.mData
        else { return nil }
        let byteCount = Int(audioBufferList.mBuffers.mDataByteSize)
        memcpy(buf.audioBufferList.pointee.mBuffers.mData, src, byteCount)
        return buf
    }

    private func convert(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        if input.format == targetFormat { return input }
        if converter == nil || sourceFormat != input.format {
            converter = AVAudioConverter(from: input.format, to: targetFormat)
            sourceFormat = input.format
            if converter == nil {
                eprint("converter init failed: \(input.format) → \(targetFormat)")
                return nil
            }
        }
        let ratio = targetFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up)) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity)
        else { return nil }
        var error: NSError?
        var provided = false
        let status = converter!.convert(to: out, error: &error) { _, outStatus in
            if provided { outStatus.pointee = .noDataNow; return nil }
            provided = true
            outStatus.pointee = .haveData
            return input
        }
        if status == .error {
            eprint("convert error: \(error?.localizedDescription ?? "unknown")")
            return nil
        }
        return out
    }

    private func emit(_ buf: AVAudioPCMBuffer) {
        guard let chan = buf.int16ChannelData?[0], buf.frameLength > 0 else { return }
        let byteCount = Int(buf.frameLength) * 2
        let data = Data(bytes: chan, count: byteCount)
        if let h = fileHandle {
            writeQueue.async { [weak self] in
                h.write(data)
                self?.fileDataBytes &+= UInt32(byteCount)
            }
        } else {
            writeQueue.async { [stdoutHandle] in
                stdoutHandle.write(data)
            }
        }
    }
}

let delegate = StdoutCaptureDelegate(targetFormat: targetFormat)
if let p = outputPath {
    do {
        try delegate.openFileSink(at: p)
        eprint("output: \(p)")
    } catch {
        eprint("error: cannot open --output \(p): \(error.localizedDescription)")
        exit(1)
    }
}

// ---------- session ----------
let session = AVCaptureSession()
do {
    let deviceInput = try AVCaptureDeviceInput(device: device)
    if session.canAddInput(deviceInput) {
        session.addInput(deviceInput)
    } else {
        eprint("error: cannot add audio input")
        exit(1)
    }
} catch {
    eprint("error: AVCaptureDeviceInput failed: \(error.localizedDescription)")
    exit(1)
}

let audioOutput = AVCaptureAudioDataOutput()
let captureQueue = DispatchQueue(label: "audio-capture")
audioOutput.setSampleBufferDelegate(delegate, queue: captureQueue)
if session.canAddOutput(audioOutput) {
    session.addOutput(audioOutput)
} else {
    eprint("error: cannot add audio output")
    exit(1)
}

session.startRunning()

var stopRequested = false
signal(SIGINT) { _ in stopRequested = true }
signal(SIGTERM) { _ in stopRequested = true }

let deadline = Date().addingTimeInterval(duration)
while Date() < deadline && !stopRequested {
    Thread.sleep(forTimeInterval: 0.05)
}

session.stopRunning()
delegate.writeQueue.sync { }
delegate.finishFileSink()
