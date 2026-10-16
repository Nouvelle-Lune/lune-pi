import AppKit
import AVFoundation
import CoreGraphics
import ScreenCaptureKit

enum CaptureError: Error {
    case usage
    case screenRecordingPermission
    case windowNotFound(String)
}

@available(macOS 15.0, *)
final class RecordingDelegate: NSObject, SCRecordingOutputDelegate {
    let completion = AsyncThrowingStream<Void, Error>.makeStream()

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        print("RECORDING")
        fflush(stdout)
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        completion.continuation.finish()
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        completion.continuation.finish(throwing: error)
    }
}

@main
struct Capture {
    @available(macOS 15.0, *)
    @MainActor static func main() async {
        do { try await run() }
        catch {
            FileHandle.standardError.write(Data("capture: \(error)\n".utf8))
            exit(1)
        }
    }

    @available(macOS 15.0, *)
    @MainActor static func run() async throws {
        _ = NSApplication.shared
        NSApplication.shared.setActivationPolicy(.prohibited)
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count >= 2 else { throw CaptureError.usage }
        guard CGPreflightScreenCaptureAccess() else { throw CaptureError.screenRecordingPermission }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        if args[0] == "window" {
            guard let pid = Int32(args[1]), let window = content.windows.filter({
                $0.owningApplication?.processID == pid && $0.owningApplication?.bundleIdentifier == "com.mitchellh.ghostty" && $0.isOnScreen
            }).max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
                throw CaptureError.windowNotFound(args[1])
            }
            let details: [String: Any] = ["id": window.windowID, "width": window.frame.width, "height": window.frame.height, "pid": window.owningApplication!.processID]
            print(String(decoding: try JSONSerialization.data(withJSONObject: details), as: UTF8.self))
            return
        }
        guard args.count == 3, let id = UInt32(args[1]), let window = content.windows.first(where: { $0.windowID == id }) else {
            throw CaptureError.windowNotFound(args[1])
        }
        // The filter captures this one app window even if another window overlaps it.
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.width = Int(window.frame.width * 2)
        configuration.height = Int(window.frame.height * 2)
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.ignoreShadowsSingleWindow = true
        configuration.shouldBeOpaque = true
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
        let output = URL(fileURLWithPath: args[2])
        switch args[0] {
        case "record":
            let delegate = RecordingDelegate()
            let settings = SCRecordingOutputConfiguration()
            settings.outputURL = output
            settings.videoCodecType = .h264
            settings.outputFileType = .mp4
            let recording = SCRecordingOutput(configuration: settings, delegate: delegate)
            let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
            try stream.addRecordingOutput(recording)
            try await stream.startCapture()
            // The orchestrator closes stdin only after all keyboard actions and captures finish.
            _ = await Task.detached { FileHandle.standardInput.readDataToEndOfFile() }.value
            try await stream.stopCapture()
            for try await _ in delegate.completion.stream {}
            print("RECORDED")
        default:
            throw CaptureError.usage
        }
    }
}
