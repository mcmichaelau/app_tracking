import Cocoa

func getClipboardContent() -> String {
    let pasteboard = NSPasteboard.general
    if let content = pasteboard.string(forType: .string) {
        let cleaned = content.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        if cleaned.count > 100 {
            return String(cleaned.prefix(100)) + "..."
        }
        return cleaned
    }
    return "(empty)"
}
