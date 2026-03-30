import AppKit
import CoreGraphics
import Foundation

/// Buffers scroll wheel events until **~10s** after the last wheel tick **or** until interrupted (mouse click,
/// typing flush). Deltas are **summed** across the session; phases / PID / `targetApp` reflect the **last** tick.
final class ScrollWheelCoalescer {
    static let shared = ScrollWheelCoalescer()

    private var deltaAxis1: Int64 = 0
    private var deltaAxis2: Int64 = 0
    private var deltaAxis3: Int64 = 0
    private var pointDeltaAxis1: Int64 = 0
    private var pointDeltaAxis2: Int64 = 0
    private var pointDeltaAxis3: Int64 = 0
    private var continuous: Bool = false
    private var lastScrollPhase: Int64 = 0
    private var lastMomentumPhase: Int64 = 0
    private var lastLocation: CGPoint = .zero
    private var lastTargetPID: Int64 = 0

    private var idleWork: DispatchWorkItem?
    /// Fires this long after the **last** scroll tick if nothing interrupts.
    private let idleInterval: TimeInterval = 10.0

    private init() {}

    func ingest(_ event: CGEvent) {
        deltaAxis1 += event.getIntegerValueField(.scrollWheelEventDeltaAxis1)
        deltaAxis2 += event.getIntegerValueField(.scrollWheelEventDeltaAxis2)
        deltaAxis3 += event.getIntegerValueField(.scrollWheelEventDeltaAxis3)
        pointDeltaAxis1 += event.getIntegerValueField(.scrollWheelEventPointDeltaAxis1)
        pointDeltaAxis2 += event.getIntegerValueField(.scrollWheelEventPointDeltaAxis2)
        pointDeltaAxis3 += event.getIntegerValueField(.scrollWheelEventPointDeltaAxis3)
        continuous = event.getIntegerValueField(.scrollWheelEventIsContinuous) != 0
        lastScrollPhase = event.getIntegerValueField(.scrollWheelEventScrollPhase)
        lastMomentumPhase = event.getIntegerValueField(.scrollWheelEventMomentumPhase)
        lastLocation = event.location
        lastTargetPID = event.getIntegerValueField(.eventTargetUnixProcessID)

        scheduleIdleFlush()
    }

    private func scheduleIdleFlush() {
        idleWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.idleWork = nil
            self.flushPendingSession()
        }
        idleWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + idleInterval, execute: work)
    }

    /// Call before emitting a click, typing flush, etc. No-op if nothing pending.
    func flushIfPending(reason _: String) {
        idleWork?.cancel()
        idleWork = nil
        flushPendingSession()
    }

    private func flushPendingSession() {
        guard hasPendingScroll else { return }
        emitScroll()
        resetAccumulators()
    }

    private var hasPendingScroll: Bool {
        deltaAxis1 != 0 || deltaAxis2 != 0 || deltaAxis3 != 0 || pointDeltaAxis1 != 0 || pointDeltaAxis2 != 0
            || pointDeltaAxis3 != 0
    }

    private func resetAccumulators() {
        deltaAxis1 = 0
        deltaAxis2 = 0
        deltaAxis3 = 0
        pointDeltaAxis1 = 0
        pointDeltaAxis2 = 0
        pointDeltaAxis3 = 0
    }

    private func emitScroll() {
        let pid = lastTargetPID
        let targetApp: String?
        if pid > 0, pid <= Int64(pid_t.max), let p = pid_t(exactly: pid) {
            targetApp = NSRunningApplication(processIdentifier: p)?.localizedName
        } else {
            targetApp = nil
        }

        var motion: [String: Any] = [
            "deltaAxis1": deltaAxis1,
            "deltaAxis2": deltaAxis2,
            "deltaAxis3": deltaAxis3,
            "pointDeltaAxis1": pointDeltaAxis1,
            "pointDeltaAxis2": pointDeltaAxis2,
            "pointDeltaAxis3": pointDeltaAxis3,
            "continuous": continuous,
            "scrollPhase": lastScrollPhase,
            "momentumPhase": lastMomentumPhase,
            "targetPID": lastTargetPID,
        ]
        if let ta = targetApp {
            motion["targetApp"] = ta
        }

        let (detail, display) = getScrollLogPayload(at: lastLocation, motion: motion)
        logScrollSession(detail: detail, display: display)
    }
}
