import Cocoa
import Foundation
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow!
  private var webView: WKWebView!
  private var serverProcess: Process?
  private var servicesStarted = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    setupWindow()
    if ensureAccessibilityPermission() {
      startServicesIfNeeded()
    } else {
      promptForAccessibilityPermission()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    serverProcess?.terminate()
  }

  private func setupWindow() {
    let rect = NSRect(x: 0, y: 0, width: 1280, height: 860)
    window = NSWindow(
      contentRect: rect,
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.center()
    window.title = "Panoptic"

    let config = WKWebViewConfiguration()
    webView = WKWebView(frame: rect, configuration: config)
    window.contentView = webView
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func ensureAccessibilityPermission() -> Bool {
    if AXIsProcessTrusted() { return true }
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
    _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
    return false
  }

  private func startServicesIfNeeded() {
    guard !servicesStarted else { return }
    servicesStarted = true
    launchServer()
    Task { await waitForServerAndLoadUI() }
  }

  private func openAccessibilitySettings() {
    let deepLink = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    let fallback = URL(string: "x-apple.systempreferences:com.apple.preference.security")
    if let url = deepLink, NSWorkspace.shared.open(url) { return }
    if let url = fallback { _ = NSWorkspace.shared.open(url) }
  }

  private func promptForAccessibilityPermission() {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Accessibility permission required"
    alert.informativeText = "Enable Panoptic in System Settings > Privacy & Security > Accessibility, then click \"I've Enabled It\"."
    alert.addButton(withTitle: "Open Accessibility Settings")
    alert.addButton(withTitle: "I've Enabled It")
    alert.addButton(withTitle: "Quit")

    switch alert.runModal() {
    case .alertFirstButtonReturn:
      openAccessibilitySettings()
      DispatchQueue.main.async { [weak self] in self?.promptForAccessibilityPermission() }
    case .alertSecondButtonReturn:
      if ensureAccessibilityPermission() {
        startServicesIfNeeded()
      } else {
        DispatchQueue.main.async { [weak self] in self?.promptForAccessibilityPermission() }
      }
    default:
      NSApp.terminate(nil)
    }
  }

  private func launchServer() {
    guard
      let executableDir = Bundle.main.executableURL?.deletingLastPathComponent(),
      let resourcesDir = Bundle.main.resourceURL
    else {
      showFatalError("Could not resolve bundled paths.")
      return
    }

    let bunURL = executableDir.appendingPathComponent("bun")
    let appDir = resourcesDir.appendingPathComponent("bun-app")
    let bundledTrackerURL = executableDir.appendingPathComponent("ActivityTracker")
    let interpretationPromptURL = resourcesDir.appendingPathComponent("prompts/interpret_events.md")
    let classificationPromptURL = resourcesDir.appendingPathComponent("prompts/classify_task_v3a.md")

    let process = Process()
    process.executableURL = bunURL
    process.currentDirectoryURL = appDir
    process.arguments = ["run", "src/index.ts"]

    var env = ProcessInfo.processInfo.environment
    let existingPath = env["PATH"] ?? ""
    env["PATH"] = "\(executableDir.path):/usr/bin:/bin:/usr/sbin:/sbin:\(existingPath)"
    env["TRACKER_BINARY"] = bundledTrackerURL.path
    env["PROMPT_PATH"] = interpretationPromptURL.path
    env["TASK_CLASSIFIER_PROMPT_PATH"] = classificationPromptURL.path
    process.environment = env

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    pipe.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
      print("[embedded] \(line)", terminator: "")
    }

    process.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async {
        self?.showFatalError("Background server exited with code \(proc.terminationStatus).")
      }
    }

    do {
      try process.run()
      serverProcess = process
    } catch {
      showFatalError("Failed to start bundled server: \(error.localizedDescription)")
    }
  }

  private func waitForServerAndLoadUI() async {
    let url = URL(string: "http://localhost:3001")!
    for _ in 0..<120 {
      var req = URLRequest(url: url)
      req.timeoutInterval = 0.7
      do {
        _ = try await URLSession.shared.data(for: req)
        await MainActor.run {
          _ = webView.load(URLRequest(url: url))
        }
        return
      } catch {
        try? await Task.sleep(nanoseconds: 250_000_000)
      }
    }

    await MainActor.run {
      showFatalError("Timed out waiting for local server.")
    }
  }

  private func showFatalError(_ message: String) {
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = "Panoptic failed to launch"
    alert.informativeText = message
    alert.runModal()
    NSApp.terminate(nil)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
