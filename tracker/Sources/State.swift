import Foundation

// MARK: - Tracker state

class TrackerState {
    static let shared = TrackerState()

    var currentApp = "Unknown"
    var typingBuffer: [String] = []
    var typingFlushTimer: Timer?
    let typingTimeout: TimeInterval = 5.0
    var lastClickedElementBounds: CGRect?
    var isRunning = false

    private init() {}
}

// MARK: - Event model

struct TrackerEvent: Encodable {
    let timestamp: String
    let app: String
    let event_type: String
    let detail: String
}

// MARK: - In-memory retry buffer

class EventBuffer {
    private var queue: [TrackerEvent] = []
    private let maxSize = 200

    func enqueue(_ event: TrackerEvent) {
        if queue.count >= maxSize { queue.removeFirst() }
        queue.append(event)
    }

    func flush() -> [TrackerEvent] {
        let pending = queue
        queue = []
        return pending
    }

    var isEmpty: Bool { queue.isEmpty }
}
