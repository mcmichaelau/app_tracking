import ApplicationServices
import CoreGraphics
import Foundation

// MARK: - Click tracking overview
//
// When a click is detected, getClickData(at:) builds a ClickData struct with
// three layers of context:
//
//   target   — the element that was clicked
//   siblings — other items in the same container (for list/menu/toolbar context)
//   context  — ancestor hierarchy up to the nearest window/dialog/webarea
//
// Element lookup
//   AXUIElementCopyElementAtPosition finds the AX element at the click coordinates.
//   If the system-wide query fails (e.g. in sandboxed apps), we fall back to
//   iterating visible CGWindows and querying each app's AX tree directly.
//
// Field extraction (extractSemanticFields)
//   For each element we read: role, subrole, title, description, value,
//   url, document, help, identifier. Identifiers containing "." are dropped
//   (internal framework paths like "Mail.messageList.cell") — only simple
//   developer IDs like "action-button-1" are kept.
//
// Role-aware label priority (roleAttrPriority)
//   Different element types have a different "best" attribute for a human label:
//     AXButton      → AXDescription, AXTitle
//     AXTextField   → AXDescription, AXPlaceholderValue, AXTitle
//     AXStaticText  → AXValue, AXTitle
//     AXMenuItem    → AXTitle, AXDescription
//     (others)      → AXTitle, AXDescription, AXValue
//
// Fallback labeling
//   If the clicked element has no label, we try in order:
//     1. Flatten text from up to 3 levels of children
//     2. Walk up to 12 ancestor levels looking for a title/description/url
//
// Sibling extraction (extractSiblings)
//   Walks up the ancestor chain (up to 12 levels, stopping at context
//   boundaries). At each level, summarizes up to 30 siblings. Blank container
//   elements are summarized by joining their children's text with " · ".
//   Stops once 5+ labeled items have been collected.
//
// Context / ancestor hierarchy
//   Walks up to 12 parent levels collecting semantic fields, skipping
//   AXApplication (app is already on the event). Stops at boundary roles:
//   AXWindow, AXDialog, AXSheet, AXPopover, AXWebArea, AXToolbar, AXMenu.
//   Duplicate values are suppressed so each piece of info appears once.
//
// Output schema (stored as JSON in the `detail` column)
//   {
//     "target":   { "role": "AXButton", "label": "Send", "description": "..." },
//     "siblings": [ { "title": "Reply" }, { "title": "Forward" } ],
//     "context":  [ { "role": "AXWebArea", "url": "https://..." }, ... ]
//   }
//   `target` is omitted when AX resolves to a blank generic container (e.g. bare AXGroup)
//   after walking the tree for a real label.
//   toDisplayString() returns a short human-readable summary:
//   "<label> — <first context title/url>"

// MARK: - Debug logging

private func getAllAttributes(_ el: AXUIElement) -> [String: String] {
    var attrNames: CFArray?
    guard AXUIElementCopyAttributeNames(el, &attrNames) == .success,
          let names = attrNames as? [String] else {
        return [:]
    }
    
    var result: [String: String] = [:]
    for name in names {
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success {
            result[name] = describeValue(value)
        } else {
            result[name] = "<error reading>"
        }
    }
    return result
}

private func getParameterizedAttributeNames(_ el: AXUIElement) -> [String] {
    var attrNames: CFArray?
    guard AXUIElementCopyParameterizedAttributeNames(el, &attrNames) == .success,
          let names = attrNames as? [String] else {
        return []
    }
    return names
}

private func getActionNames(_ el: AXUIElement) -> [String] {
    var actionNames: CFArray?
    guard AXUIElementCopyActionNames(el, &actionNames) == .success,
          let names = actionNames as? [String] else {
        return []
    }
    return names
}

private func getActionDescription(_ el: AXUIElement, action: String) -> String? {
    var desc: CFString?
    guard AXUIElementCopyActionDescription(el, action as CFString, &desc) == .success else {
        return nil
    }
    return desc as String?
}

