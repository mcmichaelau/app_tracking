import Cocoa

public class AppObserver: NSObject {
    public override init() {
        super.init()
    }

    public func start() {
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(appDidActivate),
            name: NSWorkspace.didActivateApplicationNotification,
            object: nil
        )
        if let app = NSWorkspace.shared.frontmostApplication {
            TrackerState.shared.currentApp = app.localizedName ?? "Unknown"
        }
    }

    public func stop() {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    @objc func appDidActivate(_ notification: Notification) {
        guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
              let name = app.localizedName else { return }
        flushTypingBuffer()
        TrackerState.shared.currentApp = name
        log("APP SWITCH", name)
    }
}
