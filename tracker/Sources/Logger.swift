import Foundation

// MARK: - Formatting

func timestamp() -> String {
    DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
}

func isoTimestamp() -> String {
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fmt.string(from: Date())
}

// MARK: - Log helpers

func log(_ event: String, _ detail: String) {
    let app = TrackerState.shared.currentApp
    print("\(timestamp()) | \(app.padding(toLength: 20, withPad: " ", startingAt: 0)) | \(event.padding(toLength: 12, withPad: " ", startingAt: 0)) | \(detail)")

    EventPoster.shared.enqueue(TrackerEvent(
        timestamp: isoTimestamp(), app: app, event_type: event, detail: detail
    ))
}

func logClick(_ clickData: ClickData) {
    let app = TrackerState.shared.currentApp
    let displayString = clickData.toDisplayString()
    let jsonData = clickData.toJSON()

    print("\(timestamp()) | \(app.padding(toLength: 20, withPad: " ", startingAt: 0)) | \("CLICK".padding(toLength: 12, withPad: " ", startingAt: 0)) | \(displayString)")

    EventPoster.shared.enqueue(TrackerEvent(
        timestamp: isoTimestamp(), app: app, event_type: "CLICK", detail: jsonData
    ))
}

// MARK: - HTTP poster with retry buffer

class EventPoster {
    static let shared = EventPoster()

    private let buffer = EventBuffer()
    private var retryTimer: Timer?
    private let bunURL = URL(string: "http://127.0.0.1:3001/api/events")!

    private let session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 2
        cfg.timeoutIntervalForResource = 2
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    private init() {}

    func enqueue(_ event: TrackerEvent) {
        buffer.enqueue(event)
        post()
    }

    private func post() {
        let events = buffer.flush()
        guard !events.isEmpty else { return }

        guard let body = try? JSONEncoder().encode(events) else {
            events.forEach { buffer.enqueue($0) }
            return
        }

        var req = URLRequest(url: bunURL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body

        session.dataTask(with: req) { [weak self] _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            if !ok {
                events.forEach { self?.buffer.enqueue($0) }
                self?.scheduleRetry()
            }
        }.resume()
    }

    private func scheduleRetry() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.retryTimer == nil else { return }
            self.retryTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self] _ in
                self?.retryTimer = nil
                self?.post()
            }
        }
    }
}