private func dumpElement(_ el: AXUIElement) -> String {
    var output = ""
    
    // Regular attributes
    output += "  [Attributes]\n"
    let attrs = getAllAttributes(el)
    for (key, value) in attrs.sorted(by: { $0.key < $1.key }) {
        output += "    \(key): \(value)\n"
    }
    
    // Actions
    let actions = getActionNames(el)
    if !actions.isEmpty {
        output += "  [Actions]\n"
        for action in actions {
            let desc = getActionDescription(el, action: action) ?? ""
            output += "    \(action): \(desc)\n"
        }
    }
    
    // Parameterized attributes (just list names, can't read without params)
    let paramAttrs = getParameterizedAttributeNames(el)
    if !paramAttrs.isEmpty {
        output += "  [Parameterized Attributes (names only, require params to read)]\n"
        for attr in paramAttrs {
            output += "    \(attr)\n"
        }
    }
    
    // PID
    var pid: pid_t = 0
    if AXUIElementGetPid(el, &pid) == .success {
        output += "  [PID]: \(pid)\n"
    }
    
    return output
}

private func describeValue(_ value: CFTypeRef?) -> String {
    guard let value = value else { return "<nil>" }
    
    if let str = value as? String {
        return str.count > 200 ? String(str.prefix(200)) + "..." : str
    }
    if let num = value as? NSNumber {
        return num.stringValue
    }
    if let arr = value as? [Any] {
        return "[\(arr.count) items]"
    }
    if let url = value as? URL {
        return url.absoluteString
    }
    if CFGetTypeID(value) == AXValueGetTypeID() {
        let axValue = value as! AXValue
        var point = CGPoint.zero
        var size = CGSize.zero
        var rect = CGRect.zero
        if AXValueGetValue(axValue, .cgPoint, &point) {
            return "CGPoint(\(point.x), \(point.y))"
        }
        if AXValueGetValue(axValue, .cgSize, &size) {
            return "CGSize(\(size.width), \(size.height))"
        }
        if AXValueGetValue(axValue, .cgRect, &rect) {
            return "CGRect(\(rect.origin.x), \(rect.origin.y), \(rect.width), \(rect.height))"
        }
        return "<AXValue>"
    }
    if CFGetTypeID(value) == AXUIElementGetTypeID() {
        return "<AXUIElement>"
    }
    
    return String(describing: value)
}

func dumpClickHierarchy(at point: CGPoint) {
    let systemWide = AXUIElementCreateSystemWide()
    var element: AXUIElement?
    var err = AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &element)
    
    if err != .success {
        let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        for window in windowList {
            guard let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = bounds["X"], let y = bounds["Y"],
                  let w = bounds["Width"], let h = bounds["Height"],
                  let ownerPID = window[kCGWindowOwnerPID as String] as? pid_t else { continue }
            if CGRect(x: x, y: y, width: w, height: h).contains(point) {
                let appEl = AXUIElementCreateApplication(ownerPID)
                err = AXUIElementCopyElementAtPosition(appEl, Float(point.x), Float(point.y), &element)
                if err == .success { break }
            }
        }
    }
    
    guard err == .success, let el = element else {
        writeDebugLog("No element found at point \(point)\n")
        return
    }
    
    var output = ""
    output += "=== CLICK DEBUG at \(Date()) ===\n"
    output += "Click position: (\(point.x), \(point.y))\n\n"
    
    output += "--- LEVEL 0: Clicked Element ---\n"
    output += dumpElement(el)
    output += "\n"
    
    var current = el
    for level in 1...12 {
        var parentRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentRef) == .success,
              let parent = parentRef else {
            output += "--- LEVEL \(level): No more parents ---\n\n"
            break
        }
        let parentEl = parent as! AXUIElement
        output += "--- LEVEL \(level): Parent ---\n"
        output += dumpElement(parentEl)
        output += "\n"
        current = parentEl
    }
    
    output += "=== END CLICK DEBUG ===\n\n"
    writeDebugLog(output)
}

private func writeDebugLog(_ text: String) {
    let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
    let path = "\(homeDir)/app_tracking/click_debug.log"
    let fileURL = URL(fileURLWithPath: path)
    
    // Ensure file exists (FileHandle throws if it doesn't)
    if !FileManager.default.fileExists(atPath: path) {
        FileManager.default.createFile(atPath: path, contents: nil, attributes: nil)
    }
    
    if let handle = try? FileHandle(forWritingTo: fileURL) {
        handle.seekToEndOfFile()
        if let data = text.data(using: .utf8) {
            handle.write(data)
        }
        try? handle.close()
    }
}

// MARK: - Attribute helpers

