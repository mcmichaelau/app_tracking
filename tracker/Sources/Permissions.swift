import Cocoa
import CoreGraphics

public struct PermissionStatus {
    public var accessibility: Bool
    public var inputMonitoring: Bool
    
    public var allGranted: Bool {
        accessibility && inputMonitoring
    }
}

public func checkPermissions() -> PermissionStatus {
    return PermissionStatus(
        accessibility: AXIsProcessTrusted(),
        inputMonitoring: CGPreflightListenEventAccess()
    )
}

public func requestAccessibility() {
    let options = [kAXTrustedCheckOptionPrompt.takeRetainedValue(): true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
}

public func requestInputMonitoring() {
    _ = CGRequestListenEventAccess()
}

public func openAccessibilitySettings() {
    let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
    NSWorkspace.shared.open(url)
}

public func openInputMonitoringSettings() {
    let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")!
    NSWorkspace.shared.open(url)
}
