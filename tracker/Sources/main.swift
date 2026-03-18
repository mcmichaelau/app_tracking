import Foundation
import Cocoa

// Permissions — open System Settings and exit if not granted
if !AXIsProcessTrusted() {
    print("[tracker] Accessibility permission required.")
    print("[tracker] Opening System Settings → Privacy & Security → Accessibility.")
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
    AXIsProcessTrustedWithOptions(options as CFDictionary)
    print("[tracker] Grant access, then re-launch.")
    exit(1)
}

print("[tracker] Starting")

Tracker.shared.start()

// Graceful shutdown on SIGTERM / SIGINT
for sig in [SIGTERM, SIGINT] {
    signal(sig) { _ in
        Tracker.shared.stop()
        exit(0)
    }
}

CFRunLoopRun()