func getAttr(_ el: AXUIElement, _ attr: CFString) -> String? {
    var value: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, attr, &value) == .success,
       let str = value as? String, !str.isEmpty {
        return str
    }
    return nil
}

func getElementBounds(_ el: AXUIElement) -> CGRect? {
    var posValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posValue) == .success,
          AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeValue) == .success else {
        return nil
    }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(posValue as! AXValue, .cgPoint, &position),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else {
        return nil
    }
    return CGRect(origin: position, size: size)
}

// MARK: - Role-aware attribute priority

private let kAXPlaceholderValueAttribute = "AXPlaceholderValue" as CFString

private let roleAttrPriority: [String: [CFString]] = [
    "AXButton":      [kAXDescriptionAttribute as CFString, kAXTitleAttribute as CFString],
    "AXDockItem":    [kAXTitleAttribute as CFString],
    "AXMenuItem":    [kAXTitleAttribute as CFString, kAXDescriptionAttribute as CFString],
    "AXTextField":   [kAXDescriptionAttribute as CFString, kAXPlaceholderValueAttribute, kAXTitleAttribute as CFString],
    "AXTextArea":    [kAXDescriptionAttribute as CFString, kAXTitleAttribute as CFString],
    "AXStaticText":  [kAXValueAttribute as CFString, kAXTitleAttribute as CFString],
    "AXLink":        [kAXTitleAttribute as CFString, kAXDescriptionAttribute as CFString],
    "AXCheckBox":    [kAXTitleAttribute as CFString, kAXDescriptionAttribute as CFString],
    "AXRadioButton": [kAXTitleAttribute as CFString, kAXDescriptionAttribute as CFString],
    "AXTab":         [kAXTitleAttribute as CFString, kAXDescriptionAttribute as CFString],
]

private let defaultAttrPriority: [CFString] = [
    kAXTitleAttribute as CFString,
    kAXDescriptionAttribute as CFString,
    kAXValueAttribute as CFString,
]

private let genericRoles: Set<String> = [
    "AXScrollArea", "AXWebArea", "AXGroup", "AXLayoutArea",
    "AXLayoutItem", "AXSplitGroup", "AXList", "AXApplication",
]

private func labelForElement(_ el: AXUIElement) -> String? {
    let role = getAttr(el, kAXRoleAttribute as CFString) ?? ""
    let attrs = roleAttrPriority[role] ?? defaultAttrPriority
    for attr in attrs {
        if let v = getAttr(el, attr), v.count < 100 {
            return v
        }
    }
    return nil
}

// MARK: - Parent context traversal (up to 12 levels)

private func findParentContext(_ el: AXUIElement) -> String? {
    var current = el
    for _ in 0..<12 {
        var parentRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentRef) == .success,
              let parent = parentRef else { break }
        let parentEl = parent as! AXUIElement
        if let title = getAttr(parentEl, kAXTitleAttribute as CFString), title.count < 120 {
            return title
        }
        if let url = getAttr(parentEl, "AXURL" as CFString), url.count < 120 {
            return url
        }
        current = parentEl
    }
    return nil
}

// MARK: - Structured click data

public struct ClickData {
    public var target: [String: String]      // what was clicked, with a human-readable label
    public var siblings: [[String: String]]  // other items in the same container
    public var context: [[String: String]]   // ancestor hierarchy (where in the UI)

    public func toJSON() -> String {
        var dict: [String: Any] = [:]
        if !target.isEmpty {
            dict["target"] = target
        }
        if !siblings.isEmpty {
            dict["siblings"] = siblings
        }
        if !context.isEmpty {
            dict["context"] = context
        }
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return json
    }

    public func toDisplayString() -> String {
        let fromTarget = target["label"] ?? target["title"] ?? target["description"] ?? target["value"]
        let label: String
        if let t = fromTarget, isMeaningfulString(t) {
            label = t
        } else if let c = context.first,
                  let cl = c["title"] ?? c["description"] ?? c["url"], isMeaningfulString(cl) {
            label = cl
        } else if let s = siblings.first {
            label = s["title"] ?? s["value"] ?? s["help"] ?? s["description"] ?? target["role"] ?? "click"
        } else {
            label = target["role"] ?? "click"
        }
        if let firstContext = context.first,
           let contextLabel = firstContext["title"] ?? firstContext["description"] ?? firstContext["url"],
           isMeaningfulString(contextLabel), contextLabel != label {
            return "\(label) — \(contextLabel)"
        }
        return label
    }
}

