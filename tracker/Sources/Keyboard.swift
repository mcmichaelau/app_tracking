import Cocoa
import CoreGraphics

func flushTypingBuffer() {
    ScrollWheelCoalescer.shared.flushIfPending(reason: "typing_buffer")
    let state = TrackerState.shared
    state.typingFlushTimer?.invalidate()
    state.typingFlushTimer = nil
    guard !state.typingBuffer.isEmpty else { return }
    log("TYPING", state.typingBuffer.joined())
    state.typingBuffer.removeAll()
}

private func scheduleTypingFlush() {
    let state = TrackerState.shared
    state.typingFlushTimer?.invalidate()
    state.typingFlushTimer = Timer.scheduledTimer(withTimeInterval: state.typingTimeout, repeats: false) { _ in
        flushTypingBuffer()
    }
}

func handleKeyDown(_ event: CGEvent) -> Bool {
    let state = TrackerState.shared
    let flags = event.flags
    let keycode = event.getIntegerValueField(.keyboardEventKeycode)

    let hasCmd = flags.contains(.maskCommand)
    let hasCtrl = flags.contains(.maskControl)
    let hasAlt = flags.contains(.maskAlternate)

    if let nsEvent = NSEvent(cgEvent: event) {
        if hasCmd || hasCtrl || hasAlt {
            flushTypingBuffer()

            var mods: [String] = []
            if hasCmd { mods.append("Cmd") }
            if hasCtrl { mods.append("Ctrl") }
            if hasAlt { mods.append("Alt") }

            let key = nsEvent.charactersIgnoringModifiers?.lowercased() ?? keycodeToString(keycode)

            if hasCmd && key == "c" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    let content = getClipboardContent()
                    log("COPY", content)
                }
                return false
            }
            if hasCmd && key == "v" {
                let content = getClipboardContent()
                log("PASTE", content)
                return false
            }

            log("SHORTCUT", "\(mods.joined(separator: "+"))+\(key)")
            return false
        }

        let specialKeys: [Int64: String] = [
            36: "↵", 48: "⇥", 51: "⌫", 53: "⎋", 117: "⌦",
            123: "←", 124: "→", 125: "↓", 126: "↑",
            115: "↖", 119: "↘", 116: "⇞", 121: "⇟"
        ]

        if let special = specialKeys[keycode] {
            if keycode == 51 {
                if !state.typingBuffer.isEmpty {
                    state.typingBuffer.removeLast()
                }
            } else if keycode == 36 {
                flushTypingBuffer()
                log("KEY", "↵")
            } else {
                flushTypingBuffer()
                log("KEY", special)
            }
            return false
        }

        if let chars = nsEvent.characters, !chars.isEmpty {
            state.typingBuffer.append(chars)
            scheduleTypingFlush()
        }
    }
    return false
}

func keycodeToString(_ keycode: Int64) -> String {
    let map: [Int64: String] = [
        0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x",
        8: "c", 9: "v", 11: "b", 12: "q", 13: "w", 14: "e", 15: "r",
        16: "y", 17: "t", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6",
        23: "5", 24: "=", 25: "9", 26: "7", 27: "-", 28: "8", 29: "0",
        30: "]", 31: "o", 32: "u", 33: "[", 34: "i", 35: "p",
        37: "l", 38: "j", 39: "'", 40: "k", 41: ";", 42: "\\", 43: ",",
        44: "/", 45: "n", 46: "m", 47: ".", 49: "space", 50: "`"
    ]
    return map[keycode] ?? "[\(keycode)]"
}
