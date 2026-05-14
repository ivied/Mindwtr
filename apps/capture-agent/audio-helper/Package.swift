// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "gtd-audio-helper",
    platforms: [
        .macOS(.v14)
    ],
    dependencies: [
        // Speaker diarization + embeddings (CoreML, ANE-optimized).
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.12.4"),
    ],
    targets: [
        // AVCaptureSession-based mic capture → 16 kHz Int16 PCM on stdout.
        // No FluidAudio dependency — stays small + dependency-free.
        .executableTarget(
            name: "gtd-audio-capture",
            path: "Sources/gtd-audio-capture"
        ),
        // One-time enrollment: WAV in → 256-d voice embedding JSON out.
        .executableTarget(
            name: "gtd-audio-enroll",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ],
            path: "Sources/gtd-audio-enroll"
        ),
        // Per-chunk diarization: WAV + enrollment profile → JSON of
        // segments labelled with user/other speaker IDs.
        .executableTarget(
            name: "gtd-audio-diarize",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ],
            path: "Sources/gtd-audio-diarize"
        ),
    ]
)