private func extractSemanticFields(_ el: AXUIElement) -> [String: String] {
    var fields: [String: String] = [:]
    
    if let role = getAttr(el, kAXRoleAttribute as CFString) {
        fields["role"] = role
    }
    if let subrole = getAttr(el, kAXSubroleAttribute as CFString) {
        fields["subrole"] = subrole
    }
    if let title = getAttr(el, kAXTitleAttribute as CFString) {
        fields["title"] = title
    }
    if let desc = getAttr(el, kAXDescriptionAttribute as CFString) {
        fields["description"] = desc
    }
    if let value = getAttr(el, kAXValueAttribute as CFString) {
        fields["value"] = value
    }
    if let url = getAttr(el, "AXURL" as CFString) {
        fields["url"] = url
    }
    if let doc = getAttr(el, "AXDocument" as CFString) {
        fields["document"] = doc
    }
    if let help = getAttr(el, kAXHelpAttribute as CFString) {
        fields["help"] = help
    }
    // Drop identifiers that contain "." (internal paths like Mail.messageList.cell.view.addressLabel)
    // Keep simple identifiers like "action-button-1"
    if let identifier = getAttr(el, "AXIdentifier" as CFString),
       !identifier.hasPrefix("_NS:"),
       !identifier.contains(".") {
        fields["identifier"] = identifier
    }
    
    return fields
}

/// True if there is user-facing text worth recording (whitespace-only does not count).
private func isMeaningfulString(_ s: String) -> Bool {
    !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

private func hasSemanticContent(_ fields: [String: String]) -> Bool {
    // identifier is not considered semantic content (it's a developer ID, not user-facing)
    let semanticKeys: Set<String> = ["title", "description", "value", "url", "document", "help"]
    for key in fields.keys where semanticKeys.contains(key) {
        if let v = fields[key], isMeaningfulString(v) { return true }
    }
    return false
}

// MARK: - Child content extraction

private func getChildren(_ el: AXUIElement) -> [AXUIElement] {
    var childrenRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &childrenRef) == .success,
          let children = childrenRef as? [AXUIElement] else {
        return []
    }
    return children
}

private func extractChildContent(_ el: AXUIElement, depth: Int = 0, maxDepth: Int = 3) -> [[String: String]] {
    guard depth < maxDepth else { return [] }
    
    var results: [[String: String]] = []
    let children = getChildren(el)
    
    for child in children {
        let fields = extractSemanticFields(child)
        if hasSemanticContent(fields) {
            results.append(fields)
        }
        results.append(contentsOf: extractChildContent(child, depth: depth + 1, maxDepth: maxDepth))
    }
    
    return results
}

private let contextBoundaryRoles: Set<String> = [
    "AXWindow", "AXApplication", "AXDialog", "AXPopover", "AXSheet",
    "AXMenuBarItem", "AXWebArea", "AXToolbar", "AXMenu"
]

private let siblingContainerRoles: Set<String> = [
    "AXCell", "AXRow", "AXTableRow", "AXGroup", "AXListItem", "AXOutlineRow"
]

private func getParent(_ el: AXUIElement) -> AXUIElement? {
    var parentRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXParentAttribute as CFString, &parentRef) == .success else {
        return nil
    }
    return (parentRef as! AXUIElement)
}

// Summarize any element: use its own semantic fields, or fall back to its children's text.
// Used to label sibling items that may themselves be blank containers (e.g. Slack row AXGroups).
private func summarizeElement(_ el: AXUIElement) -> [String: String]? {
    let fields = extractSemanticFields(el)
    if hasSemanticContent(fields) { return fields }
    // Blank container — flatten children text into a single summary value
    let childTexts = extractChildContent(el, depth: 0, maxDepth: 4)
        .compactMap { $0["value"] ?? $0["title"] ?? $0["description"] }
    guard !childTexts.isEmpty else { return nil }
    return ["value": childTexts.prefix(4).joined(separator: " · ")]
}

