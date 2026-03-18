import Cocoa
import CoreGraphics

func eventCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    let state = TrackerState.shared
    debugLog("eventCallback fired: type=\(type.rawValue)")

    if type == .keyDown {
        if handleKeyDown(event) {
            return nil
        }
        return Unmanaged.passUnretained(event)
    }

    guard type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown else {
        return Unmanaged.passUnretained(event)
    }

    flushTypingBuffer()

    let targetPID = event.getIntegerValueField(.eventTargetUnixProcessID)
    if let targetApp = NSRunningApplication(processIdentifier: pid_t(targetPID)),
       let targetName = targetApp.localizedName,
       targetName != state.currentApp {
        state.currentApp = targetName
        log("APP SWITCH", targetName)
        return Unmanaged.passUnretained(event)
    }

    let location = event.location

    if let clickData = getClickData(at: location) {
        logClick(clickData)
    }

    return Unmanaged.passUnretained(event)
}
