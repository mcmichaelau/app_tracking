import Cocoa
import CoreGraphics

// Write debug messages to ~/Library/Logs/ActivityTracker.log
public func debugLog(_ message: String) {
    let logPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/ActivityTracker.log").path
    let line = "\(Date()) \(message)\n"
    if let data = line.data(using: .utf8) {
        if FileManager.default.fileExists(atPath: logPath) {
            if let handle = FileHandle(forWritingAtPath: logPath) {
                handle.seekToEndOfFile()
                handle.write(data)
                handle.closeFile()
            }
        } else {
            try? data.write(to: URL(fileURLWithPath: logPath))
        }
    }
}

public class Tracker {
    public static let shared = Tracker()
    
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var appObserver: AppObserver?
    
    private init() {}
    
    public func start() {
        guard !TrackerState.shared.isRunning else {
            debugLog("start() called but already running")
            return
        }
        
        debugLog("start() called")
        debugLog("Input Monitoring trusted: \(CGPreflightListenEventAccess())")
        debugLog("Accessibility trusted: \(AXIsProcessTrusted())")
        
        appObserver = AppObserver()
        appObserver?.start()
        
        let eventMask: CGEventMask = (
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.rightMouseDown.rawValue) |
            (1 << CGEventType.otherMouseDown.rawValue) |
            (1 << CGEventType.keyDown.rawValue)
        )
        
        debugLog("Creating event tap...")
        
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: eventMask,
            callback: eventCallback,
            userInfo: nil
        ) else {
            debugLog("ERROR: Failed to create event tap - Input Monitoring permission likely denied")
            return
        }
        
        debugLog("Event tap created successfully, tap enabled: \(CGEvent.tapIsEnabled(tap: tap))")
        
        eventTap = tap
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        
        debugLog("Event tap enabled: \(CGEvent.tapIsEnabled(tap: tap))")
        
        // Watch for tap being disabled by macOS and re-enable it
        startTapWatchdog(tap)
        
        TrackerState.shared.isRunning = true
    }
    
    private func startTapWatchdog(_ tap: CFMachPort) {
        DispatchQueue.global(qos: .background).async {
            while TrackerState.shared.isRunning {
                Thread.sleep(forTimeInterval: 0.5)
                if !CGEvent.tapIsEnabled(tap: tap) {
                    debugLog("Tap was disabled by macOS - re-enabling")
                    CGEvent.tapEnable(tap: tap, enable: true)
                }
            }
        }
    }
    
    
    public func stop() {
        guard TrackerState.shared.isRunning else { return }
        
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        
        if let source = runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        
        appObserver?.stop()
        appObserver = nil
        eventTap = nil
        runLoopSource = nil
        
        TrackerState.shared.isRunning = false
    }
    
    public var isRunning: Bool {
        TrackerState.shared.isRunning
    }
}