// Walk up the ancestor chain collecting siblings at each level until we have enough
// valuable context. At each level, summarize siblings and pick up short section labels.
// Stops at context boundaries or when we have sufficient labeled items.
private func extractSiblings(_ el: AXUIElement) -> [[String: String]] {
    var results: [[String: String]] = []
    var seenValues: Set<String> = []
    var current = el

    for _ in 0..<12 {
        guard let parent = getParent(current) else { break }
        let parentRole = getAttr(parent, kAXRoleAttribute as CFString) ?? ""
        if contextBoundaryRoles.contains(parentRole) { break }

        for child in getChildren(parent).prefix(30) {
            guard let summary = summarizeElement(child) else { continue }
            let key = summary["value"] ?? summary["title"] ?? summary["description"] ?? ""
            guard !key.isEmpty && !seenValues.contains(key) else { continue }
            seenValues.insert(key)
            results.append(summary)
        }

        current = parent

        // Stop once we have enough labeled context
        if results.count >= 5 { break }
    }

    return results
}

public func getClickData(at point: CGPoint) -> ClickData? {
    let systemWide = AXUIElementCreateSystemWide()
    var element: AXUIElement?
    var err = AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &element)

    if err != .success {
        let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        for window in windowList {
            guard let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = bounds["X"], let y = bounds["Y"],
                  let w = bounds["Width"], let h = bounds["Height"],
                  let ownerPID = window[kCGWindowOwnerPID as String] as? pid_t else { continue }
            if CGRect(x: x, y: y, width: w, height: h).contains(point) {
                let appEl = AXUIElementCreateApplication(ownerPID)
                err = AXUIElementCopyElementAtPosition(appEl, Float(point.x), Float(point.y), &element)
                if err == .success { break }
            }
        }
    }

    guard err == .success, let el = element else { return nil }

    var targetFields = extractSemanticFields(el)
    
    let role = targetFields["role"] ?? ""
    let attrs = roleAttrPriority[role] ?? defaultAttrPriority
    for attr in attrs {
        if let v = getAttr(el, attr), v.count < 100 {
            targetFields["label"] = v
            break
        }
    }
    
    // Drop label if it equals value (redundant)
    if let label = targetFields["label"], let value = targetFields["value"], label == value {
        targetFields.removeValue(forKey: "label")
    }
    
    // Noise strings from UI frameworks that aren't meaningful to an LLM
    let noiseStrings: Set<String> = [
        "Activity item actions", "Save for later", "More actions", "Mark as read",
        "You:", "Active, notifications snoozed", "Away, notifications snoozed",
    ]

    let cleanFields: ([[String: String]]) -> [[String: String]] = { items in
        items.map { item in
            var cleaned = item
            cleaned.removeValue(forKey: "role")
            cleaned.removeValue(forKey: "subrole")
            if let val = cleaned["value"], let desc = cleaned["description"], val == desc {
                cleaned.removeValue(forKey: "value")
            }
            return cleaned
        }.filter { !$0.isEmpty }
    }

    let siblingsContent = cleanFields(extractSiblings(el))

    // If target has no label, try summarizing the hit element, then children, then walk ancestors
    if targetFields["label"] == nil && !hasSemanticContent(targetFields) {
        if let summary = summarizeElement(el) {
            let v = summary["value"] ?? summary["title"] ?? summary["description"] ?? ""
            if isMeaningfulString(v) {
                targetFields["label"] = v
            }
        }
    }

    if targetFields["label"] == nil && !hasSemanticContent(targetFields) {
        // 1. Try children (deeper than summarizeElement for stubborn nested layouts)
        let childTexts = extractChildContent(el, depth: 0, maxDepth: 5)
            .compactMap { $0["value"] ?? $0["title"] ?? $0["description"] }
            .filter { text in
                let trimmed = text.trimmingCharacters(in: .whitespaces)
                return isMeaningfulString(trimmed) && !noiseStrings.contains(trimmed)
            }
            .prefix(4)
        if !childTexts.isEmpty {
            targetFields["label"] = childTexts.joined(separator: " · ")
        } else {
            // 2. Walk up the tree: role-aware label, container summaries, then common AX attrs
            var current = el
            for _ in 0..<12 {
                guard let parent = getParent(current) else { break }
                let parentRole = getAttr(parent, kAXRoleAttribute as CFString) ?? ""
                if parentRole == "AXApplication" {
                    current = parent
                    continue
                }
                if let lab = labelForElement(parent), isMeaningfulString(lab) {
                    targetFields["label"] = lab
                    break
                }
                if let summary = summarizeElement(parent) {
                    let v = summary["value"] ?? summary["title"] ?? summary["description"] ?? ""
                    if isMeaningfulString(v) {
                        targetFields["label"] = v
                        break
                    }
                }
                let parentFields = extractSemanticFields(parent)
                if let title = parentFields["title"], isMeaningfulString(title) {
                    targetFields["label"] = title
                    break
                }
                if let desc = parentFields["description"], isMeaningfulString(desc) {
                    targetFields["label"] = desc
                    break
                }
                if let url = parentFields["url"], isMeaningfulString(url) {
                    targetFields["label"] = url
                    break
                }
                if let help = parentFields["help"], isMeaningfulString(help) {
                    targetFields["label"] = help
                    break
                }
                if let doc = parentFields["document"], isMeaningfulString(doc) {
                    targetFields["label"] = doc
                    break
                }
                current = parent
            }
        }
    }

    // Drop useless targets: only a generic container role with no user-facing fields
    let informativeKeys: Set<String> = ["label", "title", "description", "value", "url", "document", "help", "identifier"]
    let hasInformativeField = informativeKeys.contains { k in targetFields[k].map { isMeaningfulString($0) } ?? false }
    let roleOnly = targetFields["role"].map { genericRoles.contains($0) } ?? false
    if !hasInformativeField && roleOnly {
        targetFields = [:]
    }
    
    var contextNodes: [[String: String]] = []
    var current = el
    var seenContent: Set<String> = []
    
    for _ in 0..<12 {
        var parentRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentRef) == .success,
              let parent = parentRef else { break }
        let parentEl = parent as! AXUIElement
        
        let parentFields = extractSemanticFields(parentEl)
        let parentRole = parentFields["role"] ?? ""
        
        let isContextBoundary = contextBoundaryRoles.contains(parentRole)
        let hasNewContent = hasSemanticContent(parentFields)
        
        // Skip AXApplication - we already have app at the event level
        if parentRole == "AXApplication" {
            current = parentEl
            continue
        }
        
        if isContextBoundary || hasNewContent {
            var filtered = parentFields.filter { key, value in
                let isNew = !seenContent.contains(value)
                if isNew { seenContent.insert(value) }
                return isNew
            }
            
            // Only keep nodes that have semantic content, not just role/subrole/identifier
            let semanticKeys: Set<String> = ["title", "description", "value", "url", "document", "help"]
            let hasSemanticFields = filtered.keys.contains { semanticKeys.contains($0) }
            
            if hasSemanticFields {
                if parentFields["role"] != nil {
                    filtered["role"] = parentFields["role"]
                }
                if parentFields["subrole"] != nil {
                    filtered["subrole"] = parentFields["subrole"]
                }
                contextNodes.append(filtered)
            }
        }
        
        current = parentEl
    }
    
    return ClickData(target: targetFields, siblings: siblingsContent, context: contextNodes)
}

// MARK: - Legacy main entry point (for display string)

func getClickedElement(at point: CGPoint) -> String? {
    guard let clickData = getClickData(at: point) else { return nil }
    return clickData.toDisplayString()
}

// MARK: - Scroll (AX snapshot at cursor after idle)

private func scrollStopJSONString(from dict: [String: Any]) -> String? {
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]) else { return nil }
    return String(data: data, encoding: .utf8)
}

/// After a scroll session ends, snapshot the element under the cursor — same `target` / `siblings` / `context` pipeline as clicks. `motion` aggregates wheel deltas over the session.
public func getScrollLogPayload(at point: CGPoint, motion: [String: Any]) -> (detail: String, display: String) {
    guard let data = getClickData(at: point) else {
        let err: [String: Any] = [
            "kind": "scroll",
            "at": ["x": Double(point.x), "y": Double(point.y)],
            "error": "no_ax_element",
            "motion": motion,
        ]
        let detail = scrollStopJSONString(from: err) ?? "{}"
        return (detail, "scrolled — (no accessibility)")
    }
    var dict: [String: Any] = [
        "kind": "scroll",
        "at": ["x": Double(point.x), "y": Double(point.y)],
        "motion": motion,
    ]
    if !data.target.isEmpty { dict["target"] = data.target }
    if !data.siblings.isEmpty { dict["siblings"] = data.siblings }
    if !data.context.isEmpty { dict["context"] = data.context }
    let detail = scrollStopJSONString(from: dict) ?? data.toJSON()
    return (detail, data.toDisplayString())
}
